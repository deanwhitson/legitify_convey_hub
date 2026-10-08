"""Sumsub webhook receiver — the ONLY route exempt from the interactive JWT.

Mounted at /api/v1/webhooks. It never shares the user-JWT dependency:
authentication is HMAC over the raw request bytes using the configured
webhook secret (a separate credential from the API signing secret). Any
parse/verify failure is rejected before the body is trusted; the handler
never reconstructs the signed payload from parsed JSON.

Also carries the fixture-mode simulation receiver — available ONLY in
SUMSUB_MODE=fixture, where it feeds synthetic events through the same
apply path so the offline demo exercises dedupe/ordering/state code.
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from services.id_verification_config import (
    MODE_DISABLED,
    MODE_FIXTURE,
    load_id_verification_config,
)
from services.id_verification_service import (
    IdVerificationError,
    ReconcilePendingError,
    StorageUnavailableError,
    apply_webhook_event,
    build_context,
    parse_webhook_event,
    verify_webhook_signature,
    WEBHOOK_MAX_BODY_BYTES,
)

router = APIRouter()

# The fixture receiver is a local demo boundary: it only answers loopback
# clients so that fixture mode on a reachable host can never become a
# general unauthenticated status injector.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient", "test"}

_DIGEST_HEADER = "x-payload-digest"
_ALG_HEADER = "x-payload-digest-alg"


async def _ctx(request: Request):
    ctx = getattr(request.app.state, "id_verification_context", None)
    if ctx is not None:
        return ctx
    config = load_id_verification_config(request.app.state.settings)
    repo = getattr(request.app.state, "id_verification_repository", None)
    client = getattr(request.app.state, "id_verification_client", None)
    ctx = build_context(config, repository=repo, client=client)
    request.app.state.id_verification_context = ctx
    return ctx


@router.post("/webhooks/sumsub")
async def sumsub_webhook(request: Request):
    """Verified provider event ingest. Exempt from the user JWT — provider
    authentication only. Storage failure → 503 (provider retries); never
    acknowledge before the event is durable."""
    raw = await request.body()
    if not raw or len(raw) > WEBHOOK_MAX_BODY_BYTES:
        raise HTTPException(status_code=400, detail="Malformed payload")

    config = load_id_verification_config(request.app.state.settings)
    if config.mode in (MODE_DISABLED, MODE_FIXTURE) or not config.webhook_secret:
        # Provider webhooks only exist in configured provider modes.
        raise HTTPException(status_code=404, detail="Not found")

    if not verify_webhook_signature(
        raw,
        request.headers.get(_DIGEST_HEADER),
        request.headers.get(_ALG_HEADER),
        config.webhook_secret,
    ):
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        event = parse_webhook_event(raw)
    except IdVerificationError:
        raise HTTPException(status_code=400, detail="Malformed payload")

    ctx = await _ctx(request)
    try:
        outcome = await apply_webhook_event(ctx, event)
    except StorageUnavailableError:
        # Not durable → not acknowledged; Sumsub will retry delivery.
        raise HTTPException(status_code=503, detail="Storage unavailable")
    except ReconcilePendingError:
        # Ambiguous event, recorded unprocessed — do not acknowledge; the
        # provider retries and the event resumes on redelivery.
        raise HTTPException(status_code=503, detail="Reconcile pending")
    except IdVerificationError:
        raise HTTPException(status_code=400, detail="Malformed payload")
    return {"message": "OK", "data": outcome}


@router.post("/webhooks/sumsub-fixture")
async def sumsub_fixture_webhook(request: Request):
    """Fixture-mode event injector — exists ONLY for SUMSUB_MODE=fixture and
    ONLY for loopback clients. It is a local demo boundary, not a provider
    endpoint: a non-local caller gets 404 exactly as in every other mode.

    Lets the offline demo drive synthetic outcomes through the identical
    dedupe/ordering/state path with zero provider traffic."""
    config = load_id_verification_config(request.app.state.settings)
    if config.mode != MODE_FIXTURE:
        raise HTTPException(status_code=404, detail="Not found")
    client_host = request.client.host if request.client else None
    if client_host not in _LOOPBACK_HOSTS:
        raise HTTPException(status_code=404, detail="Not found")

    raw = await request.body()
    try:
        event = parse_webhook_event(raw)
    except IdVerificationError:
        raise HTTPException(status_code=400, detail="Malformed payload")
    if event.get("environment") not in (None, "fixture"):
        raise HTTPException(status_code=400, detail="Malformed payload")
    # Fixture events carry simulated markers through apply so stored rows
    # stay labelled synthetic.
    ctx = await _ctx(request)
    try:
        outcome = await apply_webhook_event(ctx, event)
    except StorageUnavailableError:
        raise HTTPException(status_code=503, detail="Storage unavailable")
    except ReconcilePendingError:
        return {"message": "OK", "data": {"result": "reconcile_unavailable"}}
    return {"message": "OK", "data": outcome}
