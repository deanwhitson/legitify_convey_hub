"""Offline Veriff contract/security tests. All HTTP uses MockTransport."""
import asyncio
import copy
import hashlib
import hmac
import json
import unittest
from datetime import date
from dataclasses import replace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from clients.veriff_client import VeriffClient, VeriffClientError, VeriffConfig, load_veriff_config, valid_veriff_url
from services.veriff_verification import VeriffContext, fingerprint, map_decision
from services.id_verification_service import IdVerificationError, ProviderUnavailableError
from repositories.veriff_verification import VeriffRepository, VeriffStorageError
from tests.test_id_verification import AI, TRANSFER_ID, PERSON_PARTY_ID, COMPANY_PARTY_ID, _auth, _fake_query
from main import app

PARTY = {"party_source": "manual", "manual_name": "Ada Example", "manual_id_type": "passport",
         "manual_id_number": "SYNTHETIC123", "manual_passport_country": "DE", "entity_type": "person"}
CONFIG = VeriffConfig("test", "https://api-saas.veriff.com", "synthetic-key", "synthetic-secret", Fernet.generate_key().decode())
SID = str(uuid4())


def attempt():
    return {"id": str(uuid4()), "session_id": SID, "external_ref": "dly-synthetic",
            "subject_fingerprint": fingerprint(PARTY), "status": "started", "attempt_no": 1,
            "creation_state": "ready", "integration_scope": CONFIG.scope, "version": 1,
            "accountable_institution_id": AI, "transfer_id": TRANSFER_ID,
            "transfer_party_id": PERSON_PARTY_ID, "subject_kind": "party", "on_behalf_of_party_id": None,
            "capture_url_encrypted": Fernet(CONFIG.encryption_key.encode()).encrypt(b"https://alchemy.veriff.com/v/synthetic").decode()}


def decision(row, *, code=9001, status="approved", expiry="2035-01-01"):
    return {"status": "success", "verification": {"id": row["session_id"], "code": code, "status": status,
        "vendorData": row["external_ref"], "endUserId": row["id"], "reasonCode": None,
        "person": {"firstName": "Ada", "lastName": "Example"},
        "document": {"type": "PASSPORT", "validUntil": expiry, "country": "DE", "number": "SYNTHETIC123"}}}


class MappingTests(unittest.TestCase):
    def setUp(self):
        self.row = attempt()

    def mapped(self, payload):
        return map_decision(payload, self.row, PARTY, today=date(2026, 10, 13))

    def test_approved_current_matching_passport(self):
        result = self.mapped(decision(self.row))
        self.assertEqual(result["status"], "verified")
        text = json.dumps(result)
        self.assertNotIn("SYNTHETIC123", text)
        self.assertNotIn("Ada", text)
        self.assertEqual(result["checks"][-1]["state"], "unavailable")

    def test_expired_passport_never_verified_even_if_provider_approved(self):
        self.assertEqual(self.mapped(decision(self.row, expiry="2025-01-01"))["status"], "review_required")

    def test_declined_expired_passport(self):
        self.assertEqual(self.mapped(decision(self.row, code=9102, status="declined", expiry="2025-01-01"))["status"], "declined")

    def test_incomplete_or_wrong_document(self):
        for key, value in [("type", "ID_CARD"), ("validUntil", None), ("number", "DIFFERENT"), ("country", "ZA")]:
            with self.subTest(key=key):
                payload = decision(self.row)
                payload["verification"]["document"][key] = value
                self.assertEqual(self.mapped(payload)["status"], "review_required")

    def test_other_person_and_changed_saved_subject(self):
        payload = decision(self.row)
        payload["verification"]["person"]["firstName"] = "Other"
        self.assertEqual(self.mapped(payload)["status"], "review_required")
        changed = {**PARTY, "manual_name": "Another Example"}
        self.assertEqual(map_decision(decision(self.row), self.row, changed)["status"], "review_required")

    def test_name_only_is_not_sufficient_to_bind_a_passport(self):
        for field in ("manual_id_number", "manual_passport_country"):
            party = {**PARTY, field: None}
            row = {**self.row, "subject_fingerprint": fingerprint(party)}
            self.assertEqual(map_decision(decision(row), row, party)["status"], "review_required")

    def test_signed_identifier_binding_required(self):
        for key in ("id", "vendorData", "endUserId"):
            payload = decision(self.row)
            payload["verification"][key] = "different"
            with self.assertRaises(ProviderUnavailableError):
                self.mapped(payload)

    def test_pending_unknown_and_contradictory_codes(self):
        self.assertEqual(self.mapped({"verification": None})["status"], "pending")
        for code, status in [(9999, "approved"), (9001, "declined"), ({}, "approved"), ("9001", "approved")]:
            self.assertEqual(self.mapped(decision(self.row, code=code, status=status))["status"], "review_required")

    def test_retry_codes(self):
        for code, status in [(9103,"resubmission_requested"), (9104,"expired"), (9121,"abandoned")]:
            self.assertEqual(self.mapped(decision(self.row, code=code, status=status))["status"], "retry_requested")


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_payload_and_no_secret_in_body(self):
        seen = []
        def handler(req):
            seen.append(req)
            return httpx.Response(201, json={"status":"success", "verification":{"id":SID,"url":"https://alchemy.veriff.com/v/synthetic"}})
        client = VeriffClient(CONFIG, transport=httpx.MockTransport(handler))
        try:
            await client.create_session("dly-opaque", str(uuid4()))
        finally:
            await client.aclose()
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].headers["x-auth-client"], "synthetic-key")
        self.assertEqual(json.loads(seen[0].content)["verification"]["document"], {"type":"PASSPORT"})
        self.assertNotIn(b"synthetic-secret", seen[0].content)

    async def test_get_signs_uuid_and_verifies_original_response_bytes(self):
        raw = b'{ "status": "success", "verification": null }'
        def handler(req):
            self.assertEqual(req.headers["x-hmac-signature"], hmac.new(b"synthetic-secret", SID.encode(), hashlib.sha256).hexdigest())
            return httpx.Response(200, content=raw, headers={"X-HMAC-SIGNATURE": hmac.new(b"synthetic-secret", raw, hashlib.sha256).hexdigest()})
        client = VeriffClient(CONFIG, transport=httpx.MockTransport(handler))
        try:
            self.assertIsNone((await client.decision(SID))["verification"])
        finally:
            await client.aclose()

    async def test_bad_missing_or_reserialized_signatures_rejected(self):
        raw = b'{ "status": "success", "verification": null }'
        wrong = hmac.new(b"synthetic-secret", json.dumps(json.loads(raw)).encode(), hashlib.sha256).hexdigest()
        for sig in (None, "0" * 64, "bad", wrong):
            with self.subTest(sig=sig):
                client = VeriffClient(CONFIG, transport=httpx.MockTransport(lambda r: httpx.Response(200, content=raw, headers={"X-HMAC-SIGNATURE":sig} if sig else {})))
                try:
                    with self.assertRaises(VeriffClientError):
                        await client.decision(SID)
                finally:
                    await client.aclose()

    async def test_failed_post_is_not_retried_and_error_is_sanitised(self):
        calls = []
        def handler(req):
            calls.append(req)
            raise httpx.ReadTimeout("sensitive provider detail", request=req)
        client = VeriffClient(CONFIG, transport=httpx.MockTransport(handler))
        try:
            with self.assertRaises(VeriffClientError) as caught:
                await client.create_session("opaque", str(uuid4()))
            self.assertEqual(str(caught.exception), "Veriff request failed")
            self.assertEqual(len(calls), 1)
        finally:
            await client.aclose()

    def test_urls_config_and_repr(self):
        for value in ("http://api.veriff.com", "https://veriff.com.evil.test", "https://evil.test", "https://user:password@api.veriff.com", "https://api.veriff.com:444"):
            self.assertFalse(valid_veriff_url(value))
        self.assertTrue(valid_veriff_url(CONFIG.base_url))
        for key in ("synthetic-key", "synthetic-secret", CONFIG.encryption_key):
            self.assertNotIn(key, repr(CONFIG))
        with self.assertRaises(ValueError):
            load_veriff_config({"VERIFF_MODE":"trial"})


class FakeRepository:
    """Test seam only. Production context always constructs VeriffRepository."""
    def __init__(self):
        self.row = None
        self.party = copy.deepcopy(PARTY)
        self.lock = asyncio.Lock()
    async def reserve(self, scope, mode, ai, transfer_id, party_id, kind, target, retry=False):
        async with self.lock:
            if self.row:
                return copy.deepcopy(self.row), False
            self.row = attempt()
            self.row.update(session_id=None, capture_url_encrypted=None, creation_state="creating", version=0)
            return copy.deepcopy(self.row), True
    async def bind(self, id, sid, url):
        self.row.update(session_id=sid,capture_url_encrypted=url,creation_state="ready",version=1)
        return copy.deepcopy(self.row)
    async def creation_failed(self, id):
        self.row["creation_state"] = "uncertain"
    async def latest(self, scope, ai, party_id):
        return copy.deepcopy(self.row), copy.deepcopy(self.party)
    async def apply(self, row, summary):
        self.row.update(status=summary["status"], summary=summary, version=self.row["version"]+1)
        return copy.deepcopy(self.row)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_resumed_session_reuses_provider_call_and_encrypted_url(self):
        repo = FakeRepository()
        client = AsyncMock()
        client.create_session.return_value = {"id":SID,"url":"https://alchemy.veriff.com/v/synthetic"}
        ctx = VeriffContext(CONFIG, repo, client)
        args = dict(ai=AI,transfer_id=TRANSFER_ID,transfer_party_id=PERSON_PARTY_ID,subject_kind="party")
        first = await ctx.start(**args)
        second = await ctx.start(**args)
        self.assertFalse(first["resumed"])
        self.assertTrue(second["resumed"])
        self.assertEqual(client.create_session.await_count, 1)
        self.assertNotIn("https://", repo.row["capture_url_encrypted"])
        self.assertTrue(first["simulated"])
        self.assertEqual(first["provider"], "veriff")

    async def test_uncertain_create_blocks_further_chargeable_calls(self):
        repo = FakeRepository()
        client = AsyncMock()
        client.create_session.side_effect = VeriffClientError()
        ctx = VeriffContext(CONFIG, repo, client)
        args = dict(ai=AI,transfer_id=TRANSFER_ID,transfer_party_id=PERSON_PARTY_ID,subject_kind="party")
        with self.assertRaises(ProviderUnavailableError):
            await ctx.start(**args)
        with self.assertRaises(IdVerificationError) as caught:
            await ctx.start(**args)
        self.assertEqual(caught.exception.code, "creation_unresolved")
        self.assertEqual(client.create_session.await_count, 1)

    async def test_no_provider_write_when_storage_fails(self):
        repo, client = AsyncMock(), AsyncMock()
        repo.reserve.side_effect = VeriffStorageError()
        ctx = VeriffContext(CONFIG, repo, client)
        with self.assertRaises(VeriffStorageError):
            await ctx.start(ai=AI, transfer_id=TRANSFER_ID, transfer_party_id=PERSON_PARTY_ID,subject_kind="party")
        client.create_session.assert_not_awaited()

    async def test_production_repository_missing_storage_fails_closed(self):
        repo = VeriffRepository()
        with patch("db.query", side_effect=RuntimeError("sensitive SQL")), patch("db.with_transaction", side_effect=RuntimeError("sensitive DSN")):
            with self.assertRaises(VeriffStorageError) as caught:
                await repo.reserve(CONFIG.scope, "test", AI, TRANSFER_ID, PERSON_PARTY_ID, "party", None)
            self.assertEqual(str(caught.exception), "storage_unavailable")

    async def test_binding_rechecks_ownership_after_provider_returns(self):
        row = attempt()
        queries = []
        async def transaction(work):
            return await work(object())
        async def query(sql, params, connection=None):
            queries.append(sql)
            rows = [row] if "FROM veriff_verifications" in sql else []
            return type("Result", (), {"rows": rows})()
        with patch("db.query",side_effect=query),patch("db.with_transaction",side_effect=transaction):
            with self.assertRaises(IdVerificationError):
                await VeriffRepository().bind(row["id"],SID,"encrypted")
        self.assertFalse(any("UPDATE" in sql for sql in queries))


class RouteTests(unittest.TestCase):
    def setUp(self):
        import os
        from tests.test_id_verification import TEST_JWT_SECRET
        self.env = patch.dict(os.environ,{"JWT_SECRET":TEST_JWT_SECRET})
        self.env.start()
        self.patches = [patch("main.get_pool",new_callable=AsyncMock),patch("main.close_pool",new_callable=AsyncMock),
            patch("main.EntitiesClient",return_value=AsyncMock()),patch("routers.v1.id_verification.query",side_effect=_fake_query)]
        for p in self.patches: p.start()
        self.repo = FakeRepository()
        self.provider = AsyncMock()
        self.provider.create_session.return_value = {"id":SID,"url":"https://alchemy.veriff.com/v/synthetic"}
        self.ctx = VeriffContext(CONFIG,self.repo,self.provider)
        self.http = TestClient(app).__enter__()
        app.state.id_verification_context = self.ctx
    def tearDown(self):
        self.http.__exit__(None,None,None)
        for p in reversed(self.patches): p.stop()
        if hasattr(app.state,"id_verification_context"): del app.state.id_verification_context
        self.env.stop()
    def path(self,suffix="",party=PERSON_PARTY_ID):
        return f"/api/v1/transfers/{TRANSFER_ID}/parties/{party}/id-verification{suffix}"

    def test_real_routes_create_capture_and_retrieve_provider_outcome(self):
        r = self.http.post(self.path("/session"),headers=_auth(),json={})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()["data"]["provider"],"veriff")
        self.provider.decision.return_value = decision(self.repo.row)
        r = self.http.get(self.path(),headers=_auth())
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()["data"]["status"],"verified")
        self.assertTrue(r.json()["data"]["simulated"])
        self.assertEqual(r.headers["cache-control"],"no-store")

    def test_unauthorised_tenant_client_company_and_payload_rejected_before_provider(self):
        cases = [({},self.path("/session"),{},401),(_auth(ai=99),self.path("/session"),{},404),
                 (_auth(role=4),self.path("/session"),{},403),(_auth(),self.path("/session",party=COMPANY_PARTY_ID),{},422),
                 (_auth(),self.path("/session"),{"sessionId":SID},422)]
        for headers,path,body,status in cases:
            with self.subTest(status=status):
                self.assertEqual(self.http.post(path,headers=headers,json=body).status_code,status)
        self.provider.create_session.assert_not_awaited()

    def test_signed_retrieval_failure_is_technical_unavailable_not_decline(self):
        self.http.post(self.path("/session"),headers=_auth(),json={})
        self.provider.decision.side_effect = VeriffClientError()
        r = self.http.get(self.path(),headers=_auth())
        self.assertEqual(r.status_code,503,r.text)
        self.assertEqual(r.json()["error"],"provider_unavailable")
        self.assertEqual(self.repo.row["status"],"started")

    def test_missing_configuration_never_falls_back_to_sumsub(self):
        app.state.id_verification_context = None
        app.state.settings = replace(app.state.settings, idv_provider="veriff", veriff_mode="trial")
        r = self.http.get(self.path(),headers=_auth())
        self.assertEqual(r.status_code,503,r.text)
        self.assertEqual(r.json()["error"],"configuration_unavailable")
