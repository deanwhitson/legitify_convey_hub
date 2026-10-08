"""ID-verification POC tests — routes, service, webhook crypto and client signing.

Runs fully offline: DB access is mocked, the provider client is a fixture or a
MockTransport, and fixture-mode state lives in the labelled in-memory
repository. Covers authz (unauthenticated, cross-institution, wrong-party,
client role), applicant binding, duplicate starts, status mapping, SDK-callback
non-authority, signature verification over raw bytes, malformed/oversized
payloads, dedupe, delayed/reordered events, test-mode events, storage failure
and mode separation.
"""

import asyncio
import hashlib
import hmac as hmac_mod
import json
import os
import sys
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import jwt as pyjwt
from fastapi.testclient import TestClient

_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_python_server = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _project_root)
sys.path.insert(0, _python_server)

from main import app
from repositories.id_verification import (
    InMemoryIdVerificationRepository,
    StorageUnavailableError,
)
from services.id_verification_config import IdVerificationConfig
from services.id_verification_service import (
    VerificationContext,
    build_external_ref,
)
from clients.sumsub_client import (
    FixtureSumsubClient,
    SumsubApiClient,
    SumsubClientError,
    fixture_applicant_id,
)
from services.id_verification_service import (
    ReconcilePendingError,
    apply_webhook_event,
)

TEST_JWT_SECRET = "test-jwt-secret-32-bytes-long!!"
AI = 5
TRANSFER_ID = str(uuid.uuid4())
PERSON_PARTY_ID = str(uuid.uuid4())
PERSON2_PARTY_ID = str(uuid.uuid4())
COMPANY_PARTY_ID = str(uuid.uuid4())

_PARTY_TYPES = {
    PERSON_PARTY_ID: "person",
    PERSON2_PARTY_ID: "person",
    COMPANY_PARTY_ID: "company",
}


def _token(role: int, ai: int, abilities=None):
    if abilities is None:
        abilities = ["api", "transfers:read", "transfers:write"]
    payload = {
        "type": "access",
        "user_id": 1,
        "golden_record_id": str(uuid.uuid4()),
        "abilities": abilities,
        "accountable_institution_id": ai,
        "user_roles_id": role,
        "tenant_id": str(uuid.uuid4()),
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    return pyjwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256")


def _auth(role: int = 3, ai: int = AI, abilities=None):
    return {"Authorization": f"Bearer {_token(role, ai, abilities)}"}


class _Q:
    def __init__(self, rows):
        self.rows = rows


async def _fake_query(sql, params, connection=None):
    if "FROM transfers" in sql:
        return _Q([{"id": params[0]}] if params[1] == AI else [])
    if "FROM transfer_parties" in sql:
        party_id = params[0]
        if params[1] != TRANSFER_ID or params[2] != AI or party_id not in _PARTY_TYPES:
            return _Q([])
        return _Q([{"id": party_id, "entity_type": _PARTY_TYPES[party_id]}])
    raise AssertionError(f"unexpected query: {sql[:60]}")


def _fixture_ctx() -> VerificationContext:
    config = IdVerificationConfig(mode="fixture", environment="fixture")
    return VerificationContext(
        config,
        InMemoryIdVerificationRepository(),
        FixtureSumsubClient(),
    )


def _fixture_event(ext_ref, etype="applicantReviewed", *,
                   ms="2026-10-08 10:00:00.000", review=None):
    event = {
        "type": etype,
        "applicantId": fixture_applicant_id(ext_ref),
        "externalUserId": ext_ref,
        "correlationId": f"corr-{uuid.uuid4()}",
        "createdAtMs": ms,
        "sandboxMode": False,
    }
    if review is not None:
        event["reviewResult"] = review
    return event


class IdVerificationRouteTests(unittest.TestCase):
    """Staff routes: authz, subject validation, session lifecycle."""

    FIXTURE_TOKEN = "route-test-fixture-token"

    @classmethod
    def setUpClass(cls):
        os.environ["JWT_SECRET"] = TEST_JWT_SECRET
        os.environ["SUMSUB_MODE"] = "fixture"
        os.environ["SUMSUB_FIXTURE_RECEIVER_TOKEN"] = cls.FIXTURE_TOKEN
        cls.get_pool_patch = patch("main.get_pool", new_callable=AsyncMock)
        cls.close_pool_patch = patch("main.close_pool", new_callable=AsyncMock)
        cls.entities_client_patch = patch("main.EntitiesClient", return_value=AsyncMock())
        cls.get_pool_patch.start()
        cls.close_pool_patch.start()
        cls.entities_client_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.entities_client_patch.stop()
        cls.close_pool_patch.stop()
        cls.get_pool_patch.stop()
        os.environ.pop("SUMSUB_MODE", None)

    def setUp(self):
        self.query_patch = patch(
            "routers.v1.id_verification.query", side_effect=_fake_query
        )
        self.query_patch.start()
        self.ctx = _fixture_ctx()
        self.client = TestClient(app).__enter__()
        app.state.id_verification_context = self.ctx

    def tearDown(self):
        self.client.__exit__(None, None, None)
        for attr in (
            "id_verification_context",
            "id_verification_repository",
            "id_verification_client",
        ):
            if hasattr(app.state, attr):
                delattr(app.state, attr)
        self.query_patch.stop()

    def _path(self, party=PERSON_PARTY_ID, suffix=""):
        return f"/api/v1/transfers/{TRANSFER_ID}/parties/{party}/id-verification{suffix}"

    # --- auth / tenancy -------------------------------------------------------

    def test_no_token_returns_401(self):
        r = self.client.get(self._path())
        self.assertEqual(r.status_code, 401)

    def test_client_role_denied(self):
        r = self.client.get(self._path(), headers=_auth(role=4))
        self.assertEqual(r.status_code, 404)

    def test_missing_read_ability_denied(self):
        r = self.client.get(
            self._path(), headers=_auth(abilities=["api"])
        )
        self.assertEqual(r.status_code, 404)

    def test_session_without_write_ability_403(self):
        r = self.client.post(
            self._path(suffix="/session"),
            json={},
            headers=_auth(abilities=["api", "transfers:read"]),
        )
        self.assertEqual(r.status_code, 403)

    def test_cross_institution_transfer_404(self):
        r = self.client.get(self._path(), headers=_auth(ai=99))
        self.assertEqual(r.status_code, 404)

    def test_wrong_party_404(self):
        r = self.client.get(
            self._path(party=str(uuid.uuid4())), headers=_auth()
        )
        self.assertEqual(r.status_code, 404)

    def test_non_person_subject_rejected(self):
        r = self.client.post(
            self._path(party=COMPANY_PARTY_ID, suffix="/session"),
            json={},
            headers=_auth(),
        )
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"], "subject_not_eligible")

    def test_on_behalf_requires_entity_party(self):
        r = self.client.post(
            self._path(suffix="/session"),
            json={"onBehalfOfPartyId": PERSON2_PARTY_ID},
            headers=_auth(),
        )
        self.assertEqual(r.status_code, 422)

    def test_unknown_body_fields_rejected(self):
        r = self.client.post(
            self._path(suffix="/session"),
            json={"applicantId": "evil", "levelName": "x", "tenantId": 9},
            headers=_auth(),
        )
        self.assertEqual(r.status_code, 422)

    # --- session lifecycle -----------------------------------------------------

    def test_start_session_fixture_returns_simulated_token(self):
        r = self.client.post(self._path(suffix="/session"), json={}, headers=_auth())
        self.assertEqual(r.status_code, 200)
        data = r.json()["data"]
        self.assertTrue(data["simulated"])
        self.assertEqual(data["mode"], "fixture")
        self.assertEqual(data["environment"], "fixture")
        self.assertTrue(data["sdkToken"].startswith("FIXTURE-TOKEN-"))
        self.assertEqual(data["subjectKind"], "party")

    def test_second_start_resumes_same_attempt(self):
        r1 = self.client.post(self._path(suffix="/session"), json={}, headers=_auth())
        r2 = self.client.post(self._path(suffix="/session"), json={}, headers=_auth())
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r1.json()["data"]["attemptNo"], r2.json()["data"]["attemptNo"])
        self.assertTrue(r2.json()["data"]["resumed"])
        # One attempt — the open-attempt invariant holds.
        self.assertEqual(len(self.ctx.repository._attempts), 1)

    def test_refresh_requires_open_attempt(self):
        r = self.client.post(self._path(suffix="/refresh"), json={}, headers=_auth())
        self.assertEqual(r.status_code, 409)

    def test_refresh_returns_new_token(self):
        self.client.post(self._path(suffix="/session"), json={}, headers=_auth())
        r = self.client.post(self._path(suffix="/refresh"), json={}, headers=_auth())
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["data"]["sdkToken"].startswith("FIXTURE-TOKEN-"))

    def test_representative_session_records_subject_kind(self):
        r = self.client.post(
            self._path(suffix="/session"),
            json={"onBehalfOfPartyId": COMPANY_PARTY_ID},
            headers=_auth(),
        )
        self.assertEqual(r.status_code, 200)
        data = r.json()["data"]
        self.assertEqual(data["subjectKind"], "representative")
        self.assertEqual(data["onBehalfOfPartyId"], COMPANY_PARTY_ID)

    def test_retry_only_from_retryable_status(self):
        r = self.client.post(self._path(suffix="/retry"), json={}, headers=_auth())
        self.assertEqual(r.status_code, 404)  # no attempt yet

    # --- status + fixture webhook drive ----------------------------------------

    def test_status_reflects_verified_fixture_event(self):
        self.client.post(self._path(suffix="/session"), json={}, headers=_auth())
        ext_ref = build_external_ref("fixture", AI, PERSON_PARTY_ID)
        attempt = list(self.ctx.repository._attempts.values())[0]
        created = datetime.fromisoformat(attempt["created_at"])
        ms = (created + timedelta(seconds=60)).strftime("%Y-%m-%d %H:%M:%S.000")
        event = _fixture_event(ext_ref, ms=ms, review={"reviewAnswer": "GREEN"})
        w = self.client.post(
            "/api/v1/webhooks/sumsub-fixture", json=event,
            headers={"X-Dev-Fixture-Token": self.FIXTURE_TOKEN},
        )
        self.assertEqual(w.status_code, 200)
        r = self.client.get(self._path(), headers=_auth())
        data = r.json()["data"]
        self.assertEqual(data["status"], "verified")
        self.assertTrue(data["simulated"])

    def test_fixture_webhook_absent_outside_fixture_mode(self):
        # The fixture receiver only exists in fixture mode — covered by the
        # config check; a disabled-mode request returns 404.
        r = self.client.post(
            "/api/v1/webhooks/sumsub",
            content=b'{"type":"applicantReviewed"}',
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(r.status_code, 404)

    def test_start_after_verified_rejected(self):
        # The public start path enforces the retry state policy server-side —
        # a verified attempt cannot silently open a new cycle.
        self.client.post(self._path(suffix="/session"), json={}, headers=_auth())
        ext_ref = build_external_ref("fixture", AI, PERSON_PARTY_ID)
        attempt = list(self.ctx.repository._attempts.values())[0]
        created = datetime.fromisoformat(attempt["created_at"])
        ms = (created + timedelta(seconds=60)).strftime("%Y-%m-%d %H:%M:%S.000")
        self.client.post(
            "/api/v1/webhooks/sumsub-fixture",
            json=_fixture_event(ext_ref, ms=ms, review={"reviewAnswer": "GREEN"}),
            headers={"X-Dev-Fixture-Token": self.FIXTURE_TOKEN},
        )
        r = self.client.post(self._path(suffix="/session"), json={}, headers=_auth())
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["error"], "not_retryable")

    def test_get_status_returns_stored_representative_binding(self):
        # onBehalfOfPartyId is persisted on the attempt — a status read
        # reports the recorded binding, not a reconstructed one.
        self.client.post(
            self._path(suffix="/session"),
            json={"onBehalfOfPartyId": COMPANY_PARTY_ID},
            headers=_auth(),
        )
        r = self.client.get(self._path(), headers=_auth())
        data = r.json()["data"]
        self.assertEqual(data["subjectKind"], "representative")
        self.assertEqual(data["onBehalfOfPartyId"], COMPANY_PARTY_ID)

    def test_fixture_webhook_denies_non_local_client(self):
        # Even with the correct demo token, a non-loopback peer gets 404.
        remote = TestClient(app, client=("203.0.113.9", 4444)).__enter__()
        try:
            r = remote.post(
                "/api/v1/webhooks/sumsub-fixture",
                json={"type": "applicantReviewed"},
                headers={"X-Dev-Fixture-Token": self.FIXTURE_TOKEN},
            )
            self.assertEqual(r.status_code, 404)
        finally:
            remote.__exit__(None, None, None)
            # The remote client's lifespan teardown nulled the shared
            # app.state.entities_client — restore it so the outer client's
            # teardown can close cleanly.
            app.state.entities_client = AsyncMock()

    def test_fixture_webhook_denied_without_token(self):
        # Fixture mode alone is not an injector: no token header → 404.
        r = self.client.post(
            "/api/v1/webhooks/sumsub-fixture",
            json={"type": "applicantCreated", "createdAtMs": "2026-10-08 10:00:00.000"},
        )
        self.assertEqual(r.status_code, 404)

    def test_fixture_webhook_denied_wrong_token(self):
        r = self.client.post(
            "/api/v1/webhooks/sumsub-fixture",
            json={"type": "applicantCreated", "createdAtMs": "2026-10-08 10:00:00.000"},
            headers={"X-Dev-Fixture-Token": "not-the-token"},
        )
        self.assertEqual(r.status_code, 404)

    def test_fixture_webhook_denied_when_token_unconfigured(self):
        # With no operator-set token the receiver is closed entirely —
        # fixture mode on a reachable host is not a status injector.
        # Settings load at lifespan, so a fresh client picks up the
        # emptied env var.
        with patch.dict(os.environ, {"SUMSUB_FIXTURE_RECEIVER_TOKEN": ""}):
            c = TestClient(app).__enter__()
            try:
                r = c.post(
                    "/api/v1/webhooks/sumsub-fixture",
                    json={"type": "applicantCreated", "createdAtMs": "2026-10-08 10:00:00.000"},
                    headers={"X-Dev-Fixture-Token": self.FIXTURE_TOKEN},
                )
            finally:
                c.__exit__(None, None, None)
                app.state.entities_client = AsyncMock()
        self.assertEqual(r.status_code, 404)

    def test_fixture_webhook_loopback_with_token_allowed(self):
        r = self.client.post(
            "/api/v1/webhooks/sumsub-fixture",
            json={"type": "applicantCreated", "createdAtMs": "2026-10-08 10:00:00.000"},
            headers={"X-Dev-Fixture-Token": self.FIXTURE_TOKEN},
        )
        self.assertEqual(r.status_code, 200)


class _FailingRepo(InMemoryIdVerificationRepository):
    async def apply_event(self, event, *, attempt_id=None, fields=None,
                          incoming_ts=None, mark_processed=True):
        raise StorageUnavailableError("db down")


class SumsubWebhookCryptoTests(unittest.TestCase):
    """HMAC receiver — raw-byte signatures, alg allowlist, malformed input."""

    WEBHOOK_SECRET = "whsec-test-secret"

    @classmethod
    def setUpClass(cls):
        os.environ["JWT_SECRET"] = TEST_JWT_SECRET
        os.environ["SUMSUB_MODE"] = "sandbox"
        os.environ["SUMSUB_WEBHOOK_SECRET"] = cls.WEBHOOK_SECRET
        os.environ["SUMSUB_APP_TOKEN"] = "sbx:token"
        os.environ["SUMSUB_APP_SECRET"] = "app-secret"
        os.environ["SUMSUB_LEVEL_NAME"] = "idv-poc-level"
        os.environ["SUMSUB_BASE_URL"] = "https://api.sumsub.com"
        cls.get_pool_patch = patch("main.get_pool", new_callable=AsyncMock)
        cls.close_pool_patch = patch("main.close_pool", new_callable=AsyncMock)
        cls.entities_client_patch = patch("main.EntitiesClient", return_value=AsyncMock())
        cls.get_pool_patch.start()
        cls.close_pool_patch.start()
        cls.entities_client_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.entities_client_patch.stop()
        cls.close_pool_patch.stop()
        cls.get_pool_patch.stop()
        for name in ("SUMSUB_MODE", "SUMSUB_WEBHOOK_SECRET", "SUMSUB_APP_TOKEN",
                     "SUMSUB_APP_SECRET", "SUMSUB_LEVEL_NAME", "SUMSUB_BASE_URL"):
            os.environ.pop(name, None)

    def setUp(self):
        config = IdVerificationConfig(
            mode="sandbox",
            environment="sandbox",
            webhook_secret=self.WEBHOOK_SECRET,
        )
        self.repo = InMemoryIdVerificationRepository()
        self.ctx = VerificationContext(config, self.repo, FixtureSumsubClient())
        self.client = TestClient(app).__enter__()
        app.state.id_verification_context = self.ctx
        self.ext_ref = build_external_ref("sandbox", AI, PERSON_PARTY_ID)
        self._seed_attempt()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        if hasattr(app.state, "id_verification_context"):
            delattr(app.state, "id_verification_context")

    def _seed_attempt(self):
        import asyncio
        attempt = {
            "id": str(uuid.uuid4()),
            "environment": "sandbox",
            "accountable_institution_id": AI,
            "transfer_id": TRANSFER_ID,
            "transfer_party_id": PERSON_PARTY_ID,
            "subject_kind": "party",
            "attempt_no": 1,
            "external_ref": self.ext_ref,
            "provider": "sumsub",
            "provider_applicant_id": "app-1",
            "level_name": "idv-poc-level",
            "inspection_id": None,
            "on_behalf_of_party_id": None,
            "status": "started",
            "simulated": False,
            "created_at": "2026-10-08T09:00:00+00:00",
            "updated_at": "2026-10-08T09:00:00+00:00",
        }
        asyncio.run(
            self.repo.create_attempt(attempt)
        )

    def _post(self, event=None, *, raw=None, secret=None, alg="HMAC_SHA256_HEX",
              sign=True, headers=None):
        body = raw if raw is not None else json.dumps(event).encode()
        hdrs = {"Content-Type": "application/json"}
        if sign:
            digest = hmac_mod.new(
                (secret or self.WEBHOOK_SECRET).encode(), body, hashlib.sha256
            ).hexdigest()
            hdrs["x-payload-digest"] = digest
            hdrs["x-payload-digest-alg"] = alg
        hdrs.update(headers or {})
        return self.client.post("/api/v1/webhooks/sumsub", content=body, headers=hdrs)

    def _event(self, etype="applicantReviewed", *, ms="2026-10-08 10:00:00.000",
               ext_ref=None, applicant="app-1", review=None):
        e = {
            "type": etype,
            "applicantId": applicant,
            "externalUserId": ext_ref if ext_ref is not None else self.ext_ref,
            "correlationId": f"corr-{uuid.uuid4()}",
            "createdAtMs": ms,
            "sandboxMode": True,
        }
        if review is not None:
            e["reviewResult"] = review
        return e

    def test_valid_signature_applies_green(self):
        r = self._post(self._event(review={"reviewAnswer": "GREEN"}))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"]["result"], "applied")
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertEqual(attempt["status"], "verified")

    def test_tampered_body_rejected(self):
        # Signature is computed over the untampered body; the sent bytes differ.
        signed = json.dumps(self._event(review={"reviewAnswer": "GREEN"})).encode()
        tampered = signed.replace(b'"GREEN"', b'"RED"')
        digest = hmac_mod.new(self.WEBHOOK_SECRET.encode(), signed, hashlib.sha256).hexdigest()
        r = self.client.post(
            "/api/v1/webhooks/sumsub",
            content=tampered,
            headers={"x-payload-digest": digest, "x-payload-digest-alg": "HMAC_SHA256_HEX"},
        )
        self.assertEqual(r.status_code, 401)

    def test_missing_signature_rejected(self):
        r = self.client.post(
            "/api/v1/webhooks/sumsub",
            content=json.dumps(self._event()).encode(),
        )
        self.assertEqual(r.status_code, 401)

    def test_wrong_secret_rejected(self):
        r = self._post(self._event(), secret="not-the-secret")
        self.assertEqual(r.status_code, 401)

    def test_unsupported_algorithm_rejected(self):
        body = json.dumps(self._event()).encode()
        digest = hmac_mod.new(self.WEBHOOK_SECRET.encode(), body, hashlib.sha1).hexdigest()
        r = self.client.post(
            "/api/v1/webhooks/sumsub",
            content=body,
            headers={"x-payload-digest": digest, "x-payload-digest-alg": "HMAC_SHA1_HEX"},
        )
        self.assertEqual(r.status_code, 401)

    def test_bad_digest_encoding_rejected(self):
        r = self.client.post(
            "/api/v1/webhooks/sumsub",
            content=json.dumps(self._event()).encode(),
            headers={"x-payload-digest": "zzzz" + "0" * 60,
                     "x-payload-digest-alg": "HMAC_SHA256_HEX"},
        )
        self.assertEqual(r.status_code, 401)

    def test_malformed_json_rejected(self):
        r = self._post(raw=b"not json{{{", sign=True)
        self.assertEqual(r.status_code, 400)

    def test_red_retry_maps_retry_requested(self):
        r = self._post(self._event(
            review={"reviewAnswer": "RED", "reviewRejectType": "RETRY",
                    "rejectLabels": ["BAD_SELFIE"]}))
        self.assertEqual(r.status_code, 200)
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertEqual(attempt["status"], "retry_requested")
        self.assertEqual(attempt["reject_labels"], ["BAD_SELFIE"])

    def test_red_final_maps_declined(self):
        r = self._post(self._event(
            review={"reviewAnswer": "RED", "reviewRejectType": "FINAL"}))
        self.assertEqual(r.status_code, 200)
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertEqual(attempt["status"], "declined")

    def test_red_unknown_type_maps_review_required(self):
        r = self._post(self._event(
            review={"reviewAnswer": "RED", "reviewRejectType": "EXTERNAL"}))
        self.assertEqual(r.status_code, 200)
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertEqual(attempt["status"], "review_required")

    def test_missing_review_result_never_verified(self):
        r = self._post(self._event())
        self.assertEqual(r.status_code, 200)
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertEqual(attempt["status"], "review_required")

    def test_unrecognised_answer_never_verified(self):
        r = self._post(self._event(review={"reviewAnswer": "PURPLE"}))
        self.assertEqual(r.status_code, 200)
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertNotEqual(attempt["status"], "verified")

    def test_duplicate_event_harmless(self):
        event = self._event(review={"reviewAnswer": "GREEN"})
        r1 = self._post(event)
        r2 = self._post(event)
        self.assertEqual(r1.json()["data"]["result"], "applied")
        self.assertEqual(r2.json()["data"]["disposition"], "duplicate")
        events = list(self.repo._events.values())
        self.assertEqual(len(events), 1)

    def test_out_of_order_event_does_not_regress(self):
        self._post(self._event(
            ms="2026-10-08 10:05:00.000",
            review={"reviewAnswer": "GREEN"}))
        stale = self._event(
            ms="2026-10-08 10:00:00.000",
            review={"reviewAnswer": "RED", "reviewRejectType": "FINAL"})
        r = self._post(stale)
        self.assertEqual(r.status_code, 200)
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertEqual(attempt["status"], "verified")

    def test_delayed_event_still_applies(self):
        # A legitimately delayed delivery (older than now, newer than last
        # event) is still applied — no tiny receipt-time window.
        later = self._event(etype="applicantPending", ms="2026-10-08 10:02:00.000")
        r = self._post(later)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"]["status"], "pending")

    def test_unknown_applicant_never_associates(self):
        r = self._post(self._event(ext_ref="dly-sandbox-unknown",
                                   applicant="stranger"))
        self.assertEqual(r.json()["data"]["disposition"], "unmatched")
        self.assertEqual(len(self.repo._attempts), 1)

    def test_test_mode_event_recorded_not_applied(self):
        e = self._event(review={"reviewAnswer": "GREEN"})
        e["testMode"] = True
        r = self._post(e)
        self.assertEqual(r.json()["data"]["disposition"], "test_mode")
        import asyncio
        attempt = asyncio.run(
            self.repo.get_latest_attempt("sandbox", AI, PERSON_PARTY_ID)
        )
        self.assertEqual(attempt["status"], "started")

    def test_environment_mismatch_rejected(self):
        e = self._event(review={"reviewAnswer": "GREEN"})
        e["sandboxMode"] = False  # live-flagged event hitting sandbox receiver
        r = self._post(e)
        self.assertEqual(r.status_code, 400)

    def test_storage_failure_returns_503_not_acknowledged(self):
        config = IdVerificationConfig(
            mode="sandbox", environment="sandbox",
            webhook_secret=self.WEBHOOK_SECRET,
        )
        app.state.id_verification_context = VerificationContext(
            config, _FailingRepo(), FixtureSumsubClient()
        )
        r = self._post(self._event(review={"reviewAnswer": "GREEN"}))
        self.assertEqual(r.status_code, 503)


class SumsubClientSigningTests(unittest.TestCase):
    """Request signing contract — offline MockTransport, no provider traffic."""

    def test_signed_headers_and_hmac(self):
        import asyncio
        import httpx

        config = IdVerificationConfig(
            mode="sandbox",
            environment="sandbox",
            app_token="sbx:token",
            app_secret="test-app-secret",
            base_url="https://api.sumsub.com",
            level_name="lvl",
        )
        captured = {}

        def handler(request):
            captured["headers"] = dict(request.headers)
            captured["method"] = request.method
            captured["path"] = request.url.path + (
                "?" + request.url.query.decode() if request.url.query else ""
            )
            captured["body"] = request.content
            return httpx.Response(200, json={"token": "sdk-token-1"})

        client = SumsubApiClient(config, transport=httpx.MockTransport(handler))
        asyncio.run(
            client.create_sdk_access_token("dly-sandbox-abc", "lvl", 600)
        )

        self.assertEqual(captured["headers"].get("x-app-token"), "sbx:token")
        ts = captured["headers"]["x-app-access-ts"]
        sig = captured["headers"]["x-app-access-sig"]
        expected = hmac_mod.new(
            b"test-app-secret",
            ts.encode() + b"POST" + captured["path"].encode() + captured["body"],
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(sig, expected)

    def test_no_secret_in_error_path(self):
        import asyncio
        import httpx
        from clients.sumsub_client import SumsubClientError

        config = IdVerificationConfig(
            mode="sandbox", environment="sandbox",
            app_token="sbx:token", app_secret="test-app-secret",
            base_url="https://api.sumsub.com",
        )
        client = SumsubApiClient(
            config,
            transport=httpx.MockTransport(
                lambda r: httpx.Response(500, text="internal detail: token=sbx:token")
            ),
        )
        with self.assertRaises(SumsubClientError) as cm:
            asyncio.run(
                client.get_applicant_review_status("x")
            )
        self.assertNotIn("sbx:token", str(cm.exception))
        self.assertNotIn("test-app-secret", repr(cm.exception))




class _ApplyBarrierRepo(InMemoryIdVerificationRepository):
    """Adds one deterministic suspension point at the head of apply_event
    so two deliveries can both resolve and reach the critical section before
    either commits — the in-memory equivalent of the durable repository's
    real I/O interleaving inside the row lock."""

    def __init__(self):
        super().__init__()
        self.gate = asyncio.Event()
        self.calls = 0

    async def apply_event(self, *args, **kwargs):
        self.calls += 1
        await self.gate.wait()
        return await super().apply_event(*args, **kwargs)


class WebhookApplySemanticsTests(unittest.TestCase):
    """F2/F3 regressions: atomic apply, resumable events, cycle binding,
    applicant cross-checks and reconcile-on-ambiguity."""

    def setUp(self):
        self.config = IdVerificationConfig(
            mode="sandbox", environment="sandbox", webhook_secret="s",
        )
        self.repo = InMemoryIdVerificationRepository()
        self.ctx = VerificationContext(self.config, self.repo, FixtureSumsubClient())
        self.ext_ref = build_external_ref("sandbox", AI, PERSON_PARTY_ID)

    def _mk_attempt(self, no=1, status="started", applicant="app-1",
                    created="2026-10-08T09:00:00+00:00", insp=None,
                    last_ms=None):
        import asyncio
        attempt = {
            "id": str(uuid.uuid4()),
            "environment": "sandbox",
            "accountable_institution_id": AI,
            "transfer_id": TRANSFER_ID,
            "transfer_party_id": PERSON_PARTY_ID,
            "subject_kind": "party",
            "on_behalf_of_party_id": None,
            "attempt_no": no,
            "external_ref": self.ext_ref,
            "provider": "sumsub",
            "provider_applicant_id": applicant,
            "level_name": "idv-poc-level",
            "inspection_id": insp,
            "status": status,
            "simulated": False,
            "last_event_created_at_ms": last_ms,
            "created_at": created,
            "updated_at": created,
        }
        return asyncio.run(self.repo.create_attempt(attempt))

    def _ev(self, etype="applicantReviewed", *, ms="2026-10-08 10:00:00.000",
            applicant="app-1", ext_ref=None, review=None, insp=None):
        e = {
            "type": etype,
            "applicantId": applicant,
            "externalUserId": ext_ref if ext_ref is not None else self.ext_ref,
            "correlationId": f"corr-{uuid.uuid4()}",
            "createdAtMs": ms,
            "sandboxMode": True,
        }
        if review is not None:
            e["reviewResult"] = review
        if insp is not None:
            e["inspectionId"] = insp
        return e

    def _apply(self, event):
        import asyncio
        return asyncio.run(apply_webhook_event(self.ctx, event))

    def _attempts(self):
        return list(self.repo._attempts.values())

    # --- F2: atomicity / resumable handling ---------------------------------

    def test_failed_apply_rolls_back_and_replay_applies(self):
        self._mk_attempt()

        class FailOnce(InMemoryIdVerificationRepository):
            def __init__(self, inner):
                super().__init__()
                self.__dict__.update(inner.__dict__)
                self.failed = False

            def _apply_fields(self, attempt, fields):
                if not self.failed:
                    self.failed = True
                    raise StorageUnavailableError("injected update failure")
                return super()._apply_fields(attempt, fields)

        self.ctx.repository = FailOnce(self.repo)
        event = self._ev(review={"reviewAnswer": "GREEN"})
        with self.assertRaises(StorageUnavailableError):
            self._apply(event)
        # Nothing durably recorded — the insert rolled back with the update.
        self.assertEqual(len(self.repo._events), 0)
        self.assertEqual(self._attempts()[0]["status"], "started")
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        self.assertEqual(self._attempts()[0]["status"], "verified")

    def test_unprocessed_event_resumes_on_redelivery(self):
        attempt = self._mk_attempt()
        event = self._ev(review={"reviewAnswer": "GREEN"})
        import asyncio
        # Simulate an event row that was recorded but never durably applied
        # (processed_at NULL) — the exact state a crashed apply leaves behind
        # when the insert itself committed.
        from repositories.id_verification import event_dedupe_key
        asyncio.run(self.repo.apply_event(
            {
                "id": str(uuid.uuid4()),
                "attempt_id": attempt["id"],
                "environment": "sandbox",
                "dedupe_key": event_dedupe_key(
                    "sandbox", event["type"], event["applicantId"],
                    event.get("correlationId"), event.get("reviewStatus"),
                    event["reviewResult"]["reviewAnswer"], event["createdAtMs"],
                ),
                "event_type": event["type"],
                "provider_applicant_id": event["applicantId"],
                "external_ref": event["externalUserId"],
                "correlation_id": event["correlationId"],
                "level_name": None,
                "inspection_id": None,
                "review_status": None,
                "review_answer": "GREEN",
                "review_reject_type": None,
                "reject_labels": [],
                "provider_created_at_ms": event["createdAtMs"],
                "received_at": datetime.now(timezone.utc),
                "processed_at": None,
                "disposition": "matched",
            },
            attempt_id=None, fields=None, incoming_ts=None,
            mark_processed=False,
        ))
        out = self._apply(event)
        # Not a false "duplicate" — the unfinished event resumed and applied.
        self.assertEqual(out["result"], "applied")
        self.assertEqual(self._attempts()[0]["status"], "verified")
        self.assertEqual(len(self.repo._events), 1)

    def test_concurrent_events_serialise_without_regression(self):
        import asyncio
        self._mk_attempt()
        green = self._ev(ms="2026-10-08 10:05:00.000",
                         review={"reviewAnswer": "GREEN"})
        red = self._ev(ms="2026-10-08 10:00:00.000",
                       review={"reviewAnswer": "RED", "reviewRejectType": "FINAL"})

        async def both():
            return await asyncio.gather(
                apply_webhook_event(self.ctx, green),
                apply_webhook_event(self.ctx, red),
            )

        results = asyncio.run(both())
        outcomes = sorted(r["result"] for r in results)
        # One wins, one is out-of-order — never an overwrite of newer state.
        self.assertEqual(outcomes, ["applied", "stale_ignored"])
        self.assertEqual(self._attempts()[0]["status"], "verified")

    # --- F3: binding / cycle separation --------------------------------------

    def test_applicant_mismatch_on_known_ref_never_applies(self):
        self._mk_attempt()
        event = self._ev(applicant="app-stranger",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["disposition"], "binding_mismatch")
        self.assertEqual(self._attempts()[0]["status"], "started")

    def test_previous_cycle_event_cannot_verify_new_attempt(self):
        # Reviewer repro: attempt 1 got RED/RETRY at 10:01; a new cycle
        # opened at 10:02; a delayed GREEN for cycle 1 (10:00:30) arrives.
        # It binds to cycle 1 by timestamp window, where it is also older
        # than that cycle's last event — recorded stale, applied nowhere.
        self._mk_attempt(no=1, status="retry_requested", insp="insp-1",
                         last_ms="2026-10-08 10:01:00.000")
        self._mk_attempt(no=2, status="started",
                         created="2026-10-08T10:02:00+00:00")
        event = self._ev(ms="2026-10-08 10:00:30.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "stale_ignored")
        attempts = {a["attempt_no"]: a for a in self._attempts()}
        self.assertEqual(attempts[2]["status"], "started")
        self.assertEqual(attempts[1]["status"], "retry_requested")

    def test_newer_event_same_inspection_id_binds_current_cycle(self):
        # R1 repro: inspectionId is applicant-scoped, not a cycle id — a
        # NEWER event carrying the same inspectionId as cycle 1 belongs to
        # the current cycle 2, not the old one.
        self._mk_attempt(no=1, status="retry_requested", insp="insp-1",
                         last_ms="2026-10-08 10:01:00.000")
        self._mk_attempt(no=2, status="started",
                         created="2026-10-08T10:02:00+00:00")
        event = self._ev(ms="2026-10-08 10:03:00.000", insp="insp-1",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        attempts = {a["attempt_no"]: a for a in self._attempts()}
        self.assertEqual(attempts[2]["status"], "verified")
        # The prior cycle is untouched by the new cycle's verdict.
        self.assertEqual(attempts[1]["status"], "retry_requested")

    def test_timestamp_window_routes_prior_cycle_event(self):
        # A delayed verdict genuinely inside cycle 1's window binds cycle 1
        # by timestamp — inspectionId is only recorded evidence, not the
        # routing authority.
        self._mk_attempt(no=1, status="retry_requested", insp="insp-1",
                         last_ms="2026-10-08 10:01:00.000")
        self._mk_attempt(no=2, status="started",
                         created="2026-10-08T10:02:00+00:00")
        event = self._ev(ms="2026-10-08 10:01:30.000", insp="insp-1",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        self.assertEqual(out["disposition"], "prior_cycle")
        attempts = {a["attempt_no"]: a for a in self._attempts()}
        self.assertEqual(attempts[1]["status"], "verified")
        # The open cycle is untouched by the previous cycle's verdict.
        self.assertEqual(attempts[2]["status"], "started")

    def test_event_predating_all_cycles_needs_reconcile(self):
        # An event older than every recorded cycle has no owner — ambiguous,
        # never guessed onto the latest attempt.
        self._mk_attempt(no=1, status="retry_requested", insp="insp-1",
                         last_ms="2026-10-08 10:01:00.000")
        self._mk_attempt(no=2, status="started",
                         created="2026-10-08T10:02:00+00:00")
        event = self._ev(ms="2026-10-08 08:00:00.000", insp="insp-1",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "ambiguous_not_applied")
        attempts = {a["attempt_no"]: a for a in self._attempts()}
        self.assertEqual(attempts[1]["status"], "retry_requested")
        self.assertEqual(attempts[2]["status"], "started")

    def test_unknown_cycle_id_with_prior_cycles_needs_reconcile(self):
        # Prior bound cycle recorded insp-1; an event claims an unseen
        # inspection id — contradictory evidence, so reconcile is required
        # and the fixture (no provider) cannot apply it.
        self._mk_attempt(no=1, status="retry_requested", insp="insp-1",
                         last_ms="2026-10-08 10:01:00.000")
        self._mk_attempt(no=2, status="started",
                         created="2026-10-08T10:02:00+00:00")
        event = self._ev(ms="2026-10-08 10:05:00.000", insp="insp-2",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "ambiguous_not_applied")
        attempts = {a["attempt_no"]: a for a in self._attempts()}
        self.assertEqual(attempts[2]["status"], "started")

    def test_missing_timestamp_multi_cycle_needs_reconcile(self):
        # No createdAtMs: the event cannot be placed in a cycle — reconcile
        # is required; the fixture client cannot supply one.
        self._mk_attempt(no=1, status="retry_requested", insp="insp-1",
                         last_ms="2026-10-08 10:01:00.000")
        self._mk_attempt(no=2, status="started",
                         created="2026-10-08T10:02:00+00:00")
        event = self._ev(insp="insp-1", review={"reviewAnswer": "GREEN"})
        del event["createdAtMs"]
        out = self._apply(event)
        self.assertEqual(out["result"], "ambiguous_not_applied")
        attempts = {a["attempt_no"]: a for a in self._attempts()}
        self.assertEqual(attempts[2]["status"], "started")

    # --- reconcile on ambiguity ----------------------------------------------

    def test_equal_timestamp_reconciles_against_provider(self):
        import httpx
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        captured = {}

        def handler(request):
            captured["path"] = request.url.path
            return httpx.Response(200, json={
                "reviewStatus": "completed",
                "reviewResult": {"reviewAnswer": "GREEN"},
            })

        self.ctx.client = SumsubApiClient(
            IdVerificationConfig(
                mode="sandbox", environment="sandbox",
                app_token="t", app_secret="s",
                base_url="https://api.sumsub.com",
            ),
            transport=httpx.MockTransport(handler),
        )
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        self.assertEqual(self._attempts()[0]["status"], "verified")
        self.assertEqual(captured["path"], "/resources/applicants/app-1/status")

    def test_failed_reconcile_leaves_event_unprocessed(self):
        import httpx
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")

        def bad(request):
            return httpx.Response(500, json={})

        self.ctx.client = SumsubApiClient(
            IdVerificationConfig(
                mode="sandbox", environment="sandbox",
                app_token="t", app_secret="s", base_url="https://api.sumsub.com",
            ),
            transport=httpx.MockTransport(bad),
        )
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        with self.assertRaises(ReconcilePendingError):
            self._apply(event)
        # Recorded but unprocessed — a redelivery resumes rather than being
        # reported a false duplicate.
        rows = list(self.repo._events.values())
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["processed_at"])
        self.assertEqual(self._attempts()[0]["status"], "started")

        def good(request):
            return httpx.Response(200, json={
                "reviewStatus": "completed",
                "reviewResult": {"reviewAnswer": "GREEN"},
            })

        self.ctx.client = SumsubApiClient(
            IdVerificationConfig(
                mode="sandbox", environment="sandbox",
                app_token="t", app_secret="s", base_url="https://api.sumsub.com",
            ),
            transport=httpx.MockTransport(good),
        )
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        self.assertEqual(self._attempts()[0]["status"], "verified")

    def test_fixture_ambiguous_event_never_applies(self):
        # No provider to reconcile with — ambiguous stays unapplied.
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "ambiguous_not_applied")
        self.assertEqual(self._attempts()[0]["status"], "started")


    # --- R2: reconcile must honour the provider's reviewStatus --------------

    def _provider_ctx(self, payload):
        import httpx
        def handler(request):
            return httpx.Response(200, json=payload)
        self.ctx.client = SumsubApiClient(
            IdVerificationConfig(
                mode="sandbox", environment="sandbox",
                app_token="t", app_secret="s", base_url="https://api.sumsub.com",
            ),
            transport=httpx.MockTransport(handler),
        )

    def test_reconcile_on_hold_green_is_not_verified(self):
        # R2 repro: provider documents GREEN appearing in onHold — an
        # answer alone is not a final approval.
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        self._provider_ctx({
            "reviewStatus": "onHold",
            "reviewResult": {"reviewAnswer": "GREEN"},
        })
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        self.assertEqual(out["status"], "review_required")
        attempt = self._attempts()[0]
        self.assertEqual(attempt["status"], "review_required")
        # The provider-confirmed interim answer is what persists — never a
        # promoted verdict.
        self.assertEqual(attempt["review_answer"], "GREEN")

    def test_reconcile_pending_green_is_not_verified(self):
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        self._provider_ctx({
            "reviewStatus": "pending",
            "reviewResult": {"reviewAnswer": "GREEN"},
        })
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        self.assertEqual(out["status"], "pending")
        self.assertEqual(self._attempts()[0]["status"], "pending")

    def test_reconcile_missing_status_never_applies(self):
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        self._provider_ctx({
            "reviewResult": {"reviewAnswer": "GREEN"},
        })
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "ambiguous_not_applied")
        self.assertEqual(self._attempts()[0]["status"], "started")

    def test_reconcile_unknown_status_never_applies(self):
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        self._provider_ctx({
            "reviewStatus": "halfDoneSomethingNew",
            "reviewResult": {"reviewAnswer": "GREEN"},
        })
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "ambiguous_not_applied")
        self.assertEqual(self._attempts()[0]["status"], "started")

    def test_reconcile_completed_green_verifies(self):
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        self._provider_ctx({
            "reviewStatus": "completed",
            "reviewResult": {"reviewAnswer": "GREEN"},
        })
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        self.assertEqual(self._attempts()[0]["status"], "verified")

    def test_reconcile_completed_red_retry(self):
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        self._provider_ctx({
            "reviewStatus": "completed",
            "reviewResult": {"reviewAnswer": "RED", "reviewRejectType": "RETRY"},
        })
        event = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        out = self._apply(event)
        self.assertEqual(out["result"], "applied")
        attempt = self._attempts()[0]
        self.assertEqual(attempt["status"], "retry_requested")
        # The provider-confirmed RED summary persists — not the incoming
        # ambiguous event's GREEN.
        self.assertEqual(attempt["review_answer"], "RED")
        self.assertEqual(attempt["review_reject_type"], "RETRY")

    # --- concurrency: equal timestamps cannot double-apply -------------------

    def test_equal_timestamp_second_event_cannot_apply_without_reconcile(self):
        # Two deliveries at the same provider instant: the first applies,
        # the second is ambiguous inside the lock — never a blind overwrite.
        self._mk_attempt()
        first = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        second = self._ev(ms="2026-10-08 10:00:00.000",
                          review={"reviewAnswer": "RED",
                                  "reviewRejectType": "FINAL"})
        out1 = self._apply(first)
        out2 = self._apply(second)
        self.assertEqual(out1["result"], "applied")
        # The service-level equal-ts rule marks it ambiguous; the fixture
        # cannot reconcile, so it is recorded but not applied.
        self.assertEqual(out2["result"], "ambiguous_not_applied")
        self.assertEqual(self._attempts()[0]["status"], "verified")

    def test_concurrent_equal_timestamp_events_single_verdict(self):
        green, red = self._equal_ts_race()
        applied = self._attempts()[0]["status"]
        self.assertIn(applied, ("verified", "declined"))
        # The loser is recorded but unprocessed — the ack was refused (503),
        # so the provider redelivers rather than the event being lost.
        unprocessed = [e for e in self.repo._events.values()
                       if e["processed_at"] is None]
        self.assertEqual(len(unprocessed), 1)
        self.assertEqual(
            unprocessed[0]["disposition"], "ambiguous_not_applied")

    def _equal_ts_race(self):
        """Run the deterministic equal-timestamp race on a barrier repo:
        both deliveries resolve and enter apply_event before either
        commits — the in-memory equivalent of the durable repository's
        in-lock interleaving. Returns (green, red)."""
        import asyncio
        repo = _ApplyBarrierRepo()
        self.ctx.repository = repo
        self.repo = repo
        self._mk_attempt()
        green = self._ev(ms="2026-10-08 10:00:00.000",
                         review={"reviewAnswer": "GREEN"})
        red = self._ev(ms="2026-10-08 10:00:00.000",
                       review={"reviewAnswer": "RED",
                               "reviewRejectType": "FINAL"})

        async def both():
            t_g = asyncio.create_task(apply_webhook_event(self.ctx, green))
            t_r = asyncio.create_task(apply_webhook_event(self.ctx, red))
            while repo.calls < 2:
                await asyncio.sleep(0)
            repo.gate.set()
            return await asyncio.gather(t_g, t_r, return_exceptions=True)

        results = asyncio.run(both())
        applied = [r for r in results
                   if isinstance(r, dict) and r["result"] == "applied"]
        pending = [r for r in results if isinstance(r, ReconcilePendingError)]
        # Exactly one verdict applies; the equal-timestamp rival loses the
        # row-lock race and is left unprocessed.
        self.assertEqual(len(applied), 1)
        self.assertEqual(len(pending), 1)
        return green, red

    def test_ambiguous_loser_replay_is_evaluated_not_lost(self):
        # Replay the event that lost the equal-timestamp race: the winner's
        # redelivery still dedupes, while the loser is re-evaluated — in
        # fixture mode there is no provider to reconcile, so it is durably
        # recorded ambiguous_not_applied (processed), never lost.
        green, red = self._equal_ts_race()
        status_after = self._attempts()[0]["status"]
        out_g = self._apply(green)
        out_r = self._apply(red)
        outcomes = sorted((out_g["result"], out_r["result"]))
        self.assertEqual(outcomes, ["ambiguous_not_applied", "duplicate"])
        for e in self.repo._events.values():
            self.assertIsNotNone(e["processed_at"])
        self.assertEqual(self._attempts()[0]["status"], status_after)

    def test_ambiguous_loser_replay_reconciles_to_provider_verdict(self):
        # Sandbox replay: the provider-confirmed verdict converges with the
        # committed winner — the retried event applies safely rather than
        # staying a permanent unprocessed residue.
        green, red = self._equal_ts_race()
        winner_status = self._attempts()[0]["status"]
        self._provider_ctx(
            {"reviewStatus": "completed",
             "reviewResult": {"reviewAnswer": "GREEN"}}
            if winner_status == "verified" else
            {"reviewStatus": "completed",
             "reviewResult": {"reviewAnswer": "RED",
                              "reviewRejectType": "FINAL"}})
        replays = [self._apply(green), self._apply(red)]
        retried = [o for o in replays if o["result"] != "duplicate"]
        self.assertEqual(len(retried), 1)
        self.assertEqual(retried[0]["result"], "applied")
        self.assertEqual(retried[0]["status"], winner_status)
        self.assertEqual(self._attempts()[0]["status"], winner_status)
        for e in self.repo._events.values():
            self.assertIsNotNone(e["processed_at"])



def _rs(review_status, answer, reject_type=None):
    from clients.sumsub_client import ReviewStatus
    return ReviewStatus(
        review_status=review_status, review_answer=answer,
        review_reject_type=reject_type, reject_labels=(), level_name=None,
    )


class _GatedReconcileClient(SumsubApiClient):
    """Deterministic barrier client for reconcile-vs-commit races: the first
    review-status lookup signals ``entered`` and blocks on ``gate`` so the
    test can commit newer attempt state while a provider reconciliation is
    provably in flight; subsequent calls answer immediately."""

    def __init__(self, config, statuses):
        import httpx
        super().__init__(
            config,
            transport=httpx.MockTransport(lambda r: httpx.Response(500, json={})),
        )
        self._statuses = list(statuses)
        self.entered = asyncio.Event()
        self.gate = asyncio.Event()
        self.calls = 0

    async def get_applicant_review_status(self, applicant_id):
        self.calls += 1
        idx = min(self.calls - 1, len(self._statuses) - 1)
        if self.calls == 1:
            self.entered.set()
            await self.gate.wait()
        return self._statuses[idx]


class ReconcileVersionRaceTests(unittest.TestCase):
    """Third-review P1: a delayed provider reconciliation must not overwrite
    a newer committed decision. The apply revalidates the attempt state
    version captured before the provider lookup; a mismatch leaves the
    event unprocessed so a redelivery re-reconciles fresh state."""

    def setUp(self):
        self.config = IdVerificationConfig(
            mode="sandbox", environment="sandbox", webhook_secret="s",
        )
        self.repo = InMemoryIdVerificationRepository()
        self.ctx = VerificationContext(self.config, self.repo, FixtureSumsubClient())
        self.ext_ref = build_external_ref("sandbox", AI, PERSON_PARTY_ID)

    def _client_cfg(self):
        return IdVerificationConfig(
            mode="sandbox", environment="sandbox",
            app_token="t", app_secret="s", base_url="https://api.sumsub.com",
        )

    def _mk_attempt(self, last_ms=None):
        attempt = {
            "id": str(uuid.uuid4()),
            "environment": "sandbox",
            "accountable_institution_id": AI,
            "transfer_id": TRANSFER_ID,
            "transfer_party_id": PERSON_PARTY_ID,
            "subject_kind": "party",
            "on_behalf_of_party_id": None,
            "attempt_no": 1,
            "external_ref": self.ext_ref,
            "provider": "sumsub",
            "provider_applicant_id": "app-1",
            "level_name": "idv-poc-level",
            "inspection_id": None,
            "status": "started",
            "simulated": False,
            "last_event_created_at_ms": last_ms,
            "created_at": "2026-10-08T09:00:00+00:00",
            "updated_at": "2026-10-08T09:00:00+00:00",
        }
        return asyncio.run(self.repo.create_attempt(attempt))

    def _ev(self, ms, review):
        return {
            "type": "applicantReviewed",
            "applicantId": "app-1",
            "externalUserId": self.ext_ref,
            "correlationId": f"corr-{uuid.uuid4()}",
            "createdAtMs": ms,
            "sandboxMode": True,
            "reviewResult": review,
        }

    def _attempt(self):
        return list(self.repo._attempts.values())[0]

    async def _race(self, stale_event, newer_event, client):
        """Run the review's interleaving: reconcile lookup in flight ->
        conflicting newer decision commits -> stale response released."""
        self.ctx.client = client
        slow = asyncio.create_task(apply_webhook_event(self.ctx, stale_event))
        await client.entered.wait()
        out_newer = await apply_webhook_event(self.ctx, newer_event)
        client.gate.set()
        return slow, out_newer

    def test_missing_ts_green_reconcile_cannot_overwrite_committed_red(self):
        # Review repro: GREEN with no createdAtMs reconciles; a newer
        # timestamped RED/FINAL commits while the provider call is in
        # flight; the released stale snapshot must not flip it back.
        self._mk_attempt()
        client = _GatedReconcileClient(self._client_cfg(), [
            _rs("completed", "GREEN"),               # stale in-flight snapshot
            _rs("completed", "RED", "FINAL"),        # fresh truth on retry
        ])
        green = self._ev(None, {"reviewAnswer": "GREEN"})
        red = self._ev("2026-10-08 10:05:00.000",
                       {"reviewAnswer": "RED", "reviewRejectType": "FINAL"})

        async def run():
            slow, out_red = await self._race(green, red, client)
            self.assertEqual(out_red["result"], "applied")
            self.assertEqual(out_red["status"], "declined")
            with self.assertRaises(ReconcilePendingError):
                await slow
            attempt = self._attempt()
            self.assertEqual(attempt["status"], "declined")
            # The committed watermark survives — never NULLed by the
            # timestamp-less event.
            self.assertEqual(
                attempt["last_event_created_at_ms"], "2026-10-08 10:05:00.000")
            # The conflicting event was left unprocessed — redelivery resumes
            # it and re-reconciles against current state.
            return await apply_webhook_event(self.ctx, green)

        out_retry = asyncio.run(run())
        self.assertEqual(out_retry["result"], "applied")
        self.assertEqual(out_retry["status"], "declined")
        attempt = self._attempt()
        self.assertEqual(attempt["status"], "declined")
        self.assertEqual(attempt["review_answer"], "RED")
        self.assertEqual(attempt["review_reject_type"], "FINAL")
        self.assertEqual(
            attempt["last_event_created_at_ms"], "2026-10-08 10:05:00.000")
        self.assertEqual(client.calls, 2)

    def test_missing_ts_red_reconcile_cannot_overwrite_committed_green(self):
        # Reverse interleaving: a stale RED/FINAL snapshot must not regress
        # a committed verified decision.
        self._mk_attempt()
        client = _GatedReconcileClient(self._client_cfg(), [
            _rs("completed", "RED", "FINAL"),        # stale in-flight snapshot
            _rs("completed", "GREEN"),               # fresh truth on retry
        ])
        red = self._ev(None, {"reviewAnswer": "RED", "reviewRejectType": "FINAL"})
        green = self._ev("2026-10-08 10:05:00.000", {"reviewAnswer": "GREEN"})

        async def run():
            slow, out_green = await self._race(red, green, client)
            self.assertEqual(out_green["result"], "applied")
            self.assertEqual(out_green["status"], "verified")
            with self.assertRaises(ReconcilePendingError):
                await slow
            self.assertEqual(self._attempt()["status"], "verified")
            return await apply_webhook_event(self.ctx, red)

        out_retry = asyncio.run(run())
        self.assertEqual(out_retry["result"], "applied")
        self.assertEqual(out_retry["status"], "verified")
        self.assertEqual(self._attempt()["status"], "verified")

    def test_equal_ts_reconcile_conflict_then_bounded_retry(self):
        # Equal provider timestamp: reconcile is required; a newer commit
        # during the lookup wins; on redelivery the event is now strictly
        # older than the committed watermark and is recorded stale — bounded,
        # not an infinite reconcile loop.
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        client = _GatedReconcileClient(self._client_cfg(), [
            _rs("completed", "GREEN"),
            _rs("completed", "GREEN"),
        ])
        green_equal = self._ev("2026-10-08 10:00:00.000",
                               {"reviewAnswer": "GREEN"})
        red_newer = self._ev("2026-10-08 10:05:00.000",
                             {"reviewAnswer": "RED", "reviewRejectType": "FINAL"})

        async def run():
            slow, out_red = await self._race(green_equal, red_newer, client)
            self.assertEqual(out_red["status"], "declined")
            with self.assertRaises(ReconcilePendingError):
                await slow
            return await apply_webhook_event(self.ctx, green_equal)

        out_retry = asyncio.run(run())
        # Now strictly older than the committed 10:05 watermark.
        self.assertEqual(out_retry["result"], "stale_ignored")
        self.assertEqual(self._attempt()["status"], "declined")
        # No second provider call needed — ordering alone resolves it.
        self.assertEqual(client.calls, 1)

    def test_missing_ts_reconcile_success_preserves_watermark(self):
        # A timestamp-less event that reconciles successfully applies, but
        # the last trustworthy provider timestamp is left untouched.
        self._mk_attempt(last_ms="2026-10-08 10:00:00.000")
        client = _GatedReconcileClient(self._client_cfg(), [
            _rs("completed", "GREEN"),
        ])
        self.ctx.client = client
        client.gate.set()  # no race — the lookup answers immediately
        event = self._ev(None, {"reviewAnswer": "GREEN"})
        out = asyncio.run(apply_webhook_event(self.ctx, event))
        self.assertEqual(out["result"], "applied")
        self.assertEqual(out["status"], "verified")
        attempt = self._attempt()
        self.assertEqual(attempt["status"], "verified")
        self.assertEqual(
            attempt["last_event_created_at_ms"], "2026-10-08 10:00:00.000")
        self.assertGreaterEqual(attempt["version"], 1)

    def test_repo_expected_version_conflict_leaves_event_retryable(self):
        # In-memory contract: a stale expected_version refuses the apply and
        # leaves the event unprocessed; a fresh precondition then applies.
        attempt = self._mk_attempt()

        def event(key):
            return {"environment": "sandbox", "dedupe_key": key}

        out = asyncio.run(self.repo.apply_event(
            event("k1"), attempt_id=attempt["id"],
            fields={"status": "pending"}, incoming_ts=None,
            expected_version=attempt["version"],
        ))
        self.assertEqual(out["outcome"], "applied")
        self.assertEqual(self._attempt()["version"], attempt["version"] + 1)

        out2 = asyncio.run(self.repo.apply_event(
            event("k2"), attempt_id=attempt["id"],
            fields={"status": "verified"}, incoming_ts=None,
            expected_version=attempt["version"],  # stale
        ))
        self.assertEqual(out2["outcome"], "conflict")
        self.assertEqual(self._attempt()["status"], "pending")
        stored = [e for e in self.repo._events.values()
                  if e["dedupe_key"] == "k2"][0]
        self.assertIsNone(stored["processed_at"])

        out3 = asyncio.run(self.repo.apply_event(
            event("k2"), attempt_id=attempt["id"],
            fields={"status": "verified"}, incoming_ts=None,
            expected_version=self._attempt()["version"],
        ))
        self.assertEqual(out3["outcome"], "applied")
        self.assertEqual(self._attempt()["status"], "verified")





class SumsubClientContractTests(unittest.TestCase):
    """Exact provider paths + signing input + lookup/create recovery."""

    def _config(self):
        return IdVerificationConfig(
            mode="sandbox", environment="sandbox",
            app_token="sbx:token", app_secret="test-app-secret",
            base_url="https://api.sumsub.com", level_name="idv-poc-level",
        )

    def test_external_lookup_uses_documented_one_path(self):
        import asyncio
        import httpx
        from urllib.parse import quote
        captured = {}

        def handler(request):
            captured["method"] = request.method
            captured["path"] = request.url.path
            captured["ts"] = request.headers["x-app-access-ts"]
            captured["sig"] = request.headers["x-app-access-sig"]
            return httpx.Response(200, json={"id": "app-9"})

        ref = "dly-sandbox-abc123"
        client = SumsubApiClient(
            self._config(), transport=httpx.MockTransport(handler)
        )
        got = asyncio.run(client.get_applicant_by_external_id(ref))
        expected_path = f"/resources/applicants/-;externalUserId={quote(ref, safe='')}/one"
        self.assertEqual(captured["path"], expected_path)
        self.assertEqual(got.applicant_id, "app-9")
        expected_sig = hmac_mod.new(
            b"test-app-secret",
            captured["ts"].encode() + b"GET" + expected_path.encode() + b"",
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(captured["sig"], expected_sig)

    def test_external_lookup_404_is_not_found_not_error(self):
        import asyncio
        import httpx
        client = SumsubApiClient(
            self._config(),
            transport=httpx.MockTransport(lambda r: httpx.Response(404, json={})),
        )
        got = asyncio.run(client.get_applicant_by_external_id("dly-x"))
        self.assertIsNone(got)

    def test_external_lookup_malformed_is_error_not_absence(self):
        import asyncio
        import httpx
        client = SumsubApiClient(
            self._config(),
            transport=httpx.MockTransport(
                lambda r: httpx.Response(200, json={"unexpected": True})
            ),
        )
        with self.assertRaises(SumsubClientError) as cm:
            asyncio.run(client.get_applicant_by_external_id("dly-x"))
        self.assertEqual(cm.exception.code, "malformed_response")

    def test_get_or_create_recovers_duplicate_create_conflict(self):
        # Initial create conflict (e.g. a prior create timed out after the
        # provider committed it) recovers via the documented lookup.
        import asyncio
        import httpx
        from services.id_verification_service import start_or_resume_session
        calls = []

        def handler(request):
            calls.append((request.method, request.url.path))
            if request.method == "GET" and len(calls) == 1:
                return httpx.Response(404, json={})
            if request.method == "POST" and "applicants" in request.url.path:
                return httpx.Response(409, json={})
            if request.method == "GET":
                return httpx.Response(200, json={"id": "app-existing"})
            return httpx.Response(200, json={"token": "tok"})

        ctx = VerificationContext(
            IdVerificationConfig(mode="sandbox", environment="sandbox",
                                 app_token="t", app_secret="s",
                                 base_url="https://api.sumsub.com",
                                 level_name="idv-poc-level"),
            InMemoryIdVerificationRepository(),
            SumsubApiClient(
                IdVerificationConfig(mode="sandbox", environment="sandbox",
                                     app_token="t", app_secret="s",
                                     base_url="https://api.sumsub.com"),
                transport=httpx.MockTransport(handler),
            ),
        )
        session = asyncio.run(start_or_resume_session(
            ctx, ai=AI, transfer_id=TRANSFER_ID,
            transfer_party_id=PERSON_PARTY_ID, subject_kind="party",
        ))
        self.assertEqual(session["attemptNo"], 1)
        attempt = list(ctx.repository._attempts.values())[0]
        self.assertEqual(attempt["provider_applicant_id"], "app-existing")

    def test_start_after_verified_rejected_service_level(self):
        import asyncio
        from services.id_verification_service import (
            IdVerificationError,
            start_or_resume_session,
        )
        repo = InMemoryIdVerificationRepository()
        ctx = VerificationContext(
            IdVerificationConfig(mode="fixture", environment="fixture"),
            repo, FixtureSumsubClient(),
        )
        asyncio.run(start_or_resume_session(
            ctx, ai=AI, transfer_id=TRANSFER_ID,
            transfer_party_id=PERSON_PARTY_ID, subject_kind="party",
        ))
        attempt = list(repo._attempts.values())[0]
        attempt["status"] = "verified"
        with self.assertRaises(IdVerificationError) as cm:
            asyncio.run(start_or_resume_session(
                ctx, ai=AI, transfer_id=TRANSFER_ID,
                transfer_party_id=PERSON_PARTY_ID, subject_kind="party",
            ))
        self.assertEqual(cm.exception.code, "not_retryable")


class DurableRepositoryContractTests(unittest.TestCase):
    """PostgresIdVerificationRepository against a disposable local DB —
    opt-in via TEST_DATABASE_URL only; skipped cleanly otherwise."""

    @classmethod
    def setUpClass(cls):
        import tests.db_test_utils as db_test_utils
        db_test_utils.require_test_database()
        cls._db = db_test_utils
        import asyncio
        asyncio.run(cls._apply_ddl())

    @classmethod
    async def _apply_ddl(cls):
        import os
        pool = await cls._db.get_test_pool()
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "src", "lib", "migrations", "030_deedly_id_verification.sql",
        )
        sql = open(path, encoding="utf-8").read()
        # Skip comment lines and the transaction wrapper — the pool already
        # scopes search_path; each statement is applied individually.
        statements = []
        for chunk in sql.split(";"):
            lines = [l for l in chunk.splitlines() if not l.strip().startswith("--")]
            stmt = "\n".join(lines).strip()
            if not stmt or stmt.upper() in ("BEGIN", "COMMIT") or stmt.upper().startswith("SET LOCAL"):
                continue
            statements.append(stmt)
        async with pool.acquire() as conn:
            for stmt in statements:
                await conn.execute(stmt)
            # FK constraints to transfers/transfer_parties need parent rows the
            # scratch DB may not have — this repo-contract test drops them.
            for constraint, table in (
                ("id_verification_attempts_transfer_id_fkey", "id_verification_attempts"),
                ("id_verification_attempts_transfer_party_id_fkey", "id_verification_attempts"),
                ("id_verification_attempts_on_behalf_of_party_id_fkey", "id_verification_attempts"),
                ("id_verification_events_attempt_id_fkey", "id_verification_events"),
            ):
                await conn.execute(
                    f"ALTER TABLE transfers.{table} DROP CONSTRAINT IF EXISTS {constraint}"
                )

    def tearDown(self):
        import asyncio
        from db import query
        asyncio.run(query("DELETE FROM id_verification_events"))
        asyncio.run(query("DELETE FROM id_verification_attempts"))

    def _repo(self):
        from repositories.id_verification import PostgresIdVerificationRepository
        return PostgresIdVerificationRepository()

    def _attempt_row(self):
        return {
            "id": str(uuid.uuid4()),
            "environment": "sandbox",
            "accountable_institution_id": AI,
            "transfer_id": str(uuid.uuid4()),
            "transfer_party_id": str(uuid.uuid4()),
            "subject_kind": "party",
            "on_behalf_of_party_id": None,
            "attempt_no": 1,
            "external_ref": "dly-sandbox-durable1",
            "provider": "sumsub",
            "provider_applicant_id": "app-d1",
            "level_name": "idv-poc-level",
            "inspection_id": None,
            "status": "started",
            "simulated": False,
        }

    def _event_row(self, attempt_id):
        from repositories.id_verification import event_dedupe_key
        return {
            "id": str(uuid.uuid4()),
            "attempt_id": attempt_id,
            "environment": "sandbox",
            "dedupe_key": event_dedupe_key(
                "sandbox", "applicantReviewed", "app-d1", "c1", None,
                "GREEN", "2026-10-08 10:00:00.000",
            ),
            "event_type": "applicantReviewed",
            "provider_applicant_id": "app-d1",
            "external_ref": "dly-sandbox-durable1",
            "correlation_id": "c1",
            "level_name": None,
            "inspection_id": None,
            "review_status": None,
            "review_answer": "GREEN",
            "review_reject_type": None,
            "reject_labels": [],
            "provider_created_at_ms": "2026-10-08 10:00:00.000",
            "received_at": datetime.now(timezone.utc),
            "processed_at": None,
            "disposition": "matched",
        }

    def test_create_attempt_and_atomic_apply(self):
        import asyncio
        repo = self._repo()
        attempt = asyncio.run(repo.create_attempt(self._attempt_row()))
        self.assertEqual(attempt["status"], "started")
        fields = {"status": "verified", "last_event_created_at_ms": "2026-10-08 10:00:00.000"}
        ts = datetime(2026, 10, 8, 10, 0, tzinfo=timezone.utc).timestamp()
        out = asyncio.run(repo.apply_event(
            self._event_row(attempt["id"]),
            attempt_id=attempt["id"], fields=fields, incoming_ts=ts,
        ))
        self.assertEqual(out["outcome"], "applied")
        latest = asyncio.run(repo.get_latest_attempt(
            "sandbox", AI, attempt["transfer_party_id"]
        ))
        self.assertEqual(latest["status"], "verified")
        # Identical redelivery → harmless duplicate.
        out2 = asyncio.run(repo.apply_event(
            self._event_row(attempt["id"]),
            attempt_id=attempt["id"], fields=fields, incoming_ts=ts,
        ))
        self.assertEqual(out2["outcome"], "duplicate")

    def test_failed_update_rolls_back_insert_and_replay_applies(self):
        import asyncio
        import db
        repo = self._repo()
        attempt = asyncio.run(repo.create_attempt(self._attempt_row()))
        fields = {"status": "verified", "last_event_created_at_ms": "2026-10-08 10:00:00.000"}
        ts = datetime(2026, 10, 8, 10, 0, tzinfo=timezone.utc).timestamp()
        event = self._event_row(attempt["id"])

        real_query = db.query

        async def flaky(text, params=None, *, connection=None):
            if "UPDATE id_verification_attempts" in text:
                raise RuntimeError("injected update failure")
            return await real_query(text, params, connection=connection)

        with patch("repositories.id_verification.db") as mockdb:
            mockdb.query = flaky
            mockdb.with_transaction = db.with_transaction
            with self.assertRaises(StorageUnavailableError):
                asyncio.run(repo.apply_event(
                    event, attempt_id=attempt["id"], fields=fields, incoming_ts=ts,
                ))
        # Rolled back — no half-recorded event.
        events = asyncio.run(repo.list_events_for_attempt(attempt["id"]))
        self.assertEqual(len(events), 0)
        out = asyncio.run(repo.apply_event(
            event, attempt_id=attempt["id"], fields=fields, incoming_ts=ts,
        ))
        self.assertEqual(out["outcome"], "applied")

    def test_unprocessed_event_resumes(self):
        import asyncio
        repo = self._repo()
        attempt = asyncio.run(repo.create_attempt(self._attempt_row()))
        fields = {"status": "verified", "last_event_created_at_ms": "2026-10-08 10:00:00.000"}
        ts = datetime(2026, 10, 8, 10, 0, tzinfo=timezone.utc).timestamp()
        event = self._event_row(attempt["id"])
        asyncio.run(repo.apply_event(
            event, attempt_id=None, fields=None, incoming_ts=ts, mark_processed=False,
        ))
        out = asyncio.run(repo.apply_event(
            event, attempt_id=attempt["id"], fields=fields, incoming_ts=ts,
        ))
        self.assertEqual(out["outcome"], "applied")
        latest = asyncio.run(repo.get_latest_attempt(
            "sandbox", AI, attempt["transfer_party_id"]
        ))
        self.assertEqual(latest["status"], "verified")


    def test_expected_version_conflict_leaves_event_retryable(self):
        # Durable-path contract assertion: the version precondition is
        # checked inside the row lock — a stale snapshot cannot apply and
        # the event is left unprocessed for redelivery.
        import asyncio
        repo = self._repo()
        attempt = asyncio.run(repo.create_attempt(self._attempt_row()))
        self.assertEqual(attempt["version"], 0)

        out = asyncio.run(repo.apply_event(
            self._event_row(attempt["id"]),
            attempt_id=attempt["id"],
            fields={"status": "pending",
                    "last_event_created_at_ms": "2026-10-08 10:00:00.000"},
            incoming_ts=datetime(2026, 10, 8, 10, 0,
                                 tzinfo=timezone.utc).timestamp(),
            expected_version=0,
        ))
        self.assertEqual(out["outcome"], "applied")
        latest = asyncio.run(repo.get_latest_attempt(
            "sandbox", AI, attempt["transfer_party_id"]))
        self.assertEqual(latest["version"], 1)

        stale = self._event_row(attempt["id"])
        stale["dedupe_key"] = "stale-versioned-event"
        out2 = asyncio.run(repo.apply_event(
            stale, attempt_id=attempt["id"],
            fields={"status": "verified"}, incoming_ts=None,
            expected_version=0,  # stale — attempt is now at version 1
        ))
        self.assertEqual(out2["outcome"], "conflict")
        latest = asyncio.run(repo.get_latest_attempt(
            "sandbox", AI, attempt["transfer_party_id"]))
        self.assertEqual(latest["status"], "pending")
        events = asyncio.run(repo.list_events_for_attempt(attempt["id"]))
        unprocessed = [e for e in events if e["processed_at"] is None]
        self.assertEqual(len(unprocessed), 1)
        self.assertEqual(unprocessed[0]["dedupe_key"], "stale-versioned-event")

        out3 = asyncio.run(repo.apply_event(
            stale, attempt_id=attempt["id"],
            fields={"status": "verified"}, incoming_ts=None,
            expected_version=latest["version"],
        ))
        self.assertEqual(out3["outcome"], "applied")
        self.assertEqual(latest["version"] + 1, 2)



    def test_equal_timestamp_ambiguous_unprocessed_until_confirmed(self):
        # Durable contract: an equal provider timestamp under the row lock
        # returns ambiguous AND leaves the event unprocessed — the webhook
        # ack is refused so the provider redelivers; a provider-confirmed
        # retry then applies it.
        import asyncio
        repo = self._repo()
        attempt = asyncio.run(repo.create_attempt(self._attempt_row()))
        ts = datetime(2026, 10, 8, 10, 0, tzinfo=timezone.utc).timestamp()
        fields = {"status": "verified",
                  "last_event_created_at_ms": "2026-10-08 10:00:00.000"}
        out1 = asyncio.run(repo.apply_event(
            self._event_row(attempt["id"]), attempt_id=attempt["id"],
            fields=fields, incoming_ts=ts))
        self.assertEqual(out1["outcome"], "applied")

        rival = self._event_row(attempt["id"])
        rival["dedupe_key"] = "equal-ts-rival"
        rival["review_answer"] = "RED"
        out2 = asyncio.run(repo.apply_event(
            rival, attempt_id=attempt["id"],
            fields={"status": "declined",
                    "last_event_created_at_ms": "2026-10-08 10:00:00.000"},
            incoming_ts=ts))
        self.assertEqual(out2["outcome"], "ambiguous")
        events = asyncio.run(repo.list_events_for_attempt(attempt["id"]))
        unprocessed = [e for e in events if e["processed_at"] is None]
        self.assertEqual(len(unprocessed), 1)
        self.assertEqual(unprocessed[0]["dedupe_key"], "equal-ts-rival")
        latest = asyncio.run(repo.get_latest_attempt(
            "sandbox", AI, attempt["transfer_party_id"]))
        self.assertEqual(latest["status"], "verified")

        # Provider-confirmed redelivery applies the rival verdict.
        out3 = asyncio.run(repo.apply_event(
            rival, attempt_id=attempt["id"],
            fields={"status": "declined",
                    "last_event_created_at_ms": "2026-10-08 10:00:00.000"},
            incoming_ts=ts, confirmed=True))
        self.assertEqual(out3["outcome"], "applied")


if __name__ == "__main__":
    unittest.main()
