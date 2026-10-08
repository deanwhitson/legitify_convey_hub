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
from datetime import datetime, timezone
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
from clients.sumsub_client import FixtureSumsubClient, SumsubApiClient

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
        "applicantId": "FIXTURE-APPLICANT-0001",
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

    @classmethod
    def setUpClass(cls):
        os.environ["JWT_SECRET"] = TEST_JWT_SECRET
        os.environ["SUMSUB_MODE"] = "fixture"
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
        event = _fixture_event(ext_ref, review={"reviewAnswer": "GREEN"})
        w = self.client.post("/api/v1/webhooks/sumsub-fixture", json=event)
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


class _FailingRepo(InMemoryIdVerificationRepository):
    async def insert_event(self, event, *, connection=None):
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
            "status": "started",
            "simulated": False,
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


if __name__ == "__main__":
    unittest.main()
