"""Veriff implementation behind DEEDLY's existing authorised IDV routes.

Durable reservations precede provider writes. A lost create response remains
unresolved and never triggers an automatic second chargeable session.
"""
import hashlib
import json
import unicodedata
from datetime import date, datetime, timedelta, timezone

from cryptography.fernet import Fernet, InvalidToken

from clients.veriff_client import VeriffClient, VeriffClientError, load_veriff_config
from services.id_verification_service import (ConfigurationUnavailableError,
    IdVerificationError, ProviderUnavailableError)
from repositories.veriff_verification import VeriffRepository


def normalise(value):
    return "".join(c for c in unicodedata.normalize("NFKD", str(value or "")).casefold() if c.isalnum())


def subject_identity(party):
    manual = party.get("party_source") == "manual"
    passport = manual and party.get("manual_id_type") == "passport"
    return {"name": party.get("manual_name") if manual else party.get("cached_name"),
            "passport": party.get("manual_id_number") if passport else None,
            "country": party.get("manual_passport_country") if passport else None}


def fingerprint(party):
    values = {k: normalise(v) for k, v in subject_identity(party).items()}
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def map_decision(data, row, party, *, today=None):
    """Fail closed: code/status, session binding, passport, expiry and subject.

No individual liveness/face-match evidence is fabricated from an aggregate
approval. Provider identity data is compared transiently and not persisted.
"""
    v = data.get("verification")
    if v is None:
        return {"status": "pending", "checks": [], "decisionCode": None, "reasonCode": None}
    if not isinstance(v, dict) or v.get("id") != row["session_id"]:
        raise ProviderUnavailableError()
    # These are our opaque identifiers; missing values also fail closed.
    if v.get("vendorData") != row["external_ref"] or v.get("endUserId") != str(row["id"]):
        raise ProviderUnavailableError()
    code = v.get("code")
    status = {9001: ("approved", "review_required"), 9102: ("declined", "declined"),
              9103: ("resubmission_requested", "retry_requested"),
              9104: ("expired", "retry_requested"), 9121: ("abandoned", "retry_requested")}.get(code if type(code) is int else None)
    mapped = status[1] if status and status[0] == v.get("status") else "review_required"
    doc = v.get("document") if isinstance(v.get("document"), dict) else {}
    is_passport = doc.get("type") == "PASSPORT"
    try:
        sa_today = datetime.now(timezone(timedelta(hours=2))).date()
        valid = date.fromisoformat(doc.get("validUntil", "")) >= (today or sa_today)
    except (ValueError, TypeError):
        valid = False
    person = v.get("person") if isinstance(v.get("person"), dict) else {}
    identity = subject_identity(party)
    actual_name = " ".join(str(person.get(k) or "") for k in ("firstName", "lastName"))
    matched = (bool(normalise(identity["name"])) and bool(normalise(identity["passport"]))
               and bool(normalise(identity["country"]))
               and normalise(identity["name"]) == normalise(actual_name))
    if identity["passport"]:
        matched = matched and normalise(identity["passport"]) == normalise(doc.get("number"))
    if identity["country"]:
        matched = matched and normalise(identity["country"]) == normalise(doc.get("country"))
    changed = fingerprint(party) != row["subject_fingerprint"]
    if changed:
        matched = False
    if code == 9001 and v.get("status") == "approved" and is_passport and valid and matched:
        mapped = "verified"
    checks = [{"check": "passport_document", "state": "passed" if is_passport else "unavailable"},
              {"check": "passport_validity", "state": "passed" if valid else "not_confirmed"},
              {"check": "selected_subject_match", "state": "passed" if matched else "review_required"},
              {"check": "individual_liveness_and_face_match", "state": "unavailable"}]
    reason = v.get("reasonCode")
    # Do not store provider free text (may contain identity data).
    return {"status": mapped, "decisionCode": code if type(code) is int else None,
            "reasonCode": str(reason) if type(reason) is int else None,
            "checks": checks}


class VeriffContext:
    provider = "veriff"

    def __init__(self, config, repository=None, client=None):
        self.config = config
        self.repository = repository or VeriffRepository()
        self.client = client or VeriffClient(config)
        self.cipher = Fernet(config.encryption_key.encode())

    def session_payload(self, row, *, resumed):
        if row["creation_state"] != "ready":
            raise IdVerificationError("creation_unresolved")
        try:
            url = self.cipher.decrypt(row["capture_url_encrypted"].encode()).decode()
        except (InvalidToken, ValueError, AttributeError):
            raise ConfigurationUnavailableError()
        from clients.veriff_client import valid_veriff_url
        if not valid_veriff_url(url):
            raise ProviderUnavailableError()
        return {"provider": "veriff", "mode": self.config.mode, "environment": self.config.mode,
                "simulated": self.config.mode == "test", "resumed": resumed,
                "attemptNo": row["attempt_no"], "status": row["status"],
                "captureUrl": url, "sdkToken": "", "sdkTokenTtlSeconds": 0, "levelName": None,
                "subjectKind": row["subject_kind"], "onBehalfOfPartyId": row["on_behalf_of_party_id"]}

    async def start(self, *, ai, transfer_id, transfer_party_id, subject_kind,
                    on_behalf_of_party_id=None, retry=False):
        row, owned = await self.repository.reserve(self.config.scope, self.config.mode, ai,
            transfer_id, transfer_party_id, subject_kind, on_behalf_of_party_id, retry=retry)
        if not owned:
            return self.session_payload(row, resumed=True)
        # Reservation is committed before this single provider write. Even a
        # process crash leaves a hold rather than a duplicate automatic call.
        try:
            session = await self.client.create_session(row["external_ref"], str(row["id"]))
        except VeriffClientError:
            await self.repository.creation_failed(row["id"])
            raise ProviderUnavailableError()
        row = await self.repository.bind(row["id"], session["id"],
            self.cipher.encrypt(session["url"].encode()).decode())
        return self.session_payload(row, resumed=False)

    async def refresh(self, *, ai, transfer_party_id):
        row, party = await self.repository.latest(self.config.scope, ai, transfer_party_id)
        if not row or row["status"] not in ("started", "pending", "review_required"):
            raise IdVerificationError("no_open_attempt")
        if fingerprint(party) != row["subject_fingerprint"]:
            raise IdVerificationError("subject_changed")
        return self.session_payload(row, resumed=True)

    async def status(self, *, ai, transfer_party_id):
        row, party = await self.repository.latest(self.config.scope, ai, transfer_party_id)
        summary = {"status": "not_started", "attempt": None, "checks": [],
                   "environment": self.config.mode, "simulated": self.config.mode == "test",
                   "provider": "veriff", "subjectKind": None, "onBehalfOfPartyId": None}
        if not row:
            return summary
        if row["creation_state"] != "ready":
            raise IdVerificationError("creation_unresolved")
        # Explicit Refresh status in the existing panel polls this signed API.
        # Serialize apply by observation version; a slower response cannot
        # replace state written by a newer concurrent retrieval.
        try:
            data = await self.client.decision(row["session_id"])
        except VeriffClientError:
            raise ProviderUnavailableError()
        decision = map_decision(data, row, party)
        row = await self.repository.apply(row, decision)
        saved = row.get("summary") or decision
        summary.update(status=row["status"], checks=saved.get("checks", []),
            subjectKind=row["subject_kind"], onBehalfOfPartyId=row["on_behalf_of_party_id"],
            attempt={"attemptNo": row["attempt_no"], "provider": "veriff", "levelName": None,
                "reviewAnswer": str(saved.get("decisionCode") or "") or None,
                "reviewRejectType": saved.get("reasonCode"), "rejectLabels": [],
                "lastEventType": "signed_decision_retrieval", "lastEventAt": None,
                "updatedAt": str(row.get("updated_at") or "") or None})
        if fingerprint(party) != row["subject_fingerprint"]:
            summary["status"] = "review_required"
        return summary


def build_veriff_context(settings, *, repository=None, client=None):
    try:
        config = load_veriff_config(settings)
    except (ValueError, TypeError):
        raise ConfigurationUnavailableError()
    return VeriffContext(config, repository, client)
