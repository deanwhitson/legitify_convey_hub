import importlib
import io
import re
import time
import unittest
from contextlib import ExitStack, redirect_stderr
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import jwt

import db
from main import app
from routers.v1 import transfers

SECRET = "ai-security-tests-only-32-byte-secret"
GR = "11111111-1111-4111-8111-111111111111"
OWN = "22222222-2222-4222-8222-222222222222"
FOREIGN = "33333333-3333-4333-8333-333333333333"
PARTY = "44444444-4444-4444-8444-444444444444"
OTHER_PARTY = "55555555-5555-4555-8555-555555555555"
MARKER = "private-security-fixture-not-for-response-or-logs"
LEGACY_MODULES = (
    "transfers", "milestones", "documents", "generated_documents", "users",
    "document_catalogue", "clauses", "template_data_fields", "address",
)
LEGACY_PREFIXES = (
    "/api/transfers", "/api/documents", "/api/generated-documents", "/api/users",
    "/api/catalogue", "/api/clauses", "/api/data-fields", "/api/address",
)


def token(*, role=3, ai=5, omit=(), **overrides):
    payload = {
        "type": "access", "user_id": 123, "golden_record_id": GR,
        "abilities": ["transfers:read", "transfers:write"],
        "accountable_institution_id": ai, "user_roles_id": role,
        "exp": int(time.time()) + 3600,
    }
    payload.update(overrides)
    for field in omit:
        payload.pop(field, None)
    return jwt.encode(payload, SECRET, algorithm="HS256")


def headers(**claims):
    return {"Authorization": f"Bearer {token(**claims)}"}


def transfer_row(identifier, ai):
    return {
        "id": identifier, "transfer_id": f"TX-{ai}", "accountable_institution_id": ai,
        "property_address": f"Institution {ai} address", "purchase_price": 100,
        "status": "in_progress", "current_step": 1, "total_steps": 5,
        "progress": 0, "created_at": "2026-01-01", "updated_at": "2026-01-01",
    }


class InstitutionBoundaryRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(app.state, "settings", SimpleNamespace(
            jwt_secret=SECRET, secret_key="test-service-key", node_env="development",
        ), create=True))
        self.entities = SimpleNamespace(
            search_entities=AsyncMock(side_effect=AssertionError("Unexpected Entities search")),
            get_entity=AsyncMock(side_effect=AssertionError("Unexpected Entities retrieval")),
            get_client_by_golden_record=AsyncMock(side_effect=AssertionError("Unexpected linkage lookup")),
        )
        self.stack.enter_context(patch.object(app.state, "entities_client", self.entities, create=True))
        self.legacy_calls = []
        self.workflow_matter = "66666666-6666-4666-8666-666666666666"
        self.outbound = self.stack.enter_context(patch(
            "httpx.AsyncHTTPTransport.handle_async_request",
            AsyncMock(side_effect=AssertionError("Unexpected provider request")),
        ))
        self.stack.enter_context(patch("routers.address.LOQATE_API_KEY", "address-test-key-not-a-real-key"))

        async def legacy_database(*args, **kwargs):
            self.legacy_calls.append((args, kwargs))
            raise AssertionError("Quarantined handler reached persistence")

        for name in LEGACY_MODULES:
            module = importlib.import_module(f"routers.{name}")
            for attribute in ("query", "with_transaction"):
                if hasattr(module, attribute):
                    self.stack.enter_context(patch.object(module, attribute, AsyncMock(side_effect=legacy_database)))
        self.query = self.stack.enter_context(patch.object(transfers, "query", AsyncMock(side_effect=self.query_fixture)))

        async def transaction(callback):
            return await callback(object())

        self.tx = self.stack.enter_context(patch.object(transfers, "with_transaction", AsyncMock(side_effect=transaction)))
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test",
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_milestones_ignore_mismatched_and_duplicate_legacy_associations(self):
        self.workflow_matter = "66666666-6666-4666-8666-666666666666"
        response = await self.client.get(f"/api/v1/transfers/{OWN}/milestones", headers=headers())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([row["id"] for row in response.json()["data"]["milestones"]], [self.workflow_matter])
        for clause in ("t.matter_id = m.id", "t.id = $1", "t.accountable_institution_id = $2",
                       "m.accountable_institution_id = $2", "m.matter_type = 'transfer'"):
            self.assertIn(clause, self.workflow_sql)
        self.assertNotIn("source_record_id", self.workflow_sql)
        self.assertTrue(all(call.args[0].lstrip().startswith("SELECT") for call in self.query.await_args_list))
        self.tx.assert_not_awaited()

    async def test_milestones_never_fallback_or_repair_invalid_canonical_links(self):
        for link in (None, FOREIGN, "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"):
            self.workflow_matter = link
            response = await self.client.get(f"/api/v1/transfers/{OWN}/milestones", headers=headers())
            self.assertEqual(response.status_code, 409, response.text)
            self.assertNotIn("data", response.json())
        self.assertTrue(all(call.args[0].lstrip().startswith("SELECT") for call in self.query.await_args_list))
        self.tx.assert_not_awaited()

    async def test_milestone_read_denies_clients_and_missing_ability_before_queries(self):
        for auth, status in (({}, 401), (headers(role=4), 404), (headers(abilities=[]), 403)):
            response = await self.client.get(f"/api/v1/transfers/{OWN}/milestones", headers=auth)
            self.assertEqual(response.status_code, status)
        self.query.assert_not_awaited()

    async def query_fixture(self, text, params=None, **kwargs):
        params = params or []
        if "AS workflow_matter_id" in text:
            rows = [{"workflow_matter_id": self.workflow_matter}] if self.workflow_matter == "66666666-6666-4666-8666-666666666666" else []
            return db.QueryResult(rows=rows, row_count=len(rows))
        if "FROM transfers t" in text:
            rows = getattr(self, "list_rows", [transfer_row(OWN, 5), transfer_row(FOREIGN, 7)])
            if "t.id = $1" in text:
                rows = [row for row in rows if row["id"] == str(params[0])]
            scope = re.search(r"t\.accountable_institution_id\s*=\s*\$(\d+)", text)
            if scope:
                rows = [row for row in rows if row["accountable_institution_id"] == params[int(scope[1]) - 1]]
            if "EXISTS" in text:
                rows = [row for row in rows if str(params[1]) == GR]
            status = re.search(r"t\.status\s*=\s*\$(\d+)", text)
            if status:
                rows = [row for row in rows if row["status"] == params[int(status[1]) - 1]]
            if "FILTER" in text:
                rows = [{"total": len(rows),
                         "in_progress": sum(row["status"] == "in_progress" for row in rows),
                         "complete": sum(row["status"] == "complete" for row in rows)}]
            elif "COUNT(*)" in text:
                rows = [{"total": len(rows)}]
            else:
                pagination = re.search(r"LIMIT \$(\d+) OFFSET \$(\d+)", text)
                if pagination:
                    limit, offset = (params[int(index) - 1] for index in pagination.groups())
                    rows = rows[offset:offset + limit]
            return db.QueryResult(rows=rows, row_count=len(rows))
        if "FROM matter_milestones mm" in text:
            self.workflow_sql = text
            matters = [
                ("66666666-6666-4666-8666-666666666666", FOREIGN, 5, "transfer"),
                ("77777777-7777-4777-8777-777777777777", OWN, 5, "transfer"),
                ("88888888-8888-4888-8888-888888888888", OWN, 5, "transfer"),
                ("99999999-9999-4999-8999-999999999999", OWN, 7, "transfer"),
                ("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OWN, 5, "bond"),
            ]
            matched = [m for m in matters if (m[0] == self.workflow_matter if "t.matter_id = m.id" in text else m[1] == str(params[0]))]
            if "m.accountable_institution_id" in text:
                matched = [m for m in matched if m[2] == params[1]]
            if "m.matter_type = 'transfer'" in text:
                matched = [m for m in matched if m[3] == "transfer"]
            rows = [dict(id=m[0], matter_id=m[0], definition_id=None, code=None, definition_name=None,
                         name="Recorded milestone", status_label=None, status="not_started", sequence_number=1,
                         due_date=None, completed_date=None, notes=None, created_at=None, updated_at=None) for m in matched]
            return db.QueryResult(rows=rows, row_count=len(rows))
        if "FROM transfer_parties" in text:
            if "SELECT 1" in text:
                owner = OWN if str(params[0]) == PARTY else FOREIGN if str(params[0]) == OTHER_PARTY else None
                visible = owner == str(params[1]) and (len(params) < 3 or params[2] == (5 if owner == OWN else 7))
                return db.QueryResult(rows=[{"exists": 1}] if visible else [], row_count=int(visible))
            ai = 5 if str(params[0]) == OWN else 7
            row = {
                "id": PARTY if ai == 5 else OTHER_PARTY, "transfer_id": params[0],
                "golden_record_id": GR, "entity_type": "person", "role": "transferee",
                "accountable_institution_id": ai, "cached_name": f"Client of {ai}",
                "cached_id_number": MARKER, "cached_email": MARKER, "synced_at": "2026-01-01",
            }
            return db.QueryResult(rows=[row], row_count=1)
        if "FROM party_relationship_definitions" in text:
            return db.QueryResult(rows=[{"code": params[0]}], row_count=1)
        if "INSERT INTO party_relationship_assignments" in text:
            return db.QueryResult(rows=[{
                "id": GR, "transfer_party_id": params[0], "relationship_code": params[1],
                "created_at": "2026-01-01", "updated_at": "2026-01-01",
            }], row_count=1)
        raise AssertionError("Unexpected test query")

    async def test_all_registered_legacy_routes_are_quarantined_before_persistence(self):
        cases = [
            ({}, 401), ({"X-Service-Key": "test-service-key", "X-Accountable-Institution-Id": "5"}, 401),
            (headers(), 503), (headers(ai=1), 503), (headers(ai=7), 503),
            (headers(role=1), 503), (headers(role=5), 401), (headers(role=6), 401),
        ]
        routes = {path: operations for path, operations in app.openapi()["paths"].items()
                  if any(path.startswith(prefix) for prefix in LEGACY_PREFIXES)}
        self.assertGreater(len(routes), 20)
        for template, operations in routes.items():
            path = re.sub(r"\{[^}]+\}", OWN, template)
            for operation in operations:
                if operation not in {"get", "post", "put", "patch", "delete"}:
                    continue
                method = operation.upper()
                for authentication, expected in cases:
                    with self.subTest(path=path, method=method, expected=expected):
                        response = await self.client.request(
                            method, path, headers=authentication,
                            params={"accountable_institution_id": "7", "tenant_id": GR,
                                    "text": "Test address", "q": "Test address", "id": GR},
                            **({"json": {"accountable_institution_id": 7, "golden_record_id": GR}} if method in {"POST", "PUT", "PATCH"} else {}),
                        )
                        self.assertEqual(response.status_code, expected)
                        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(self.legacy_calls, [])
        self.outbound.assert_not_awaited()

    async def test_staff_cannot_change_institution_with_headers_or_query_parameters(self):
        authentication = {**headers(), "X-Accountable-Institution-Id": "7"}
        response = await self.client.get(
            "/api/v1/transfers/", headers=authentication, params={"accountable_institution_id": "7"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["id"] for row in response.json()["data"]["transfers"]], [OWN])
        for identifier in (FOREIGN, "not-a-uuid", "66666666-6666-4666-8666-666666666666"):
            denied = await self.client.get(f"/api/v1/transfers/{identifier}", headers=authentication)
            self.assertEqual(denied.status_code, 404)
            self.assertEqual(denied.json(), {"success": False, "error": "Not found"})

    async def test_staff_list_filters_counts_and_totals_are_tenant_scoped(self):
        self.list_rows = [
            {**transfer_row(str(uuid), ai), "status": status}
            for uuid, ai, status in (
                (1, 5, "complete"), (2, 5, "in_progress"), (3, 5, "complete"),
                (4, 7, "complete"), (5, 7, "in_progress"),
            )
        ]
        for role in (1, 2, 3):
            for status, expected_total, expected_ids in (
                (None, 3, ["2"]), ("complete", 2, ["3"]), ("in_progress", 1, []),
            ):
                with self.subTest(role=role, status=status):
                    self.query.reset_mock()
                    params = {"page": 2, "limit": 1, "accountable_institution_id": 7}
                    if status is not None:
                        params["status"] = status
                    response = await self.client.get(
                        "/api/v1/transfers/", params=params,
                        headers={**headers(role=role), "X-Accountable-Institution-Id": "7"},
                    )
                    self.assertEqual(response.status_code, 200)
                    data = response.json()["data"]
                    self.assertEqual([row["id"] for row in data["transfers"]], expected_ids)
                    self.assertEqual(data["pagination"], {
                        "page": 2, "limit": 1, "total": expected_total, "totalPages": expected_total,
                    })
                    self.assertEqual(data["statusTotals"], {"total": 3, "inProgress": 1, "completed": 2})
                    count, page, totals = self.query.await_args_list
                    expected_params = [5] if status is None else [5, status]
                    self.assertEqual(count.args[1], expected_params)
                    self.assertEqual(page.args[1], [*expected_params, 1, 1])
                    self.assertEqual(totals.args[1], [5])
                    predicate = "WHERE t.accountable_institution_id = $1"
                    if status is not None:
                        predicate += " AND t.status = $2"
                    self.assertIn(predicate, count.args[0])
                    self.assertIn(predicate, page.args[0])
                    self.assertIn("t.id ASC", page.args[0])
                    self.assertNotIn("t.status = $", totals.args[0])
        response = await self.client.get("/api/v1/transfers/?status=complete", headers=headers(ai=7))
        data = response.json()["data"]
        self.assertEqual([row["id"] for row in data["transfers"]], ["4"])
        self.assertEqual(data["pagination"]["total"], 1)
        self.assertEqual(data["statusTotals"], {"total": 2, "inProgress": 1, "completed": 1})

    async def test_staff_list_rejects_invalid_and_repeated_status_before_queries(self):
        for query in ("status=", "status=draft", "status=completed", "status=cancelled",
                      "status=all", "status=COMPLETE", "status=complete%27%20OR%201=1",
                      "status=complete?legacy", "status=complete%3Flegacy",
                      "status=complete&status=in_progress"):
            with self.subTest(query=query):
                response = await self.client.get(f"/api/v1/transfers/?{query}", headers=headers())
                self.assertEqual(response.status_code, 422)
        self.query.assert_not_awaited()

    async def test_list_auth_and_client_empty_response_do_not_query_or_disclose_totals(self):
        for authentication, expected in (({}, 401), (headers(abilities=[]), 403),
                                          (headers(role=5), 401), (headers(role=4), 200)):
            response = await self.client.get("/api/v1/transfers/?status=invalid", headers=authentication)
            self.assertEqual(response.status_code, expected)
            if expected == 200:
                self.assertEqual(response.json()["data"], {
                    "transfers": [], "pagination": {"page": 1, "limit": 10, "total": 0, "totalPages": 0},
                })
        self.query.assert_not_awaited()

    async def test_empty_institution_and_pagination_sort_validation(self):
        self.list_rows = []
        response = await self.client.get(
            "/api/v1/transfers/?page=-1&limit=999&sortBy=status;DROP&sortOrder=asc", headers=headers(),
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(data["pagination"], {"page": 1, "limit": 100, "total": 0, "totalPages": 1})
        self.assertEqual(data["statusTotals"], {"total": 0, "inProgress": 0, "completed": 0})
        self.assertEqual(data["transfers"], [])
        self.assertIn("ORDER BY t.created_at ASC, t.id ASC", self.query.await_args_list[1].args[0])
        self.query.reset_mock()
        response = await self.client.get("/api/v1/transfers/?page=invalid&limit=invalid", headers=headers())
        self.assertEqual(response.json()["data"]["pagination"]["limit"], 10)

    async def test_list_query_failure_never_reports_empty_success(self):
        self.query.side_effect = RuntimeError(MARKER)
        response = await self.client.get("/api/v1/transfers/", headers=headers())
        self.assertEqual(response.status_code, 500)
        self.assertNotIn(MARKER, response.text)
        self.assertNotIn("data", response.json())

    async def test_client_membership_does_not_override_institution(self):
        for suffix in ("", "/parties"):
            own = await self.client.get(f"/api/v1/transfers/{OWN}{suffix}", headers=headers(role=4, abilities=[]))
            self.assertEqual(own.status_code, 200)
            self.assertNotIn(MARKER, own.text)
            if suffix == "/parties":
                self.assertEqual(self.query.await_args.args[1][2], 5)
            foreign = await self.client.get(f"/api/v1/transfers/{FOREIGN}{suffix}", headers=headers(role=4, abilities=[]))
            self.assertEqual(foreign.status_code, 404)
            self.assertNotIn("Client of 7", foreign.text)

    async def test_no_cross_institution_read_or_list_exception(self):
        # Approved policy: same-institution isolation applies to every caller,
        # including the Super Admin role — foreign detail is NOT_FOUND and the
        # list only returns own-institution rows.
        for role in (1, 2, 3):
            with self.subTest(role=role):
                detail = await self.client.get(f"/api/v1/transfers/{FOREIGN}", headers=headers(role=role))
                self.assertEqual(detail.status_code, 404)
                listing = await self.client.get("/api/v1/transfers/", headers=headers(role=role))
                self.assertEqual(listing.status_code, 200)
                self.assertEqual(
                    [row["id"] for row in listing.json()["data"]["transfers"]], [OWN]
                )
                for nested in ("parties", "milestones", "documents", "financials", "estate-contexts"):
                    response = await self.client.get(
                        f"/api/v1/transfers/{FOREIGN}/{nested}", headers=headers(role=role),
                    )
                    self.assertEqual(response.status_code, 404, nested)

    async def test_institution_one_is_not_a_privileged_role(self):
        response = await self.client.get(f"/api/v1/transfers/{OWN}", headers=headers(ai=1))
        self.assertEqual(response.status_code, 404)

    async def test_missing_and_malformed_institution_context_never_reaches_data_services(self):
        tokens = [token(omit=("accountable_institution_id",))]
        tokens.extend(token(role=1, ai=value) for value in (None, False, 0, -1, 5.5))
        for encoded in tokens:
            for path, method in (("/api/v1/transfers/", "GET"), ("/api/v1/golden-records/search", "POST")):
                with self.subTest(path=path, encoded=encoded[:12]):
                    response = await self.client.request(
                        method, path, headers={"Authorization": f"Bearer {encoded}", "X-Accountable-Institution-Id": "5"},
                        **({"json": {"entity_type": "person", "query": "Example"}} if method == "POST" else {}),
                    )
                    self.assertEqual(response.status_code, 401)
                    self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.query.assert_not_awaited()
        self.entities.search_entities.assert_not_awaited()
        self.entities.get_client_by_golden_record.assert_not_awaited()

    async def test_relationship_write_rechecks_parent_and_party_ids(self):
        body = {"relationship_code": "test_relationship"}
        for parent, party in ((FOREIGN, OTHER_PARTY), (OWN, OTHER_PARTY)):
            response = await self.client.post(
                f"/api/v1/transfers/{parent}/parties/{party}/relationships", headers=headers(), json=body,
            )
            self.assertEqual(response.status_code, 404)
        self.tx.assert_not_awaited()
        tampered = await self.client.post(
            f"/api/v1/transfers/{OWN}/parties/{PARTY}/relationships", headers=headers(),
            json={**body, "accountable_institution_id": 7},
        )
        self.assertEqual(tampered.status_code, 422)
        self.tx.assert_not_awaited()
        allowed = await self.client.post(
            f"/api/v1/transfers/{OWN}/parties/{PARTY}/relationships", headers=headers(), json=body,
        )
        self.assertEqual(allowed.status_code, 201)
        self.tx.assert_awaited_once()

    async def test_cross_institution_roles_cannot_write_foreign_matters(self):
        # Approved policy: no deployed role holds a cross-institution write
        # exception — foreign writes fail closed with 404 before any mutation,
        # transaction or upstream call.
        for role in (1, 2, 3):
            writes = (
                (f"/api/v1/transfers/{FOREIGN}/parties/{OTHER_PARTY}/relationships",
                 {"relationship_code": "test_relationship"}),
                (f"/api/v1/transfers/{FOREIGN}/estate-contexts", {}),
                (f"/api/v1/transfers/{FOREIGN}/representative-assignments", {}),
            )
            for path, body in writes:
                with self.subTest(role=role, path=path):
                    response = await self.client.post(path, headers=headers(role=role), json=body)
                    self.assertEqual(response.status_code, 404)
        self.tx.assert_not_awaited()
        self.entities.get_entity.assert_not_awaited()
        self.entities.get_client_by_golden_record.assert_not_awaited()

    async def test_cross_institution_roles_still_write_own_matters(self):
        for role in (1, 2, 3):
            with self.subTest(role=role):
                response = await self.client.post(
                    f"/api/v1/transfers/{OWN}/parties/{PARTY}/relationships",
                    headers=headers(role=role), json={"relationship_code": "test_relationship"},
                )
                self.assertEqual(response.status_code, 201)
        self.assertEqual(self.tx.await_count, 3)

    async def test_client_role_denied_on_write_routes_even_with_write_ability(self):
        # The default token grants transfers:write; role 4 must be denied
        # explicitly before any authorisation query or mutation runs.
        writes = (
            (f"/api/v1/transfers/{OWN}/parties/{PARTY}/relationships",
             {"relationship_code": "test_relationship"}),
            (f"/api/v1/transfers/{OWN}/estate-contexts", {}),
            (f"/api/v1/transfers/{OWN}/representative-assignments", {}),
        )
        for path, body in writes:
            with self.subTest(path=path):
                response = await self.client.post(path, headers=headers(role=4), json=body)
                self.assertEqual(response.status_code, 403)
        self.query.assert_not_awaited()
        self.tx.assert_not_awaited()

    async def test_retired_and_unknown_role_ids_denied_before_any_handler(self):
        # Deployed roles are 1-4 only: validly signed tokens carrying retired
        # IDs 5/6 or unknown IDs are rejected at authentication even with
        # transfers:read and transfers:write — before persistence or upstream.
        requests = (
            ("GET", "/api/v1/transfers/", None),
            ("GET", f"/api/v1/transfers/{OWN}", None),
            ("POST", f"/api/v1/transfers/{OWN}/parties/{PARTY}/relationships",
             {"relationship_code": "test_relationship"}),
            ("POST", "/api/v1/golden-records/search",
             {"entity_type": "person", "query": "Example"}),
        )
        for role in (5, 6, 7, 99):
            for method, path, body in requests:
                with self.subTest(role=role, path=path):
                    response = await self.client.request(
                        method, path, headers=headers(role=role),
                        **({"json": body} if body is not None else {}),
                    )
                    self.assertEqual(response.status_code, 401)
                    self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.query.assert_not_awaited()
        self.tx.assert_not_awaited()
        self.entities.search_entities.assert_not_awaited()
        self.entities.get_client_by_golden_record.assert_not_awaited()

    async def test_sensitive_responses_are_not_cacheable(self):
        for path, authentication in (
            (f"/api/v1/transfers/{OWN}", headers()),
            (f"/api/v1/transfers/{FOREIGN}", headers()),
            ("/api/v1/transfers/", {}),
        ):
            response = await self.client.get(path, headers=authentication)
            self.assertEqual(response.headers.get("cache-control"), "no-store")

    async def test_unhandled_failures_do_not_disclose_data_in_responses_or_logs(self):
        self.query.side_effect = RuntimeError(MARKER)
        stderr = io.StringIO()
        with patch("builtins.print") as output, redirect_stderr(stderr):
            response = await self.client.get(f"/api/v1/transfers/{OWN}", headers=headers())
        self.assertEqual(response.status_code, 500)
        self.assertNotIn(MARKER, response.text)
        self.assertNotIn(MARKER, str(output.call_args_list) + stderr.getvalue())
        self.assertEqual(response.headers.get("cache-control"), "no-store")

    async def test_private_errors_do_not_escape_to_the_asgi_server_logger(self):
        self.query.side_effect = RuntimeError(MARKER)
        with patch("builtins.print") as output:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=True), base_url="http://test",
            ) as client:
                response = await client.get(f"/api/v1/transfers/{OWN}", headers=headers())
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"success": False, "error": "Internal server error"})
        self.assertNotIn(MARKER, str(output.call_args_list))

    async def test_request_validation_does_not_echo_input(self):
        response = await self.client.post(
            "/api/v1/golden-records/search", headers={**headers(), "Content-Type": "application/json"},
            content=f'{{"query": "{MARKER}", invalid',
        )
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(MARKER, response.text)


class DatabaseLogSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_query_failures_do_not_log_sql_parameters_or_error_details(self):
        connection = SimpleNamespace(fetch=AsyncMock(side_effect=RuntimeError(MARKER)))
        with patch("builtins.print") as output:
            with self.assertRaises(RuntimeError):
                await db.query(f"SELECT '{MARKER}' WHERE $1 = $1", [MARKER], connection=connection)
        self.assertNotIn(MARKER, str(output.call_args_list))

    async def test_health_does_not_disclose_database_error_details(self):
        with patch("db.query", AsyncMock(side_effect=RuntimeError(MARKER))):
            result = await db.check_database_health()
        self.assertFalse(result["healthy"])
        self.assertNotIn(MARKER, str(result))
