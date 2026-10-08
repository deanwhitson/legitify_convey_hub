"""Provider → app status mapping for Sumsub webhook events.

Mapping reference (docs.sumsub.com user-verification webhooks +
review statuses, accessed 2026-10-08):

  applicantCreated        -> started
  applicantPending        -> pending
  applicantReviewed GREEN -> verified
  applicantReviewed RED + RETRY -> retry_requested
  applicantReviewed RED + FINAL -> declined
  applicantReviewed RED/other/unknown reviewRejectType -> review_required
  applicantReviewed missing/unrecognised reviewResult -> review_required
  applicantOnHold / applicantAwaitingService /
      applicantWorkflowFailed -> review_required
  applicantReset          -> not_started (opens a new cycle)

An unrecognised or incomplete result can NEVER produce ``verified``.
SDK-side callbacks are flow progress only and are not handled here.
"""

from typing import Any, Dict, Optional

STATUS_NOT_STARTED = "not_started"
STATUS_STARTED = "started"
STATUS_PENDING = "pending"
STATUS_VERIFIED = "verified"
STATUS_RETRY_REQUESTED = "retry_requested"
STATUS_DECLINED = "declined"
STATUS_REVIEW_REQUIRED = "review_required"

ALL_STATUSES = frozenset({
    STATUS_NOT_STARTED, STATUS_STARTED, STATUS_PENDING, STATUS_VERIFIED,
    STATUS_RETRY_REQUESTED, STATUS_DECLINED, STATUS_REVIEW_REQUIRED,
})

# Events that never transition an attempt themselves.
IGNORED_EVENT_TYPES = frozenset({
    "applicantAwaitingUser",        # user must act — still open, stays pending/started
    "applicantWorkflowCompleted",   # workflow-level informational; review comes via reviewed
})


def map_event_to_status(event: Dict[str, Any]) -> Optional[str]:
    """Return the app status a provider event requests, or None when the
    event is informational and must not transition the attempt."""
    etype = event.get("type")
    if etype == "applicantCreated":
        return STATUS_STARTED
    if etype == "applicantPending":
        return STATUS_PENDING
    if etype == "applicantReviewed":
        result = event.get("reviewResult")
        if not isinstance(result, dict):
            return STATUS_REVIEW_REQUIRED
        answer = result.get("reviewAnswer")
        if answer == "GREEN":
            return STATUS_VERIFIED
        if answer == "RED":
            reject_type = result.get("reviewRejectType")
            if reject_type == "RETRY":
                return STATUS_RETRY_REQUESTED
            if reject_type == "FINAL":
                return STATUS_DECLINED
            return STATUS_REVIEW_REQUIRED
        # Unrecognised answer — never verified.
        return STATUS_REVIEW_REQUIRED
    if etype in ("applicantOnHold", "applicantAwaitingService",
                 "applicantWorkflowFailed", "applicantLevelChanged"):
        return STATUS_REVIEW_REQUIRED
    if etype == "applicantReset":
        return STATUS_NOT_STARTED
    if etype in IGNORED_EVENT_TYPES:
        return None
    return None  # unknown type — recorded unhandled, no transition


def sanitised_review_summary(event: Dict[str, Any]) -> Dict[str, Any]:
    """Allowlisted review fields safe to persist/return. Never carries
    comments (clientComment can embed private data), images or payload."""
    result = event.get("reviewResult") if isinstance(event.get("reviewResult"), dict) else {}
    return {
        "reviewAnswer": result.get("reviewAnswer"),
        "reviewRejectType": result.get("reviewRejectType"),
        "rejectLabels": list(result.get("rejectLabels") or []),
        "buttonIds": list(result.get("buttonIds") or []),
        "reviewStatus": event.get("reviewStatus"),
        "levelName": event.get("levelName"),
    }


def performed_check_summary(event: Dict[str, Any], level_name: Optional[str]) -> list:
    """What the event itself evidences — honest performed/unavailable view.

    A configured level is not proof each check ran. Only events the
    provider actually reports count as 'performed'; items the provider did
    not report stay 'not_reported' rather than implied.
    """
    checks = []
    checks.append({
        "check": "provider_review",
        "state": "performed" if event.get("type") == "applicantReviewed" else "not_reported",
    })
    for name in ("document_authenticity", "liveness_face_match", "data_cross_check"):
        checks.append({"check": name, "state": "not_reported"})
    if level_name:
        checks.append({"check": "configured_level", "state": "configured", "detail": level_name})
    return checks
