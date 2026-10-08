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
from typing import Any, Dict, List, Optional

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
    STATUS_DECLINED,
    STATUS_NOT_STARTED,
    STATUS_PENDING,
    STATUS_RETRY_REQUESTED,
    STATUS_REVIEW_REQUIRED,
    STATUS_STARTED,
    STATUS_VERIFIED,
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


class ReconcilePendingError(IdVerificationError):
    """An ambiguous event could not be confirmed against authenticated
    provider state. Raised before any event row is written, so the provider
    redelivery retries the full path."""

    def __init__(self):
        super().__init__(
            "reconcile_pending",
            "Ambiguous event could not be reconciled with provider state",
        )


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


def _status_payload(attempt: Optional[dict], environment: str, simulated: bool) -> dict:
    if attempt is None:
        return {
            "status": "not_started",
            "attempt": None,
            "environment": environment,
            "simulated": simulated,
            "checks": [],
            "subjectKind": None,
            "onBehalfOfPartyId": None,
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
        # Stored binding — never reconstructed from the read request.
        "subjectKind": attempt.get("subject_kind"),
        "onBehalfOfPartyId": attempt.get("on_behalf_of_party_id"),
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
    on_behalf_of_party_id: Optional[str] = None,
) -> dict:
    """Start or resume a verification attempt for an authorised subject.

    Concurrency: the open-attempt lookup happens inside a row-scoped check;
    on a lost create race the existing attempt is resumed — never a second
    provider applicant.

    State policy: when no open attempt exists, a new cycle may only open
    from RETRYABLE_STATUSES — the same rule retry_attempt enforces. Start
    cannot bypass it (e.g. start-after-verified is refused).
    """
    env = ctx.config.environment
    attempt = await ctx.repository.get_open_attempt(env, ai, transfer_party_id)
    if attempt is not None:
        return await _issue_session(ctx, attempt, resumed=True)

    latest = await ctx.repository.get_latest_attempt(env, ai, transfer_party_id)
    if latest is not None and latest["status"] not in RETRYABLE_STATUSES:
        raise IdVerificationError(
            "not_retryable",
            f"Cannot start a new verification cycle from status {latest['status']}",
        )
    attempt_no = (latest["attempt_no"] + 1) if latest else 1
    external_ref = build_external_ref(env, ai, transfer_party_id)

    # Provider applicant is created/looked up before persistence so the
    # binding exists before we rely on results (per assignment requirement).
    client = ctx.client
    if isinstance(client, SumsubApiClient):
        try:
            applicant = await client.get_applicant_by_external_id(external_ref)
            if applicant is None:
                try:
                    applicant = await client.create_applicant(
                        external_ref, ctx.config.level_name or ""
                    )
                except SumsubClientError as exc:
                    if exc.status not in (400, 409):
                        raise
                    # Ambiguous create — a duplicate/conflict can mean a prior
                    # create committed before its response was lost. Recover
                    # the existing binding rather than reporting failure.
                    applicant = await client.get_applicant_by_external_id(external_ref)
                    if applicant is None:
                        raise
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
        "on_behalf_of_party_id": on_behalf_of_party_id,
        "attempt_no": attempt_no,
        "external_ref": external_ref,
        "provider": "sumsub",
        "provider_applicant_id": applicant_id,
        "level_name": ctx.config.level_name if ctx.config.mode == MODE_SANDBOX else "fixture-passport-liveness",
        "inspection_id": None,
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
    on_behalf_of_party_id: Optional[str] = None,
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
        on_behalf_of_party_id=on_behalf_of_party_id,
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
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            # Provider timestamps are UTC.
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


def _event_inspection_id(event: Dict[str, Any]) -> Optional[str]:
    """Provider review-cycle identifier (inspectionId) — top-level or inside
    reviewResult, whichever the event asserts."""
    insp = event.get("inspectionId")
    if isinstance(insp, str) and insp:
        return insp
    review = event.get("reviewResult") if isinstance(event.get("reviewResult"), dict) else {}
    insp = review.get("inspectionId")
    return insp if isinstance(insp, str) and insp else None


def _attempt_created_ts(attempt: Dict[str, Any]) -> Optional[float]:
    """Our recorded attempt-cycle start — the cutoff an event must not
    predate to belong to this cycle."""
    raw = attempt.get("created_at")
    if isinstance(raw, datetime):
        dt = raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    if isinstance(raw, str):
        try:
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except ValueError:
            return None
    return None


async def _resolve_attempt(
    ctx: VerificationContext, env: str, event: Dict[str, Any]
) -> tuple:
    """Bind an event to its attempt cycle.

    Returns (attempt_or_None, disposition, ambiguous):
      * ``unmatched`` — no attempt owns the asserted external ref/applicant.
      * ``binding_mismatch`` — identifiers resolve but contradict the stored
        binding (applicant id or level). Never applied.
      * ``matched`` — the event belongs to the latest attempt cycle.
      * ``prior_cycle`` — the event's provider time falls inside an older
        attempt's cycle window; applied to that attempt, not the latest.
    ``ambiguous`` marks a resolution that needs provider reconcile before the
    event may apply (missing/out-of-window timestamp or an inspection id
    contradicting a recorded one).
    """
    repo = ctx.repository
    ext = event.get("externalUserId")
    applicant_id = event.get("applicantId")
    ext = ext if isinstance(ext, str) and ext else None
    applicant_id = applicant_id if isinstance(applicant_id, str) and applicant_id else None

    candidates: List[dict] = []
    if ext:
        candidates = await repo.list_attempts_by_external_ref(env, ext)
    if not candidates and applicant_id:
        candidates = await repo.list_attempts_by_applicant_id(env, applicant_id)
        if ext:
            candidates = [a for a in candidates if a.get("external_ref") == ext]
    if not candidates:
        return None, "unmatched", False

    # Applicant cross-check — an external-ref match alone is never authority.
    if applicant_id:
        matches = [a for a in candidates if a.get("provider_applicant_id") == applicant_id]
        if not matches:
            return None, "binding_mismatch", False
        candidates = matches

    # Level binding — only when both sides assert one.
    level = event.get("levelName")
    if isinstance(level, str) and level:
        matches = [a for a in candidates if a.get("level_name") in (None, level)]
        if not matches:
            return None, "binding_mismatch", False
        candidates = matches

    # inspectionId cross-check — applicant-scoped (deprecated in provider
    # docs), so it never selects the owning cycle, but a value contradicting
    # an inspection id recorded on ANY bound attempt is evidence to
    # reconcile before trusting the event.
    inspection = _event_inspection_id(event)
    bound_inspections = {
        a.get("inspection_id") for a in candidates if a.get("inspection_id")
    }
    ambiguous = bool(
        inspection and bound_inspections and inspection not in bound_inspections
    )

    if len(candidates) == 1:
        return candidates[0], "matched", ambiguous

    # Several attempts share this binding (retries reuse the provider
    # applicant). Route by the event's provider createdAtMs against recorded
    # cycle start times — candidates are attempt_no DESC, so candidates[i]'s
    # window ends where candidates[i-1] began. A missing or out-of-window
    # timestamp cannot be routed safely — reconcile on the latest cycle.
    ts = _event_ms(event)
    if ts is None:
        return candidates[0], "matched", True
    owner = None
    for i, cand in enumerate(candidates):
        start = _attempt_created_ts(cand)
        end = _attempt_created_ts(candidates[i - 1]) if i > 0 else None
        if start is None:
            return candidates[0], "matched", True
        if ts >= start and (end is None or ts < end):
            owner = cand
            break
    if owner is None:
        # Predates every recorded cycle — no attempt owns this event.
        return candidates[0], "matched", True
    disposition = "matched" if owner is candidates[0] else "prior_cycle"
    return owner, disposition, ambiguous


# reviewStatus values the provider documents as concluded vs in-progress
# (docs.sumsub.com user-verification webhooks, accessed 2026-10-08). Only a
# FINAL review status may produce a verdict — a GREEN reviewAnswer without
# a final status is a hold/interim answer, never an approval.
_FINAL_REVIEW_STATUSES = frozenset({"completed"})
_IN_PROGRESS_REVIEW_STATUSES = frozenset({
    "init", "pending", "prechecked", "queued", "awaitingUser",
})
_ON_HOLD_REVIEW_STATUSES = frozenset({"onHold"})


async def _reconcile_attempt_status(
    ctx: VerificationContext, attempt: dict, event: Dict[str, Any]
) -> Optional[tuple]:
    """Authenticated provider reconcile for ambiguous events.

    Returns ``(status, summary)`` where summary carries the provider-
    confirmed sanitised review fields — never the ambiguous incoming
    event's. Returns None when nothing safe can be confirmed (missing or
    unrecognised review status, contradictory data), so the event is
    recorded but not applied.
    """
    client = ctx.client
    if not isinstance(client, SumsubApiClient) or not attempt.get("provider_applicant_id"):
        return None
    live = await client.get_applicant_review_status(attempt["provider_applicant_id"])
    inspection = _event_inspection_id(event)
    if inspection and live.inspection_id and live.inspection_id != inspection:
        # Live provider state belongs to a different inspection — the
        # incoming event cannot be trusted for this attempt.
        return None
    summary = {
        "review_answer": live.review_answer,
        "review_reject_type": live.review_reject_type,
        "reject_labels": list(live.reject_labels),
    }
    review_status = (live.review_status or "").strip()
    if review_status in _FINAL_REVIEW_STATUSES:
        answer = live.review_answer
        if answer == "GREEN":
            return STATUS_VERIFIED, summary
        if answer == "RED":
            if live.review_reject_type == "RETRY":
                return STATUS_RETRY_REQUESTED, summary
            if live.review_reject_type == "FINAL":
                return STATUS_DECLINED, summary
            return STATUS_REVIEW_REQUIRED, summary
        # Concluded review with a missing/unrecognised answer — never
        # verified; a reviewer must look at it.
        return STATUS_REVIEW_REQUIRED, summary
    if review_status in _IN_PROGRESS_REVIEW_STATUSES:
        # The review has not concluded — the interim answer is not a
        # verdict. The attempt is still open awaiting the provider.
        return STATUS_PENDING, summary
    if review_status in _ON_HOLD_REVIEW_STATUSES:
        # Held for review/awaiting action — needs a human, not a verdict.
        return STATUS_REVIEW_REQUIRED, summary
    # Missing or unrecognised review status — cannot reconcile.
    return None


async def apply_webhook_event(
    ctx: VerificationContext,
    event: Dict[str, Any],
) -> Dict[str, Any]:
    """Persist + apply one verified provider event, atomically.

    Guarantees: dedupe by composite key (identical redeliveries are
    harmless); environment binding enforced; every asserted identifier
    (external ref, applicant id, level, review-cycle id) must agree with the
    resolved attempt; events that predate the attempt cycle or arrive out of
    order cannot regress it; ambiguous events are reconciled against
    authenticated provider state — never applied on failure; test-mode
    events never apply. Event receipt and state application commit or fail
    together; an unprocessed stored event is resumed by a redelivery.
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
    disposition = "matched"
    ambiguous = False
    if not test_mode:
        attempt, disposition, ambiguous = await _resolve_attempt(ctx, env, event)
    else:
        disposition = "test_mode"

    incoming_ts = _event_ms(event)
    event_row = {
        "id": str(uuid.uuid4()),
        "attempt_id": attempt["id"] if attempt else None,
        "environment": env,
        "dedupe_key": dedupe,
        "event_type": event_type,
        "provider_applicant_id": applicant_id,
        "external_ref": external_ref,
        "correlation_id": event.get("correlationId"),
        "level_name": event.get("levelName"),
        "inspection_id": _event_inspection_id(event),
        "review_status": event.get("reviewStatus"),
        "review_answer": review.get("reviewAnswer"),
        "review_reject_type": review.get("reviewRejectType"),
        "reject_labels": review.get("rejectLabels") or [],
        "provider_created_at_ms": event.get("createdAtMs"),
        "received_at": datetime.now(timezone.utc),
        "processed_at": None,
        "disposition": disposition,
    }

    async def record(mark_processed: bool = True) -> dict:
        return await ctx.repository.apply_event(
            event_row,
            attempt_id=None,
            fields=None,
            incoming_ts=incoming_ts,
            mark_processed=mark_processed,
        )

    if test_mode:
        out = await record()
        if out["outcome"] == "duplicate":
            return {"result": "duplicate", "disposition": "duplicate"}
        return {"result": "test_mode", "disposition": "test_mode"}
    if attempt is None:
        out = await record()
        if out["outcome"] == "duplicate":
            return {"result": "duplicate", "disposition": "duplicate"}
        return {"result": "unmatched", "disposition": disposition}

    # Cycle-cutoff guard: an event that predates this attempt's creation
    # belongs to a previous cycle — recorded, never applied here. Ambiguous
    # resolutions skip this guard: they reconcile first, so an event that
    # predates even the latest cycle is not silently discarded stale.
    created_ts = _attempt_created_ts(attempt)
    if (not ambiguous and incoming_ts is not None and created_ts is not None
            and incoming_ts < created_ts):
        event_row["disposition"] = "previous_cycle"
        out = await record()
        if out["outcome"] == "duplicate":
            return {"result": "duplicate", "disposition": "duplicate"}
        return {"result": "stale_ignored", "disposition": "previous_cycle"}

    requested = map_event_to_status(event)
    if requested is None:
        out = await record()
        if out["outcome"] == "duplicate":
            return {"result": "duplicate", "disposition": "duplicate"}
        return {"result": "unhandled", "disposition": "unhandled"}

    last_ts = _event_ms({"createdAtMs": attempt.get("last_event_created_at_ms")})
    needs_reconcile = ambiguous or incoming_ts is None or (
        last_ts is not None and incoming_ts == last_ts
    )
    fields = {
        "status": requested,
        "last_event_type": event_type,
        "last_correlation_id": event.get("correlationId"),
    }
    # Only a provider-supplied timestamp may advance the ordering watermark —
    # a missing-timestamp event must not erase the last trustworthy one.
    if event.get("createdAtMs") is not None:
        fields["last_event_created_at_ms"] = event.get("createdAtMs")
    summary = sanitised_review_summary(event)
    if summary.get("reviewAnswer") is not None:
        fields["review_answer"] = summary["reviewAnswer"]
    if summary.get("reviewRejectType") is not None:
        fields["review_reject_type"] = summary["reviewRejectType"]
    if summary.get("rejectLabels"):
        fields["reject_labels"] = summary["rejectLabels"]
    if _event_inspection_id(event) and not attempt.get("inspection_id"):
        fields["inspection_id"] = _event_inspection_id(event)

    confirmed = False
    expected_version = None
    if needs_reconcile:
        # Capture the attempt's state version BEFORE the provider call — no
        # row lock is held during the network request; the apply revalidates
        # this version under the lock, so a newer commit that landed while
        # reconciliation was in flight cannot be overwritten by the stale
        # snapshot.
        expected_version = attempt.get("version", 0)
        try:
            reconciled = await _reconcile_attempt_status(ctx, attempt, event)
        except SumsubClientError as exc:
            # Record the delivery unprocessed, then refuse the ack — the
            # provider retries and the event resumes on redelivery.
            await record(mark_processed=False)
            raise ReconcilePendingError() from exc
        if reconciled is None:
            # Reconcile could not confirm the incoming result — record it
            # durably without applying.
            event_row["disposition"] = "ambiguous_not_applied"
            out = await record()
            if out["outcome"] == "duplicate":
                return {"result": "duplicate", "disposition": "duplicate"}
            return {"result": "ambiguous_not_applied", "disposition": "ambiguous_not_applied"}
        reconciled_status, reconciled_summary = reconciled
        fields["status"] = reconciled_status
        # Persist the provider-confirmed summary, not the ambiguous incoming
        # event's — a held/interim answer must not survive as if reviewed.
        fields["review_answer"] = reconciled_summary["review_answer"]
        fields["review_reject_type"] = reconciled_summary["review_reject_type"]
        fields["reject_labels"] = reconciled_summary["reject_labels"]
        confirmed = True

    out = await ctx.repository.apply_event(
        event_row,
        attempt_id=attempt["id"],
        fields=fields,
        incoming_ts=incoming_ts,
        confirmed=confirmed,
        expected_version=expected_version,
    )
    if out["outcome"] == "duplicate":
        return {"result": "duplicate", "disposition": "duplicate"}
    if out["outcome"] == "stale":
        return {"result": "stale_ignored", "disposition": "out_of_order"}
    if out["outcome"] == "ambiguous":
        # A concurrent write reordered under the row lock — recorded, not
        # applied; redelivery reconciles again against fresh state.
        return {"result": "ambiguous_not_applied", "disposition": "ambiguous_not_applied"}
    if out["outcome"] == "conflict":
        # The attempt version moved while the provider lookup was in flight —
        # the reconciled snapshot is stale. The event was left unprocessed,
        # so refusing the ack is safe: redelivery resumes it and reconciles
        # against the now-current state.
        raise ReconcilePendingError()
    return {"result": "applied", "disposition": disposition, "status": fields["status"]}
