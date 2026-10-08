"""ID-verification service — attempt lifecycle and webhook event handling.

Trust boundaries:
  * All identity inputs come from the authorised transfer/party and the
    verified JWT — never from the request body.
  * ``external_ref`` (provider ``externalUserId``) is a server-derived opaque
    sha256 digest scoped by environment + institution + transfer_party.
  * SDK callbacks and browser input can never set a final status: outcomes
    arrive only via the verified webhook (or authenticated status reconcile).
  * Simulated (fixture) results are labelled on every read and can never be
    confused with provider results because ``environment`` differs.
"""

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from clients.sumsub_client import (
    FixtureSumsubClient,
    SumsubApiClient,
    SumsubClientError,
)
from repositories.id_verification import (
    AttemptConflictError,
    InMemoryIdVerificationRepository,
    PostgresIdVerificationRepository,
    StorageUnavailableError,
    event_dedupe_key,
)
from services.id_verification_config import (
    IdVerificationConfig,
    MODE_FIXTURE,
    MODE_SANDBOX,
    config_available,
)
from services.id_verification_mapping import (
    STATUS_NOT_STARTED,
    STATUS_PENDING,
    STATUS_STARTED,
    map_event_to_status,
    performed_check_summary,
    sanitised_review_summary,
)
from repositories.id_verification import OPEN_STATUSES, TERMINAL_STATUSES

# Statuses from which a retry may open a new attempt cycle.
RETRYABLE_STATUSES = ("retry_requested", "declined", "not_started")

WEBHOOK_MAX_BODY_BYTES = 64 * 1024
SUPPORTED_DIGEST_ALGS = {
    "HMAC_SHA256_HEX": "sha256",
    "HMAC_SHA512_HEX": "sha512",
}


class IdVerificationError(Exception):
    def __init__(self, code: str, detail: Optional[str] = None):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail or code


class ConfigurationUnavailableError(IdVerificationError):
    def __init__(self, detail="ID verification is not configured"):
        super().__init__("configuration_unavailable", detail)


class ProviderUnavailableError(IdVerificationError):
    def __init__(self):
        super().__init__("provider_unavailable", "Verification provider unavailable")


def build_external_ref(environment: str, ai: int, transfer_party_id: str) -> str:
    """Opaque server-derived provider externalUserId — deterministic so a
    start can re-find its applicant, scoped by env + institution + subject,
    and irreversible (no raw ids leak to the provider or logs)."""
    digest = hashlib.sha256(
        f"{environment}|{ai}|{transfer_party_id}".encode()
    ).hexdigest()[:24]
    return f"dly-{environment}-{digest}"


class VerificationContext:
    """Resolved per-request dependencies: config + repository + client."""

    def __init__(
        self,
        config: IdVerificationConfig,
        repository: Any,
        client: Any,
    ) -> None:
        self.config = config
        self.repository = repository
        self.client = client


def build_context(
    config: IdVerificationConfig,
    *,
    repository: Optional[Any] = None,
    client: Optional[Any] = None,
) -> VerificationContext:
    """Construct the context for a mode. Sandbox without durable storage or
    full credentials stays configuration-unavailable (fail closed)."""
    if config.mode == MODE_FIXTURE:
        return VerificationContext(
            config,
            repository or InMemoryIdVerificationRepository(),
            client or FixtureSumsubClient(),
        )
    if config.mode == MODE_SANDBOX and config_available(config):
        return VerificationContext(
            config,
            repository or PostgresIdVerificationRepository(),
            client or SumsubApiClient(config),
        )
    raise ConfigurationUnavailableError(
        "ID verification provider is not configured"
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_payload(attempt: Optional[dict], environment: str, simulated: bool) -> dict:
    if attempt is None:
        return {
            "status": "not_started",
            "attempt": None,
            "environment": environment,
            "simulated": simulated,
            "checks": [],
        }
    checks = []
    if attempt.get("status") in TERMINAL_STATUSES or attempt.get("last_event_type"):
        checks = performed_check_summary(
            {"type": attempt.get("last_event_type")}, attempt.get("level_name")
        )
    return {
        "status": attempt["status"],
        "attempt": {
            "attemptNo": attempt["attempt_no"],
            "provider": attempt.get("provider"),
            "levelName": attempt.get("level_name"),
            "reviewAnswer": attempt.get("review_answer"),
            "reviewRejectType": attempt.get("review_reject_type"),
            "rejectLabels": attempt.get("reject_labels") or [],
            "lastEventType": attempt.get("last_event_type"),
            "lastEventAt": attempt.get("last_event_created_at_ms"),
            "updatedAt": attempt.get("updated_at"),
        },
        "environment": environment,
        "simulated": simulated,
        "checks": checks,
    }


async def get_status(ctx: VerificationContext, *, ai: int, transfer_party_id: str) -> dict:
    attempt = await ctx.repository.get_latest_attempt(
        ctx.config.environment, ai, transfer_party_id
    )
    return _status_payload(attempt, ctx.config.environment, ctx.config.mode == MODE_FIXTURE)


async def start_or_resume_session(
    ctx: VerificationContext,
    *,
    ai: int,
    transfer_id: str,
    transfer_party_id: str,
    subject_kind: str,
) -> dict:
    """Start or resume a verification attempt for an authorised subject.

    Concurrency: the open-attempt lookup happens inside a row-scoped check;
    on a lost create race the existing attempt is resumed — never a second
    provider applicant.
    """
    env = ctx.config.environment
    attempt = await ctx.repository.get_open_attempt(env, ai, transfer_party_id)
    if attempt is not None:
        return await _issue_session(ctx, attempt, resumed=True)

    latest = await ctx.repository.get_latest_attempt(env, ai, transfer_party_id)
    attempt_no = (latest["attempt_no"] + 1) if latest else 1
    external_ref = build_external_ref(env, ai, transfer_party_id)

    # Provider applicant is created/looked up before persistence so the
    # binding exists before we rely on results (per assignment requirement).
    client = ctx.client
    if isinstance(client, SumsubApiClient):
        try:
            existing = await client.get_applicant_by_external_id(external_ref)
            applicant = existing or await client.create_applicant(
                external_ref, ctx.config.level_name or ""
            )
        except SumsubClientError:
            raise ProviderUnavailableError()
        applicant_id = applicant.applicant_id
    else:
        applicant = await client.create_applicant(external_ref, "fixture")
        applicant_id = applicant.applicant_id

    new_attempt = {
        "id": str(uuid.uuid4()),
        "environment": env,
        "accountable_institution_id": ai,
        "transfer_id": transfer_id,
        "transfer_party_id": transfer_party_id,
        "subject_kind": subject_kind,
        "attempt_no": attempt_no,
        "external_ref": external_ref,
        "provider": "sumsub",
        "provider_applicant_id": applicant_id,
        "level_name": ctx.config.level_name if ctx.config.mode == MODE_SANDBOX else "fixture-passport-liveness",
        "status": STATUS_STARTED,
        "simulated": ctx.config.mode == MODE_FIXTURE,
    }
    try:
        attempt = await ctx.repository.create_attempt(new_attempt)
    except AttemptConflictError:
        # Concurrent start won the race — resume its attempt, never a second
        # provider applicant.
        attempt = await ctx.repository.get_open_attempt(env, ai, transfer_party_id)
        if attempt is None:
            raise StorageUnavailableError("attempt conflict without open row")
        return await _issue_session(ctx, attempt, resumed=True)
    return await _issue_session(ctx, attempt, resumed=False)


async def _issue_session(ctx: VerificationContext, attempt: dict, *, resumed: bool) -> dict:
    client = ctx.client
    try:
        token = await client.create_sdk_access_token(
            attempt["external_ref"],
            attempt.get("level_name") or "",
            ctx.config.sdk_token_ttl_seconds,
        )
    except SumsubClientError:
        raise ProviderUnavailableError()
    return {
        "mode": ctx.config.mode,
        "environment": ctx.config.environment,
        "simulated": ctx.config.mode == MODE_FIXTURE,
        "resumed": resumed,
        "attemptNo": attempt["attempt_no"],
        "status": attempt["status"],
        "sdkToken": token.token,
        "sdkTokenTtlSeconds": ctx.config.sdk_token_ttl_seconds,
        "levelName": attempt.get("level_name"),
    }


async def refresh_session_token(
    ctx: VerificationContext, *, ai: int, transfer_party_id: str
) -> dict:
    """Renew the short-lived SDK token for the currently open attempt."""
    attempt = await ctx.repository.get_open_attempt(
        ctx.config.environment, ai, transfer_party_id
    )
    if attempt is None:
        raise IdVerificationError("no_open_attempt", "No active verification attempt")
    return await _issue_session(ctx, attempt, resumed=True)


async def retry_attempt(
    ctx: VerificationContext,
    *,
    ai: int,
    transfer_id: str,
    transfer_party_id: str,
    subject_kind: str,
) -> dict:
    """Open a new attempt cycle — only from a retryable terminal state."""
    latest = await ctx.repository.get_latest_attempt(
        ctx.config.environment, ai, transfer_party_id
    )
    if latest is None:
        raise IdVerificationError("no_attempt", "No verification attempt to retry")
    if latest["status"] not in RETRYABLE_STATUSES:
        raise IdVerificationError(
            "not_retryable", f"Cannot retry from status {latest['status']}"
        )
    return await start_or_resume_session(
        ctx,
        ai=ai,
        transfer_id=transfer_id,
        transfer_party_id=transfer_party_id,
        subject_kind=subject_kind,
    )


# --------------------------------------------------------------------------
# Webhook event handling
# --------------------------------------------------------------------------

def verify_webhook_signature(
    raw_body: bytes,
    digest_header: Optional[str],
    alg_header: Optional[str],
    secret: Optional[str],
) -> bool:
    """HMAC over raw bytes, constant-time compare, explicit algorithm list.

    Refuses missing/unsupported algorithms, bad digest encoding and empty
    secrets — never weaker than the configured credential."""
    import hmac as _hmac
    if not secret or not digest_header or not alg_header:
        return False
    hashlib_name = SUPPORTED_DIGEST_ALGS.get(alg_header.strip().upper())
    if hashlib_name is None:
        return False
    provided = digest_header.strip().lower()
    expected_len = 64 if hashlib_name == "sha256" else 128
    if len(provided) != expected_len or not all(
        c in "0123456789abcdef" for c in provided
    ):
        return False
    digestmod = hashlib.sha256 if hashlib_name == "sha256" else hashlib.sha512
    computed = _hmac.new(secret.encode(), raw_body, digestmod).hexdigest()
    return _hmac.compare_digest(computed, provided)


def parse_webhook_event(raw_body: bytes) -> Dict[str, Any]:
    """Parse and structurally validate an event; raises on malformed input."""
    if not raw_body or len(raw_body) > WEBHOOK_MAX_BODY_BYTES:
        raise IdVerificationError("malformed_payload", "Payload missing or oversized")
    try:
        event = json.loads(raw_body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise IdVerificationError("malformed_payload", "Payload is not valid JSON") from exc
    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        raise IdVerificationError("malformed_payload", "Missing event type")
    return event


def _event_ms(event: Dict[str, Any]) -> Optional[float]:
    raw = event.get("createdAtMs")
    if not isinstance(raw, str):
        return None
    try:
        # Format: 'yyyy-MM-dd HH:mm:ss.fff' in UTC.
        return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S.%f").timestamp()
    except ValueError:
        try:
            return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").timestamp()
        except ValueError:
            return None


async def apply_webhook_event(
    ctx: VerificationContext,
    event: Dict[str, Any],
) -> Dict[str, Any]:
    """Persist + apply one verified provider event.

    Guarantees: dedupe by composite key (identical redeliveries are
    harmless), environment binding enforced, unknown external refs recorded
    as unmatched without creating an association, stale events cannot
    regress a newer state, test-mode events never apply.
    """
    env = ctx.config.environment
    event_type = event["type"]
    applicant_id = event.get("applicantId")
    external_ref = event.get("externalUserId")
    review = event.get("reviewResult") if isinstance(event.get("reviewResult"), dict) else {}
    test_mode = event.get("testMode") is True

    # Environment binding: a sandbox event must come from a sandbox attempt.
    event_sandbox = event.get("sandboxMode")
    expected_sandbox = env == "sandbox"
    if isinstance(event_sandbox, bool) and event_sandbox != expected_sandbox:
        raise IdVerificationError("environment_mismatch", "Event environment does not match receiver")

    dedupe = event_dedupe_key(
        env, event_type, applicant_id or "",
        event.get("correlationId"), event.get("reviewStatus"),
        review.get("reviewAnswer"), event.get("createdAtMs"),
    )

    attempt = None
    if external_ref:
        attempt = await ctx.repository.find_attempt_by_external_ref(env, external_ref)
    if attempt is None and applicant_id:
        attempt = await ctx.repository.find_attempt_by_applicant_id(env, applicant_id)

    disposition = "matched"
    if test_mode:
        disposition = "test_mode"
    elif attempt is None:
        disposition = "unmatched"

    event_row = {
        "attempt_id": attempt["id"] if attempt else None,
        "environment": env,
        "dedupe_key": dedupe,
        "event_type": event_type,
        "provider_applicant_id": applicant_id,
        "external_ref": external_ref,
        "correlation_id": event.get("correlationId"),
        "level_name": event.get("levelName"),
        "review_status": event.get("reviewStatus"),
        "review_answer": review.get("reviewAnswer"),
        "review_reject_type": review.get("reviewRejectType"),
        "reject_labels": review.get("rejectLabels") or [],
        "provider_created_at_ms": event.get("createdAtMs"),
        "received_at": _now(),
        "processed_at": _now(),
        "disposition": disposition,
    }
    stored = await ctx.repository.insert_event(event_row)
    if not stored.get("_inserted"):
        return {"result": "duplicate", "disposition": "duplicate"}

    if test_mode:
        return {"result": "test_mode", "disposition": "test_mode"}
    if attempt is None:
        # Unknown applicant reference — never creates a trusted association.
        return {"result": "unmatched", "disposition": "unmatched"}

    requested = map_event_to_status(event)
    if requested is None:
        return {"result": "unhandled", "disposition": "unhandled"}

    # Stale-event guard: an event older than the last applied event cannot
    # regress the attempt; equal timestamps are ambiguous → reconcile state.
    last_ms = attempt.get("last_event_created_at_ms")
    incoming_ms_raw = event.get("createdAtMs")
    last_ts = _event_ms({"createdAtMs": last_ms}) if last_ms else None
    incoming_ts = _event_ms(event)

    if attempt["status"] in TERMINAL_STATUSES and requested not in (
        STATUS_NOT_STARTED,
    ) and incoming_ts is not None and last_ts is not None and incoming_ts < last_ts:
        return {"result": "stale_ignored", "disposition": "out_of_order"}

    if last_ts is not None and incoming_ts is not None and incoming_ts < last_ts:
        return {"result": "stale_ignored", "disposition": "out_of_order"}

    fields = {
        "status": requested,
        "last_event_type": event_type,
        "last_event_created_at_ms": incoming_ms_raw,
        "last_correlation_id": event.get("correlationId"),
    }
    summary = sanitised_review_summary(event)
    if summary.get("reviewAnswer") is not None:
        fields["review_answer"] = summary["reviewAnswer"]
    if summary.get("reviewRejectType") is not None:
        fields["review_reject_type"] = summary["reviewRejectType"]
    if summary.get("rejectLabels"):
        fields["reject_labels"] = summary["rejectLabels"]
    if incoming_ts is not None and last_ts is not None and incoming_ts == last_ts:
        # Ambiguous ordering — in provider modes, reconcile against
        # authenticated state rather than trusting the timestamp alone.
        if isinstance(ctx.client, SumsubApiClient) and attempt.get("provider_applicant_id"):
            try:
                live = await ctx.client.get_applicant_review_status(attempt["provider_applicant_id"])
                reconciled = map_event_to_status({
                    "type": "applicantReviewed",
                    "reviewResult": {
                        "reviewAnswer": live.review_answer,
                        "reviewRejectType": live.review_reject_type,
                    },
                    "reviewStatus": live.review_status,
                })
                if reconciled:
                    fields["status"] = reconciled
            except SumsubClientError:
                pass  # storage stays consistent; provider retry will follow

    await ctx.repository.update_attempt_fields(attempt["id"], fields)
    return {"result": "applied", "disposition": disposition, "status": fields["status"]}
