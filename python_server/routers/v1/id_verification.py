"""Staff-facing ID-verification routes (Sumsub POC).

Mounted under /api/v1/transfers so paths read as:

    GET  /api/v1/transfers/{id}/parties/{transfer_party_id}/id-verification
    POST .../id-verification/session
    POST .../id-verification/refresh
    POST .../id-verification/retry

Authority: every route re-verifies the JWT (BFF forwards it unchanged),
re-checks the transfer + party belong to the caller's verified institution,
and derives identity solely from server-side rows — the request body can
never carry applicant ids, level names or tenant ids.

The subject is always a natural-person transfer_party row. Verifying on
behalf of a company/trust party requires ``onBehalfOfPartyId`` — a company/
trust row on the same transfer; the person stays the passport subject.

Status reads use transfers:read; session/refresh/retry are mutations and
require transfers:write. Clients (role 4) are outside the documented POC
contract and fail closed.
"""

import re
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from auth.current_user import CurrentUser
from auth.dependencies import require_jwt
from db import query
from services.id_verification_config import (
    load_id_verification_config,
    MODE_DISABLED,
    MODE_FIXTURE,
)
from services.id_verification_service import (
    ConfigurationUnavailableError,
    IdVerificationError,
    ProviderUnavailableError,
    StorageUnavailableError,
    build_context,
    get_status,
    refresh_session_token,
    retry_attempt,
    start_or_resume_session,
)

router = APIRouter()

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_SUBJECT_KINDS = ("party", "representative")


def _is_uuid(value: str) -> bool:
    return bool(_UUID_RE.match(value))


def _error(exc: IdVerificationError) -> JSONResponse:
    status = {
        "configuration_unavailable": 503,
        "provider_unavailable": 503,
        "storage_unavailable": 503,
        "no_open_attempt": 409,
        "no_attempt": 404,
        "not_retryable": 409,
        "subject_not_eligible": 422,
        "creation_unresolved": 409,
        "subject_context_conflict": 409,
        "subject_changed": 409,
    }.get(exc.code, 400)
    return JSONResponse(
        status_code=status,
        content={"success": False, "error": exc.code},
    )


async def _resolve_context(request: Request):
    """Per-request context from app.state (test-overridable).

    Fixture mode is always resolvable; sandbox requires full config +
    durable storage, otherwise a safe 503 — never a silent fixture fallback.
    """
    ctx = getattr(request.app.state, "id_verification_context", None)
    if ctx is not None:
        return ctx
    provider = getattr(request.app.state.settings, "idv_provider", "sumsub")
    if provider == "veriff":
        from services.veriff_verification import build_veriff_context
        ctx = build_veriff_context(request.app.state.settings)
        request.app.state.id_verification_context = ctx
        return ctx
    if provider != "sumsub":
        raise ConfigurationUnavailableError()
    config = load_id_verification_config(request.app.state.settings)
    if config.mode == MODE_DISABLED:
        raise ConfigurationUnavailableError()
    if config.mode == MODE_FIXTURE:
        repo = getattr(request.app.state, "id_verification_repository", None)
        if repo is None:
            from repositories.id_verification import InMemoryIdVerificationRepository
            repo = InMemoryIdVerificationRepository()
            request.app.state.id_verification_repository = repo
        client = getattr(request.app.state, "id_verification_client", None)
        ctx = build_context(config, repository=repo, client=client)
    else:
        repo = getattr(request.app.state, "id_verification_repository", None)
        client = getattr(request.app.state, "id_verification_client", None)
        ctx = build_context(config, repository=repo, client=client)
    request.app.state.id_verification_context = ctx
    return ctx


async def _authorize_subject(
    user: CurrentUser,
    transfer_id: str,
    transfer_party_id: str,
    on_behalf_of_party_id: Optional[str],
) -> tuple[str, Optional[dict]]:
    """Return (subject_kind, on_behalf_row) or raise 404/422.

    Confirms the transfer exists in the caller's AI, the subject party is a
    natural person on that transfer, and any on-behalf-of party is a
    company/trust on the same transfer — never an entity-as-passport-holder.
    """
    if not _is_uuid(transfer_id) or not _is_uuid(transfer_party_id):
        raise HTTPException(status_code=404, detail="Not found")

    transfer = await query(
        "SELECT id FROM transfers WHERE id = $1 AND accountable_institution_id = $2",
        [transfer_id, user.accountable_institution_id],
    )
    if not transfer.rows:
        raise HTTPException(status_code=404, detail="Not found")

    subject = await query(
        """SELECT id, entity_type FROM transfer_parties
           WHERE id = $1 AND transfer_id = $2 AND accountable_institution_id = $3""",
        [transfer_party_id, transfer_id, user.accountable_institution_id],
    )
    if not subject.rows:
        raise HTTPException(status_code=404, detail="Not found")
    if subject.rows[0]["entity_type"] != "person":
        raise IdVerificationError(
            "subject_not_eligible",
            "Verification subject must be a natural person",
        )

    if on_behalf_of_party_id is None:
        return "party", None
    if not _is_uuid(on_behalf_of_party_id):
        raise HTTPException(status_code=422, detail="onBehalfOfPartyId must be a UUID")
    target = await query(
        """SELECT id, entity_type FROM transfer_parties
           WHERE id = $1 AND transfer_id = $2 AND accountable_institution_id = $3""",
        [on_behalf_of_party_id, transfer_id, user.accountable_institution_id],
    )
    if not target.rows:
        raise HTTPException(status_code=404, detail="Not found")
    if target.rows[0]["entity_type"] not in ("company", "trust"):
        raise IdVerificationError(
            "subject_not_eligible",
            "onBehalfOfPartyId must reference a company or trust party",
        )
    return "representative", dict(target.rows[0])


def _subject_payload(subject_kind: str, on_behalf: Optional[dict]) -> dict:
    data: dict[str, Any] = {"subjectKind": subject_kind}
    if on_behalf is not None:
        data["onBehalfOfPartyId"] = str(on_behalf["id"])
        data["onBehalfOfEntityType"] = on_behalf["entity_type"]
    return data


@router.get("/{id}/parties/{transfer_party_id}/id-verification")
async def get_id_verification_status(
    id: str,
    transfer_party_id: str,
    request: Request,
    user: CurrentUser = Depends(require_jwt),
):
    if user.is_client or not user.has_ability("transfers:read"):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        ctx = await _resolve_context(request)
    except ConfigurationUnavailableError as exc:
        return _error(exc)
    try:
        subject_kind, on_behalf = await _authorize_subject(
            user, id, transfer_party_id, None
        )
    except IdVerificationError as exc:
        return _error(exc)
    try:
        data = await get_status(
            ctx,
            ai=user.accountable_institution_id,
            transfer_party_id=transfer_party_id,
        )
    except IdVerificationError as exc:
        return _error(exc)
    # The stored attempt binding is authoritative for the subject context;
    # fall back to the request-derived kind only when no attempt exists.
    data["subjectKind"] = data.get("subjectKind") or subject_kind
    if data.get("onBehalfOfPartyId") is None and on_behalf is not None:
        data.update(_subject_payload(subject_kind, on_behalf))
    return {"message": "OK", "data": data}


@router.post("/{id}/parties/{transfer_party_id}/id-verification/session")
async def start_id_verification_session(
    id: str,
    transfer_party_id: str,
    request: Request,
    body: Optional[dict] = None,
    user: CurrentUser = Depends(require_jwt),
):
    if user.is_client or not user.has_ability("transfers:write"):
        raise HTTPException(status_code=403, detail="Forbidden")

    on_behalf_of = None
    if body:
        unexpected = set(body.keys()) - {"onBehalfOfPartyId"}
        if unexpected:
            raise HTTPException(status_code=422, detail="Unexpected field(s)")
        raw = body.get("onBehalfOfPartyId")
        if raw is not None and not isinstance(raw, str):
            raise HTTPException(status_code=422, detail="onBehalfOfPartyId must be a UUID string")
        on_behalf_of = raw

    try:
        ctx = await _resolve_context(request)
        subject_kind, _target = await _authorize_subject(
            user, id, transfer_party_id, on_behalf_of
        )
        session = await start_or_resume_session(
            ctx,
            ai=user.accountable_institution_id,
            transfer_id=id,
            transfer_party_id=transfer_party_id,
            subject_kind=subject_kind,
            on_behalf_of_party_id=on_behalf_of,
        )
    except IdVerificationError as exc:
        return _error(exc)
    session.update(_subject_payload(subject_kind, _target))
    return {"message": "OK", "data": session}


@router.post("/{id}/parties/{transfer_party_id}/id-verification/refresh")
async def refresh_id_verification_token(
    id: str,
    transfer_party_id: str,
    request: Request,
    user: CurrentUser = Depends(require_jwt),
):
    if user.is_client or not user.has_ability("transfers:write"):
        raise HTTPException(status_code=403, detail="Forbidden")
    try:
        ctx = await _resolve_context(request)
        await _authorize_subject(user, id, transfer_party_id, None)
        session = await refresh_session_token(
            ctx, ai=user.accountable_institution_id, transfer_party_id=transfer_party_id
        )
    except IdVerificationError as exc:
        return _error(exc)
    return {"message": "OK", "data": session}


@router.post("/{id}/parties/{transfer_party_id}/id-verification/retry")
async def retry_id_verification(
    id: str,
    transfer_party_id: str,
    request: Request,
    body: Optional[dict] = None,
    user: CurrentUser = Depends(require_jwt),
):
    if user.is_client or not user.has_ability("transfers:write"):
        raise HTTPException(status_code=403, detail="Forbidden")
    on_behalf_of = None
    if body:
        unexpected = set(body.keys()) - {"onBehalfOfPartyId"}
        if unexpected:
            raise HTTPException(status_code=422, detail="Unexpected field(s)")
        on_behalf_of = body.get("onBehalfOfPartyId")
        if on_behalf_of is not None and not isinstance(on_behalf_of, str):
            raise HTTPException(status_code=422, detail="onBehalfOfPartyId must be a UUID string")
    try:
        ctx = await _resolve_context(request)
        subject_kind, _target = await _authorize_subject(
            user, id, transfer_party_id, on_behalf_of
        )
        session = await retry_attempt(
            ctx,
            ai=user.accountable_institution_id,
            transfer_id=id,
            transfer_party_id=transfer_party_id,
            subject_kind=subject_kind,
            on_behalf_of_party_id=on_behalf_of,
        )
    except IdVerificationError as exc:
        return _error(exc)
    session.update(_subject_payload(subject_kind, _target))
    return {"message": "OK", "data": session}
