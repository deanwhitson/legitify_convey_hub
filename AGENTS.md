# LegitifyConveyHub — agent notes

## Runtime: two API servers, distinct ports required for local E2E

This repo runs two API servers against the same database:

- **Node Express BFF** (`server/`) — browser-facing. The Vite dev proxy sends
  all `/api` traffic here (`VITE_API_PORT`/`PORT`).
- **DEEDLY FastAPI service** (`python_server/`) — owns the routes that need the
  Legitify S2S lane (Golden Record visibility flow, specialist writes, Golden
  Record search).

**Both read `PORT`** (`server/index.ts` and `python_server/config.py`). To run
them together for E2E testing they MUST use distinct ports, e.g. Node on
`PORT=3000` and FastAPI on `PORT=3100`, with the Node server configured with:

```text
DEEDLY_API_BASE_URL=http://localhost:3100
```

so the auth-forwarding BFF proxy `POST /api/v1/golden-records/search` can reach
FastAPI. See `server/routes/v1/goldenRecords.ts`.

## Golden Record Search / Retrieve status

Search and Retrieve are completed on `main` at the accepted checkpoint
`7d8101c4928238d555b9c958241adbac6a6c3b24`. This status does not certify live
browser authentication or a deployed upstream contract.

- Person, company, and trust search implemented end-to-end (tenant-safe: search
  → candidate ids → linkage visibility → typed fetch → visible results only).
- DEEDLY sends the upstream generic `query` payload and `entity_type:
  person|company|trust`; trust search uses `entity_type=trust` and canonical
  trust retrieval uses `entity_type=company`.
- Browser JWT issuance/storage/`Authorization` header wiring is implemented on
  `deedly/mvp0/auth/production-authentication` (see "Production Authentication"
  below): upstream OTP login via the BFF, in-memory access token, HttpOnly
  refresh cookie. This is mock-tested wiring only — live browser/S2S
  certification still requires the deployed upstream contract evidence below.
  No fake tokens, service keys, or auth bypasses may be added.

## Useful commands

```powershell
# Python tests (from python_server/)
python -m unittest tests.<module>
# Full regression (set ENTITIES_SOURCE_ROOT to run landed contract tests)
$env:ENTITIES_SOURCE_ROOT = "D:\WORK\Legitify\Projects\legitify-be-main\legitify-be-main"
python -m unittest discover -s tests -p 'test_*.py'

# Node route tests
npx tsx --test server/tests/<file>.test.ts
npx tsx --test src/components/GoldenRecordsSearch.test.tsx

# Typecheck (note: pre-existing TS6059 rootDir error on
# server/utils/conveyancingAccounts.ts is unrelated to current work)
npx tsc --noEmit
npm run typecheck:server
```

## Golden Record retrieval P0

- `GET /api/v1/golden-records/{uuid}?entity_type=person|company|trust` uses the
  authenticated Node BFF → FastAPI path. FastAPI requires `transfers:read`, denies
  client-role access, and derives the linkage AI from the verified user.
- Every retrieval rechecks AI linkage before the canonical Entities GET. Trust
  retrieval remains company-style upstream with strict trust classification.
  The detail projection is transient; retrieval performs no DB writes and does
  not expand the persistent display cache.
- Browser JWT wiring is implemented on the auth branch (see below); live use
  remains blocked on the deployed upstream contract and the unresolved
  external-ingress/key-rotation HOLD in upstream
  `docs/deedly_external_integration.md`. Do not bypass either dependency or
  claim live browser/S2S certification from mock-transport tests.
- The configured Entities source directory is a snapshot without Git metadata;
  executing its contract tests does not attest an upstream or deployed SHA.

For full Python verification, from `python_server/`, set `ENTITIES_SOURCE_ROOT`
(as above) and run `python -m pytest -q -rs -p no:cacheprovider tests`. Unlike
unittest discovery, pytest executes the function-based landed-source contracts.
DB-dependent tests require `TEST_DATABASE_URL`; an unset value means skipped
DB integration coverage, not a successful database certification.

## Create Golden Record foundation — superseded by product decision

**Product decision:** DEEDLY does not create Golden Records and does not
register clients in Legitify. DEEDLY supports only (a) searching/retrieving
and linking existing institution-authorised Golden Records and (b) capturing
firm-private manual parties with no Golden Record link. Central Create Golden
Record is cancelled/superseded — it is not blocked awaiting implementation.
The adapter foundation below is completed historical work: the
`entity_submissions.py` adapters are unused by the product flow, while
`clients/entity_protocol.py` remains in live use by the runtime client through
the prior extraction — it is not unused and must not be removed.

- `python_server/clients/entity_submissions.py` contains typed, side-effect-free
  request adapters and a response-reference parser. They are not wired into
  `EntitiesClient.submit_person`, a route, or the UI, and no wiring is planned
  under the cancelled create scope. Runtime submit payloads,
  returns, timeouts and retries remain unchanged.
- Shared definitions/decoding live in configuration-free `clients.entity_protocol`,
  which the runtime client actively uses: it re-exports
  the same exception/type objects and delegates decoding, retaining its existing
  configuration bootstrap. Fresh-process tests install import/dotenv/HTTP-client
  guards before importing adapters; call-time no-I/O guards remain in place.
- Request checks cover source structure, not approved P0 business requirements.
  Person requests use `id_number`; there is no passport-pair adapter. The existing
  client's unused passport transport remains unchanged. Trust requests require
  an explicit office and preserve leading zeros during source-matched normalization.
- A parsed `SubmissionReference` contains only UUID and logical type. It is not
  evidence of a newly created, verified, visible or registered record. A 409 is
  an error, never authorization. Canonical details still require the existing
  linkage-before-fetch workflow; no submit display data may become a cache.
- The upstream `SubmitClientRequest`, submit route, serializers, trust utilities
  and passport limitations are exercised through the existing landed-source
  test harness using `ENTITIES_SOURCE_ROOT`. No upstream service is called.
  This snapshot has no Git metadata and is not deployed-contract evidence.
- Parent Create Golden Record is closed by the product decision above, not by
  resolution of its blockers. Each D-item's create-specific half is superseded;
  its surviving concerns are renamed as follow-ups so nothing is lost:
  - D1 → **Relationship eligibility** — registration orchestration is
    superseded; eligibility of existing firm/client relationships still
    governs Search/Retrieve/Link.
  - D2 → **Institution context** — create-specific context is superseded;
    trusted institution context and read/write authorization remain.
  - D3 → **Live read/link ingress** — submit-specific access is superseded;
    live read/link ingress, credentials and deployed evidence remain (the
    external-ingress/key-rotation HOLD below).
  - D4 → **Passport search concerns** — new-record uniqueness is superseded;
    passport ambiguity, country and changed-number search concerns remain
    tracked.
  - D5 → **Existing-record entitlement** — create-specific submission/recovery
    is superseded; existing-record entitlement, charging and
    verification-display questions remain.
  - D6 → **Manual-party fields** — central-create fields are superseded;
    manual-party field requirements continue in their own workstream.
  Durable matter attachment and authenticated matter saving remain separate P0 work.

Focused Python type checks from `python_server/` (Windows; `nul` disables cache):

```powershell
python -m mypy --follow-imports=silent --ignore-missing-imports --no-incremental --cache-dir=nul clients/entity_protocol.py clients/entities.py clients/entity_submissions.py services/entity_reconciliation.py
python -m mypy --strict --follow-imports=silent --ignore-missing-imports --no-incremental --cache-dir=nul clients/entity_protocol.py clients/entity_submissions.py
```

Adapter/client checks use `tests/test_entity_submissions.py` and
`tests/test_clients_entities.py`. Include `tests/test_landed_entities_search_contract.py`
with `ENTITIES_SOURCE_ROOT` set for executable source-contract coverage. Its SQL
fixtures are synthetic in-memory SQLite, not PostgreSQL migration certification.

## Production Authentication / Browser JWT Integration

Implemented on `deedly/mvp0/auth/production-authentication` (based on
`c94074ea12f0090ebd6d1c77d524d54ec5396964`). Mock-tested wiring only — live
certification needs the deployed upstream evidence listed below.

### Upstream contract (legitify-be-main snapshot, `services/auth`)

Staff login is OTP-based — never a direct password→token exchange:

1. `POST /api/v1/auth/initiate-login` — `{id_number | passport_number,
   password, user_id?}`. Exactly one identifier; `user_id` disambiguates
   multiple accounts (including two accounts at the same institution). On
   success returns `{message, data:{user_id, requires_otp:true}}`; when several
   accounts match it returns `data.accounts[]` (each with `user_id`,
   `accountable_institution_id/_name`, `role_id/_name`) and
   `requires_otp:false`. It does NOT send the OTP.
2. `POST /api/v1/auth/otp` — `{user_id, delivery_method?: CELL|EMAIL|BOTH}`
   generates+sends the OTP; returns `data:{confirmation_pin}` (anti-phishing;
   `dev_otp` is included only when upstream `app_debug` is on).
3. `POST /api/v1/auth/login` — `{user_id, otp:int 6-digit}` →
   `data:{user, client, popia_consent, answered_onboarding_questions, token,
   expires:int unix ts, refresh_token}`.
4. `POST /api/v1/auth/refresh` — `{refresh_token}` → `data:{token, expires}`.
   Refresh tokens are stateless and NOT rotated; no server-side revocation
   exists (upstream issue notes a blacklist may come later). Logout does not
   revoke the refresh token upstream.
5. `POST /api/v1/auth/logout` — requires Bearer with `api` ability; burns any
   active OTP. Client login (`/client-login`, role 4 OTP-only, no password) is
   a separate upstream flow and out of scope for the staff slice.

Token claims: access JWT `HS256` shared `JWT_SECRET`, `type=access`, `iat`,
`exp` (default 24h), `user_id`, `golden_record_id`, `abilities`,
`accountable_institution_id`, `user_roles_id`, `tenant_id`. Refresh JWT
`type=refresh`, `user_id` only, 30-day default. No `iss`/`aud` validation in
the inspected shared JWT helper. Envelope everywhere: `{message, data,
errors?}` — no `success` field.

### Session design

- **Access token: browser memory only** (`src/lib/api/session.ts`) — never
  localStorage/sessionStorage. `apiRequest` attaches it as
  `Authorization: Bearer` on BFF routes; the BFF verifies it and forwards it
  unchanged to FastAPI on proxied routes, so claims are server-verified per
  request. On 401, `apiRequest` makes one refresh attempt and retries once —
  and only while the session's sid is unchanged, so an in-flight write is
  never replayed under a different user/institution (institution-scoped
  `client_request_id` keys alone would not catch that).
- **Refresh credential: sid-bound cookie pair.** On login the BFF generates a
  per-login session id and sets `deedly_refresh=<sid>.<refresh_token>`
  (HttpOnly, `Path=/api/auth`) plus `deedly_sid=<sid>` (readable, `Path=/` —
  `document.cookie` is only visible under the cookie's path, and every SPA
  route must read it for post-reload restore). Both `Secure; SameSite=Strict`.
  `/refresh` requires the client to echo the sid via `X-Deedly-Session`
  (double-submit); it **never emits Set-Cookie**, so a late refresh response
  can never create, overwrite or clear a cookie. `/logout` clears the pair
  **only when the presented sid matches the cookie's**, so a logout for
  session A cannot strip session B's cookie, and it responds without waiting
  on upstream (upstream logout is fire-and-forget) to keep the in-flight
  clear window small.
- **Serialized auth operations, including across tabs — Web Locks required.**
  Login-complete, refresh and logout run through one promise queue
  (`enqueueAuthOp`) wrapped in the Web Locks mutex `deedly-auth`: a tab holds
  the lock for its whole request/response window, so a delayed logout/login
  Set-Cookie in one tab cannot interleave with another tab's auth operation —
  the BFF's request-time sid check stays effective and Set-Cookie ordering
  follows operation order. **Without `navigator.locks` the browser is
  unsupported**: `enqueueAuthOp` rejects, refresh fails closed (clears the
  session, fires no request), login cannot be completed, and the Login page
  shows an unsupported-browser message. `logoutSession` still performs
  immediate local teardown (memory clear + readable-cookie hygiene) but sends
  no cookie-changing request.
- **Logout semantics under interleaving.** `logoutSession` clears local state
  immediately and bumps a `logoutEpoch` tombstone: refresh/login ops capture
  the epoch at call time and discard their result if a logout was requested
  while they were queued or in flight — logout always wins over a pending
  login/refresh. The logout's BFF request presents the sid it may
  legitimately end: the call-time session sid, or the jar sid when this tab's
  own auth pipeline installed it (`tabSessionSids`, including login responses
  discarded by the tombstone whose Set-Cookie still landed). A foreign sid —
  a newer login from another tab — is never presented and survives. Limit:
  the guarantee covers cooperating app tabs; code outside the app's auth path
  (any same-origin page can issue uncoordinated requests) is outside it —
  same-origin JS is already trusted with the in-memory token.
- **BFF auth proxy** (`server/routes/auth.ts`, mounted at `/api/auth`):
  `initiate-login`, `otp`, `login`, `refresh`, `logout`. `login` strips
  `refresh_token`/`refresh_expires`/`dev_otp` from the browser-visible body
  and verifies the issued access token against the BFF's own JWT checks (so
  retired/unknown roles fail closed at session creation). `refresh` applies
  the same claim verification to the returned access token before relaying it.
  `otp` strips `dev_otp` — upstream debug OTPs are never exposed through
  DEEDLY. `logout` forwards the Bearer token upstream best-effort. Input is
  validated at the BFF before any upstream call; upstream 5xx/unreachable/
  unset `LEGITIFY_API_BASE_URL` → generic 503.
- **Session transitions** clear the legacy `legitify_auth` prototype flag and
  notify `onSessionChange` listeners; the app holds no other user/institution-
  scoped caches (accounts reads are `no-store`; `darkMode` is cosmetic).
- `RequireAuth` waits for the silent refresh attempt (`isRestoring`) before
  redirecting, so a page reload with a valid cookie pair restores the session
  instead of bouncing to `/login`.

### Cookie / CSRF / hosting requirements

- **Explicit origin guard before any upstream activity** (router-level
  middleware): `Sec-Fetch-Site: cross-site` → 403; a present `Origin` must
  match `AUTH_ALLOWED_ORIGINS` (comma-separated exact list) when configured,
  else the request `Host` — the supported same-origin `/api` deployment — or
  a loopback origin outside production (Vite dev proxy). A **missing** Origin
  does not establish trust: `Sec-Fetch-Site: same-origin`/`none` attests
  provenance on its own; otherwise only requests carrying no `Cookie` header
  (non-browser probes with no ambient authority) pass — a cookie-bearing
  request with no origin evidence is an ambiguous browser and gets 403. This
  does not rely on CORS or SameSite alone; on top of it sit
  `SameSite=Strict`, no credentialed CORS, and the sid double-submit header.
- Deployment requirement: the BFF must be reachable **same-origin under
  `/api`** from the SPA (as the Vite dev proxy does) and served over HTTPS —
  `Secure` requires it and a cross-site BFF host would break refresh. Do not
  weaken `Secure`/`SameSite`/`Path` or broaden `AUTH_ALLOWED_ORIGINS` to
  accommodate a cross-site deployment.
- The 401 refresh-and-retry reissues the identical serialized request body, so
  `client_request_id` idempotency keys on matter/party creates are preserved
  and replays deduplicate upstream (`(accountable_institution_id,
  client_request_id)` unique index). Our 401s are additionally always raised
  before any handler or upstream call, so no partial write can have occurred,
  and the sid-unchanged gate prevents replay under a newer session entirely.
- Passwords, OTPs and tokens are not logged; BFF 503/400 responses carry no
  upstream detail. Logout clears only the local session — upstream tokens are
  stateless and expire naturally; it is NOT upstream revocation.

### Test evidence (focused, mocked — no upstream contacted)

- `server/tests/authProxy.test.ts` — 31 tests: input validation without
  upstream calls, contract forwarding, account-picker relay, sid-bound cookie
  pair on login (`deedly_refresh` HttpOnly `Path=/api/auth`; `deedly_sid`
  readable `Path=/`), `dev_otp` stripping on `otp`/`login`, local verification
  of issued and refreshed tokens (retired role / wrong signature rejected),
  sid double-submit enforcement and refresh's no-Set-Cookie invariant,
  logout's match-before-clear cookie rule and fire-and-forget upstream
  forwarding, refresh contract-violation 503, explicit
  origin/Sec-Fetch-Site rejection before upstream activity, missing-Origin
  policy (cookie-bearing requests with no origin evidence → 403;
  credential-free probes and `same-origin` metadata pass),
  `AUTH_ALLOWED_ORIGINS` allowlist behaviour incl. same-site entries.
- `src/lib/api/session.test.ts` — 28 tests: Bearer attachment (and its
  exclusion on auth-ingress paths), one-shot refresh+retry on 401, no retry
  loop, failed-refresh session clearing, refresh single-flight, sid-echo on
  refresh incl. post-reload cookie restore, serialized auth-op ordering
  (logout while refresh in flight discards the refresh result, then runs),
  routing through the `deedly-auth` Web Lock, unsupported-browser fail-closed
  (no auth requests fire; local teardown still immediate), logout-epoch
  discard of still-queued refreshes, stale refresh/login responses discarded
  after logout or a newer login, pending writes never replayed under a
  changed session, identical-body write retry preserving
  `client_request_id`, logout Bearer+sid/cleanup under transport failure,
  foreign-sid cookie preservation, session-change notification, legacy flag
  removal, no token persistence to storage.
- **Local browser verification** (Playwright/Chromium + mocked upstream, run
  locally, harness not committed): three processes — mock upstream on :8000
  (minting test JWTs signed with the BFF's `JWT_SECRET`), the real BFF on
  :3001 (`LEGITIFY_API_BASE_URL` → mock), Vite dev server on :5173 proxying
  `/api` same-origin. Scenarios verified: (1) real-UI OTP login →
  `deedly_sid` readable via `document.cookie` on `/transfers` → reload at the
  SPA route restores the session; (2) two tabs sharing one browser context —
  tab1 logout with its **response** held at the network layer (Playwright
  `route.fetch()` then delayed `route.fulfill()`, i.e. a delayed
  Set-Cookie-bearing response, not a delayed request) → tab2 fired zero auth
  requests while the `deedly-auth` lock was held → on release the stale clear
  landed first, tab2's login then established sid-B → reload under sid-B
  restored; (3) uncoordinated raw `fetch` (outside `enqueueAuthOp`) issuing a
  sid-B logout whose held response landed after a sid-C login → sid-C's
  refresh cookie was cleared — the documented residual outside the
  cooperating-tabs guarantee.
- `src/lib/api/accountsApi.test.ts` — updated to the new retry contract (a 401
  may trigger one `/api/auth/refresh` call; auth-flag cleanup is excluded from
  the institution-storage assertions).

### Remaining live-certification dependencies / open questions

- `LEGITIFY_API_BASE_URL` must point at the deployed nginx gateway per
  environment; `JWT_SECRET` must equal the platform's shared signing secret.
  Both are deployment config — unverified here.
- The snapshot has no Git metadata; the deployed auth service's actual
  contract/SHA is unverified. External-ingress/key-rotation HOLD stands.
- OTP delivery requires configured upstream SendGrid/Twilio and an approved
  test account; no live provider calls were made.
- Upstream refresh tokens are non-rotating and non-revoked on logout (upstream
  tracks a blacklist as future work) — accepted limitation of the current
  contract; confirm whether production policy requires revocation.
- `iss`/`aud` claims are neither issued (beyond defaults) nor validated by the
  inspected code — confirm production expectations.
- The upstream `/otp` response shape is `{data:{confirmation_pin,dev_otp?}}`;
  OTP resend rate-limiting upstream is unverified.

## AI/institution security boundaries and safe verification

- Legacy transfer, milestone, document, document-template, local-profile and address
  routers are quarantined in both servers. The Accounts router is quarantined under
  both `/api/accounts` and `/api/v1/accounts`. Missing/invalid JWT context returns
  401; verified callers receive 503 before any legacy handler, cache, DB or provider
  operation. Restoring these paths requires an approved authenticated contract,
  not simply removing the quarantine dependency/middleware.
- Same-institution isolation applies to every caller — approved policy removed
  the former cross-institution exception for privileged roles entirely: no
  role may read, list or mutate another accountable institution's matters or
  child resources, and matter creation is always attributed to the verified
  caller's institution. Institution ID 1 is not a privileged role. Only the
  deployed roles 1–4 can authenticate at all: retired IDs 5/6 and unknown IDs
  are rejected at JWT verification in both servers (see the confirmed role
  authority note below). Clients must
  additionally prove GR party membership. Standalone GR discovery/retrieval
  keeps its existing linkage-scoped projection; no charging trigger or new
  entitlement policy is enabled.
- Accounts browser requests no longer use institution-unscoped memory/localStorage
  fallbacks or claim offline saves succeeded. Existing legacy browser storage is
  not automatically deleted; restoration/data recovery needs an approved decision.
- `server/tests/aiTenantSecurity.test.ts` uses guarded DB mocks and loopback HTTP.
  `server/tests/v1SpecialistRoutes.test.ts` seeds/deletes real rows and is
  authorized only when BOTH `TEST_DATABASE_URL` (an explicitly approved
  isolated database) and `RUN_SPECIALIST_DB_TESTS=1` are set. Without them the
  suite self-skips before importing the app or pool — no connection, setup or
  cleanup can run — and when authorized it redirects the whole process at
  `TEST_DATABASE_URL` via `SPECIALIST_TEST_DATABASE_URL`, never the ordinary
  `DB_*` config. `server/tests/specialistDbGuard.test.ts` proves ordinary
  discovery opens no database connection (honeypot listener, zero sockets).
  Incident note (this branch): before the guard existed, the suite ran three
  times under ordinary discovery against local `DB_*` config. Per run, the
  `before`-hook preClean issued two `DELETE FROM transfers` statements scoped
  to test prefixes (`TX-SPEC-%`, `TX-OTHER-%`) that were **observed** to
  commit with zero rows affected; a third DELETE on
  `party_relationship_definitions` failed at parse time (relation absent), so
  `seedFixtures` never ran and no INSERT was issued. The `after`-hook cleanup
  demonstrably reached its failing third statement, so its two prefix-scoped
  `transfers` DELETEs also executed — but their affected-row counts were not
  captured in the logs. Established: zero observed row changes, no seeds, no
  schema changes. Not established: an exhaustive proof that no row changed —
  cleanup row counts were uncaptured.
- The standard server type check retains the existing TS6059 shared-source
  `rootDir` issue. A non-emitting check with `--rootDir .` covers those sources
  without changing project configuration. Baseline `84c0269` also has 11 mypy
  errors in `db.py` and `routers/v1/transfers.py`; distinguish these from the
  independently checked auth, policy and internal-link modules.

Focused security checks (repo root unless stated otherwise):

```powershell
npx tsx --test server/tests/aiTenantSecurity.test.ts server/tests/v1GoldenRecordSearch.test.ts
npx tsx --test src/lib/api/accountsApi.test.ts src/components/GoldenRecordsSearch.test.tsx
npx tsc --noEmit
npx tsc -p server/tsconfig.tests.json --noEmit --rootDir .
```

From `python_server/`, without an upstream service or database:

```powershell
python -m pytest -q -rs -p no:cacheprovider tests/test_auth.py tests/test_policy.py tests/test_ai_tenant_security.py tests/test_transfer_parties.py
python -m mypy --follow-imports=silent --ignore-missing-imports --no-incremental --cache-dir=nul auth/current_user.py auth/jwt.py auth/policy.py auth/dependencies.py services/transfer_party_service.py main.py
```

## P0 review handover: discovery, authority and restoration

- **Party-branch BFF verification (fresh, 2026-09-15):** on exact HEAD
  `2b57f97257cf808f429d54c20f66dbe7944208a5` — clean working tree and local HEAD
  confirmed equal to `origin/deedly/mvp0/parties/manual-and-gr-sources` after
  fetch — fresh runs pass: `npx tsx --test server/tests/v1MatterParties.test.ts
  server/tests/aiTenantSecurity.test.ts server/tests/v1GoldenRecordSearch.test.ts`
  (103/103). Coverage includes the corrected awaited `POST /api/v1/transfers/`
  proxy handler and client-role write denial (matter create and party attach
  denied before any upstream call even with `transfers:write`), plus the GR
  search/retrieval proxy suite. `npx tsc -p server/tsconfig.tests.json --noEmit
  --rootDir .` is clean. `v1SpecialistRoutes.test.ts` was deliberately not run
  (unapproved DB seeding; see the guard above). Python and component results
  from prior sessions are reused evidence, not re-run. Merge order remains the
  corrected `security/review-fixes` first, then the party branch; no merge to
  main, deployment or migrations yet.
- **P0 discovery-contract blocker:** the available upstream snapshot's
  `docs/deedly_external_integration.md` section 4 explicitly requires the clients
  linkage check on each search candidate before exposing it. Current DEEDLY search
  consequently does not expose records unlinked to the requesting AI, even as
  limited results. Global S2S search capability is not evidence of an approved
  end-user unlinked-discovery entitlement or field mask. Obtain that contract and
  deployed evidence from Clive/Louis before changing this boundary; do not describe
  unlinked discovery as implemented. Canonical retrieval stays linkage-gated.
- Discovery creates no linkage and enables no charging trigger. The source search
  path reads repositories/serializers; submit, resubmit and provider/profile runs
  are separate. Deployed discovery/billing behaviour remains unverified.
- **Documented role authority — confirmed:** Clive confirmed the deployed
  platform uses roles 1–4 exactly as the `DEEDLY_Role_CRUD_Permissions`
  workbook lists them: 1 Super Admin, 2 Manager [Compliance Officer],
  3 User [General Staff], 4 Client. The role-ID mapping question, including
  Client = 4, is closed; the upstream six-role
  `docs/transfers_golden_record_providers_auth.md` model is superseded for
  DEEDLY. Product decision: retired roles 5/6 and any unknown role ID have no
  access whatsoever — validly signed tokens carrying them are rejected, never
  remapped, at JWT claim validation in both servers
  (`python_server/auth/jwt.py`, `server/auth/jwt.ts`, `DEPLOYED_ROLE_IDS`), so
  they receive 401 before any protected handler, database or upstream call
  even when the token carries read/write abilities. Previously such tokens
  verified as non-client staff with same-institution access — the gap this
  closes. Per approved product policy, DEEDLY applies same-institution
  isolation to every deployed caller regardless of role: abilities and GR
  party membership still apply, and standalone GR linkage checks are
  unchanged. Scoping never consults `user_roles_id` for privileged
  exceptions. `test_auth.py`, `test_policy.py`,
  `test_ai_tenant_security.py` and `aiTenantSecurity.test.ts` cover deployed,
  retired and unknown roles and ordinary/client users, including ID/scope
  tampering.
- **Test tenant identifiers received** (`Documentation/test data/Test platform
  identifiers.txt`): AI 1 Legitify, 2 Remax Evolve, 3 Rockstar Realty, 4 Kruger
  Attorneys & Conveyancers Inc, 5 QA Sandbox; Legitify and QA Sandbox are
  offered for test use. These are platform test tenants only — they do not
  change the approved same-institution isolation policy or certify any
  production AI assignment.
- **P0 legacy restoration:** authenticated matter saving and durable GR attachment,
  documents, profiles, templates, Accounts and address-provider controls remain
  separate work. Do not restore handlers merely by removing quarantine.
- **P0 infrastructure:** browser JWT integration is implemented on
  `deedly/mvp0/auth/production-authentication` pending live certification;
  external-ingress/key-rotation HOLD, verified DB TLS/CA configuration,
  isolated PostgreSQL verification and deployment proxy/artifact/logging
  checks remain open. The current DB clients still disable certificate
  verification; this branch does not change that config.
- **P1 baseline typing debt:** the existing TS6059 server `rootDir` failure and 11
  mypy errors in `db.py`/`routers/v1/transfers.py` are separate from introduced
  issues. Do not relax checks or change security controls to hide them.
- Parent Create Golden Record is **cancelled by product decision** (DEEDLY does
  not create Golden Records or register clients); D1–D6 are closed as
  superseded, with their surviving concerns carried forward as the named
  follow-ups in the reassessment above. Louis's charging decision, name/DOB
  decisions and matter/file-reference lookup remain open and are not
  implemented by this security branch.

### Quarantine UI handling — P0 functional states applied

Source-level audit of currently routed screens (not live browser certification).
Functional failure states are P0 release requirements; the shared
`UnavailableNotice` + `serviceUnavailableMessage` (`src/components/ui`,
`src/lib/api/serviceStatus.ts`) provide status-only messaging:

| Screen | Quarantine failure presentation |
|---|---|
| `/accounts`, `/calculators` | Explicit unavailable alert; no default figures/actions before settings load. |
| Transfer milestones: Accounts tab | Explicit unavailable alert; stale request/statement state discarded. |
| `/settings`: Firm Accounts tab | Spinner only while loading; after failure an explicit unavailable notice replaces it. |
| `/settings`: Profile tab | Explicit unavailable notice; form and save are removed until a profile loads. |
| `/dashboard` | Explicit unavailable notice; stat cards show `—` instead of misleading zeros; recent-cases failure is stated. |
| `/cases` | Explicit unavailable notice; case table hidden on failure; New Case disabled. |
| `/transfers` (dashboard) | Explicit unavailable notice; stat cards show `—`; list shows "no data available" instead of an empty-results state. |
| `/transfers/workflow` (`/transfers/new`, edit) | One-shot `GET /api/transfers?limit=1` probe disables Save Draft/Submit Transfer up front and shows an unavailable notice; save handlers no-op while persistence is down. Step document uploads/catalogue add are disabled with a notice; per-item failures remain inline. |
| Workflow: property/address lookup | Address provider failures show a friendly unavailable message; manual address entry stays usable. |
| `/transfers/:transferId/milestones` | Transfer/milestone/activity failures surface as unavailable notices; milestone tab hides seed data and editing on failure; failed saves roll back local milestone edits and add no audit entries; summary fields show `—` when no transfer loaded. |
| Transfer milestones: Documents tab | Load failures show unavailable notices; document list, upload/replace and catalogue-add controls are hidden/disabled on failure. |
| `/documents` | Load failure shows an unavailable notice instead of "No documents found"; upload is disabled; totals show `—`. |
| `/document-catalogue`, `/clause-library` | Load failure shows an unavailable notice and bundled sample entries are labeled as non-live reference data; add forms are disabled while offline. |
| `/data-dictionary`, `/template-engine` | Same labeled sample-data fallback; generation stays a local-only preview with a notice that nothing is saved. |
| `/document-generator` | Clause-library failure shows a labeled sample-data notice; history failures surface as unavailable; generated files are stated to be local-only and audit-record save failures are reported. |
| `/transfers/new` | GR APIs are not quarantined; live use awaits deployed upstream auth certification (wiring now exists on the auth branch) and downstream saving is quarantined (Save/Submit disabled by the probe above). |

`/bonds` and `/cancellations` are currently placeholders with no affected API calls.
Remaining P1 items are cosmetic only (wording, retry controls, iconography). The
unavailable states above do not certify that quarantined workflows work — the
routes stay quarantined until approved authenticated contracts exist.

### P0 PostgreSQL verification prerequisite

`python_server/tests/test_transfer_party_postgres.py` prepares 12 PostgreSQL cases
plus two no-DB guard tests. The real-DB cases require both `TEST_DATABASE_URL` and
`RUN_ISOLATED_SECURITY_DB_TESTS=1`; neither the flag nor a DSN alone proves approval
or isolation. They must not run without explicit approval of an isolated database
and the following test-owned lifecycle:

- PostgreSQL 13+; CREATE/DROP permissions for random
  `deedly_security_test_<uuid>` schemas, with synthetic data only.
- Separate sessions exercise the production query/repository/transaction code;
  barriers and `pg_blocking_pids` verify blocking rather than relying on sleeps.
- Covers link idempotency/rollback, tenant changes during visibility, parent locks
  held until insert commit, cache-only refresh, concurrent GR/type/parent/AI
  changes, and parent/party locks held until cache update commit.
- Uses minimal transfer/party tables in its own search path; it does not apply or
  certify production migrations, full constraints or upstream entitlements.
- Visibility/Entities calls are mocked. Only the operator-approved isolated DSN
  is used; application DSNs are never a fallback. Cleanup drops only the freshly
  created scratch schema, after cancelling tasks and releasing connections.

This review found `TEST_DATABASE_URL` unset: no PostgreSQL connection or DDL was
attempted. To collect/run the guards safely without opting in, from `python_server/`:

```powershell
python -m pytest -q -rs -p no:cacheprovider tests/test_transfer_party_postgres.py
```

Configure the isolated DSN securely and set the opt-in flag only after the above
specific approval. Skipped PostgreSQL cases are a P0 prerequisite, not certification.

## Document requirement rules — register seed (proposal, NOT a migration)

`docs/proposals/027_deedly_document_requirement_rules_seed.sql` proposes
seed content for `transfers.document_requirement_rules` derived from the
Required Documents Register (86 document types x 18 classifications). It is a
**review artifact — not a migration**: it deliberately lives outside
`src/lib/migrations/` because `scripts/migrate.mjs` executes every `*.sql`
file there. Every register row carries "Include in P0? = To review", so
Required is a candidate baseline only until the team's validated P0
selections arrive. Mapping and gaps:
`docs/deedly-required-documents-register-mapping.md`; focused
`transfer.private_treaty.not_applicable` proposal with the candidate
condition vocabulary and P0-demo fact subset:
`docs/deedly-required-documents-pt-na-proposal.md`; per-requirement gap
assessment (facts/scopes, smallest change, acceptance tests):
`docs/deedly-required-documents-pt-na-gap-assessment.md`.

- 222 proposed rows — one per Required cell — each scoped to an **explicit**
  canonical `classification_code` (`condition_key NULL` baseline). No `'*'`
  wildcards: requirements must never extend to unreviewed classifications.
- **Zero applicable rules is not readiness — pending, unimplemented.** A
  matter on an unsupported or unconfigured classification (`transfer.generic`,
  a future code) must show "Requirements not configured" — an empty
  checklist is not a successful completeness result. Today the engine
  returns an empty list; the engine/API distinction is not built and the
  proposal tests do not establish readiness behaviour.
- **Conditional** cells are deliberately NOT proposed as rules: register
  triggers are prose and the engine vocabulary is only `has_bond`/
  `cash_purchase` — unapproved heuristics that also conflate purchaser
  finance with the seller's existing bond (kept separate in the proposal).
  Seeding unsupported `condition_key` values surfaces permanently
  `unevaluatedRules` on every matching matter.
- **Optional** has no engine level; **Not applicable** is absence of a rule.
- `public.document_catalogue`, `classification_document_map` and
  `document_catalogue_requirements` are legacy/dead on the live v1 lane and
  are intentionally not seeded — `Active` catalogue rows would re-arm the
  quarantined per-transfer auto-seed with all 86 documents regardless of
  classification.
- Register "To review" columns (signature/execution, per-doc P0 flag) and
  "Generate in DEEDLY? = Candidate" are not implemented — no
  `document_templates` rows.
- **Exposure flag:** any database that ran the `a24cdc3` version of this
  seed (120 rules, six `'*'` scopes) carries unapproved rules + a ledger row
  — treat as proposal data, reset/reconcile under the approved seed.
- PostgreSQL verification ran against a real Neon database — the scratch DB
  `deedly_proposal_test` on the branch Dean supplied as
  `deedly-documents-test` (endpoint `ep-lucky-sun-awl88y3n`; branch name as
  supplied — endpoint-to-branch mapping unconfirmed pending console/API
  check). No production or shared application database was migrated. 17/17 in
  `python_server/tests/test_document_requirement_rules_seed_proposal.py`;
  proposal applied inside rolled-back transactions only (rules table empty
  afterwards, no 027 ledger row). Before any real execution: confirm
  migration number 027 with Jordan.

## Matter documents — upload & readback lane

Authenticated staff document lane (`python_server/routers/v1/transfers.py` +
`documents.py`, BFF proxies in `server/routes/v1/`, service in
`python_server/services/matter_document_service.py`). Full status:
`docs/deedly-matter-documents-slice-status.md`.

- Downloadable only when `status='uploaded'` AND `scan_status='clean'` AND a
  `storage_key` exists; storage/scan/lifecycle states are separate columns.
  Scanner failure leaves the file unavailable — never released.
- Upload cap is 25 MB, enforced on declared AND actual bytes at both the BFF
  (streaming byte-count) and FastAPI (`UploadBodyLimitMiddleware` +
  `file.read(cap+1)`). Content is magic-byte sniffed (PDF/DOCX/JPG/PNG);
  DOCX must be a real OOXML package with a `.docx` name.
- Download: a 5-min HMAC token (`DOCUMENT_TOKEN_SECRET`, falling back to
  `SECRET_KEY`) scopes the grant, but retrieval RE-AUTHORIZES the caller —
  valid staff JWT + `transfers:read` + token's institution must match the
  caller's verified institution, and the document's current parent
  transfer/matter must still exist in that institution (`EXISTS` check).
  Token alone releases nothing; state is re-checked at retrieval.
  `download_link_issued` and `download_retrieved` are separate op-log events.
- Recovery: same-bytes upload replays, different-bytes conflicts (no
  replacement), `POST .../documents/{id}/rescan` rescans the stored object
  after a scanner outage without re-upload. Scanning is owned by a leased
  attempt (migration 028: `scan_attempt_id` + `scan_attempt_expires_at`) —
  one atomic claim per document, only the owning attempt may publish, and an
  expired lease is reclaimable after worker failure. The claim is inside
  `_scan_and_finalize` so upload, same-bytes retry and rescan share it.
  Within ownership, `infected` beats a racing `clean`; a delayed
  `clean`/error never reverses a terminal verdict; the stored object's
  sha256 is verified before scanning. Real-PostgreSQL concurrency coverage:
  `tests/test_document_scan_ownership_db.py` (TEST_DATABASE_URL).
- All rejections and outcomes write `document_operation_log` rows (best
  effort, stderr alert on failure) — file contents and tokens never logged.
  This is the internal operational log, NOT platform audit integration:
  `legitify_auditor`/`AUDIT_DATABASE_URL` remains an outstanding external
  contract.
- Missing external contracts fail closed, do not stub them: files-service
  (`FILES_SERVICE_BASE_URL` unset → error), ClamAV (default scanner is
  `UnavailableScanner`), platform audit logger (op-log is the stand-in).
- Client document access is deliberately excluded — list/download deny
  `is_client`.

## PostgreSQL property validation and migration checksums

- The property DB suite requires both `TEST_DATABASE_URL` and
  `RUN_MATTER_PROPERTY_DB_TESTS=1`. It creates and removes a scratch schema;
  its generator is a schema-adjusted copy, not the installed migration-026
  function. Validate the actual migrated tables and
  `public.generate_property_id()` separately.
- Pin test connection settings after application imports: `config.py` calls
  `load_dotenv()` at import time and can restore higher-precedence application
  DSNs removed earlier. Assert the resolved DSN before opening a pool, then
  assert `current_database()` and `current_schema()` before test writes.
- The migration runner hashes raw UTF-8 file contents without newline
  normalization. Windows CRLF checkouts produce different ledger checksums
  from Git's LF blobs: migration 024 is `fa3f3f59…` with CRLF versus
  `c280d874…` with LF. Both appear in historical documentation. Check
  `git ls-files --eol` and the exact deployment artifact before migrating;
  do not rewrite applied files or ledger entries to suppress a mismatch.
- Migration 012 is not a generic ownership backfill: it permits an empty
  database or its guarded eight-matter/eight-transfer dataset only. A legacy
  database without a ledger requires a reviewed baseline and ownership plan;
  do not fabricate migration history or assign tenants to unknown records.
- Fresh-schema validation at `be9803f` exposed the sibling defect in migration
  001's `public.generate_transfer_id()`: under `search_path=transfers,public`,
  its `WHERE transfer_id = transfer_id` raises SQLSTATE `42702`, and v1
  matter creation returns 500. Migration 026 repairs only the property
  generator. Forward migration `029_deedly_generate_transfer_id_ambiguity_fix.sql`
  repairs the transfer generator with distinct variable names and a qualified
  table reference, preserving its signature and ID-format algorithm. Apply it
  through the runner before relying on new-matter creation; migration 001 is
  unchanged.
- Durable actual-schema coverage is in
  `python_server/tests/test_matter_property_workflow_db.py`. Its workflow
  cases create parent matters through the authenticated v1 API, not SQL
  fixtures; its installed-generator collision probe rolls back. It requires
  `RUN_MATTER_PROPERTY_WORKFLOW_DB_TESTS=1`, `TEST_DATABASE_URL`, and explicit
  `TEST_DATABASE_HOST` / `TEST_DATABASE_NAME` matching an approved disposable
  target (original `neondb` and system database names are rejected). The
  migrations must already be installed. Synthetic workflow rows are labelled
  `__workflow_test_*` and retained; the suite does not reset application tables.
  Run from `python_server/`: `python -B -m pytest -q -rs -p no:cacheprovider
  tests/test_matter_property_workflow_db.py`.
- `node --test scripts/migrate.test.mjs` runs offline checksum-contract tests
  against the runner in a no-connection sandbox. LF/CRLF mismatches and SQL
  changes remain hard failures, and unchanged artifacts cause no ledger writes.
  A read-only audit of the validation ledger found 7 LF and 19 CRLF historical
  entries, with no unexplained differences; this is an artifact-portability
  finding, not permission to normalize recorded migrations.
- Evidence boundary: these database checks ran from local Windows against an
  approved disposable database with synthetic fixtures and test JWTs. Publishing
  the code does not apply migrations or establish browser, live authentication,
  staging or production certification. A staging migration needs separate
  authorization, exact-artifact checksum preflight, target ledger/schema
  verification, and resolution of the existing-data upgrade path.

## Canonical transfer classification slice

- `GET /api/v1/transfers/classifications` is a staff-only, `transfers:read`
  reference-data read. The BFF verifies/forwards the caller JWT; FastAPI
  selects only active, selectable `category='transfer'` rows. No local UI
  fallback catalogue is used. Selectability does not certify a specialist
  workflow or document readiness.
- New-matter UI carries the canonical code and firm reference through create
  and readback. Existing saved classifications are read-only in the wizard;
  null/unavailable historical values are not silently reassigned. The existing
  API's optional/null classification compatibility remains unchanged.
- The guarded actual-schema workflow suite includes all 14 transfer codes
  from migrations 015/020, with create/replay/readback and invalid-code checks.
  Its fixtures are synthetic and retained in the approved disposable target;
  it does not apply migrations.
- `node e2e/matter-classifications.check.mjs` uses a loopback frontend server
  (default `http://127.0.0.1:4173`), intercepts every API call and blocks external
  requests. Prefer a static build served from a dedicated output directory for
  review until SEC-DEV-01 below is resolved; do not expose the existing Vite dev
  configuration. Optional `DEMO_ARTIFACT_DIR` captures labelled synthetic-demo
  screenshots. This is browser-contract evidence, not real BFF/FastAPI/auth
  certification. Playwright 1.63.0 is explicitly pinned as a dev dependency.
- Baseline environment findings on 2026-09-24: the machine's global Node was
  25.8.0 although the project requires 24.x; focused verification used a
  temporary npm-cached Node 24.21.0 without changing global configuration.
  `npm run lint` could not run because no ESLint configuration exists, and
  `npm audit` reported 24 findings (13 high) in unchanged dependencies.
  These remain separate baseline work; no audit fix or engine-policy change
  was used to suppress them.

### Baseline follow-ups recorded at classification review (2026-09-24)

- **SEC-DEV-01 — urgent before network-exposed development/preview use.**
  Vite 4.5.14 has Windows command-injection and file-disclosure advisories;
  `vite.config.ts` binds `0.0.0.0` and sets `allowedHosts: true`. Review a
  maintained patched Vite/plugin combination and safe default interface/host
  restrictions in a separate change. Loopback alone is not a security waiver.
  Never serve the pilot using a development server. Do not probe real secrets
  to demonstrate these issues.
- **SEC-BUILD-02 — narrowly remediate the development dependency tree.**
  All 13 high audit entries are dev-only in the installed graph: the five
  `@typescript-eslint/*` packages at 6.21.0 inherit minimatch findings;
  remaining affected entries are brace-expansion, browserslist, js-yaml,
  minimatch, nanoid, picomatch, postcss and vite. They are not 13 independent
  production HTTP vulnerabilities. Treat untrusted build/config/CSS/glob input
  as unsafe until fixed; use compatibility-reviewed updates, not a broad
  `npm audit fix --force` or a lowered audit gate.
- **SEC-RUNTIME-03 — separately triage the production graph.**
  `npm audit --omit=dev` reported zero high/critical but seven moderate entries
  in Express/body-parser/qs, React Router and DOMPurify. This is dependency
  classification, not proof of deployed safety. The vulnerable nanoid 3.3.11
  belongs to PostCSS; docx's production nanoid 5.1.16 is a separate copy not
  flagged by this audit. Verify the actual deployment artifact/entrypoint.
- **TOOL-LINT-01 — establish a real lint baseline.** Frontend/tooling owner:
  add a reviewed ESLint configuration compatible with the chosen parser/plugin
  and Node 24, preserve React Hooks/security checks, and report/fix scoped
  violations without disabling checks globally. Acceptance: a clean checkout
  loads the configuration and runs `npm run lint`; missing config is not a pass.
- **TOOL-NODE-01 — reproducible Node 24 setup.** Tooling/CI owner: select and
  document an exact supported Node 24 patch and Windows setup, align CI, retain
  the `24.x` engine requirement, and verify `npm ci`, typechecks, build and
  focused tests without relying on an undocumented npm-cache executable path.
  Do not silently change the machine-wide Node installation.

The detailed package/version/advisory triage and demonstration evidence are
recorded in the existing MVP0 plan checkpoint. These follow-ups are open; the
classification review does not waive them or authorize deployment.

## M2 staff list and pilot navigation checkpoint (2026-09-28)

- Migration 016, not migration 001, defines the current transfer lifecycle:
  `in_progress|complete`. The staff list accepts only those exact `status`
  values; omission means all. Empty, legacy, unknown and repeated values
  return 422 before queries. No lifecycle transition is introduced here.
- The BFF list verifies JWT/`transfers:read` and proxies the approved query
  parameters to FastAPI with the unchanged Bearer token. Client-role lists
  remain empty without DB/upstream calls or institution totals. Staff lists
  now require `DEEDLY_API_BASE_URL` and the FastAPI service to be available;
  missing configuration/transport/5xx failures return generic 503, not an
  empty success or a direct-DB fallback.
- FastAPI uses the same tenant/status predicate for rows and pagination count.
  `data.statusTotals = {total, inProgress, completed}` is institution-wide,
  independent of page and status selection. All roles remain scoped to the
  verified institution. Sorting includes an ID tie-breaker. These are ordinary
  read queries, not a shared transactional snapshot or a performance-certified
  query plan; representative PostgreSQL measurement remains deferred.
- The dashboard displays server totals and pagination, resets to page 1 on
  filter changes, rejects stale list responses and never invents totals from
  the loaded page. Text search is explicitly labelled as page-local. The
  legacy Draft chip/filter is removed. Wizard Save Details / Save and Continue
  labels and form-check indicators do not claim submission, legal readiness
  or completion. Financial persistence remains outside this slice.
- Pilot sidebar links are Transfers and Settings only. Hidden routes and
  backend quarantine remain unchanged. This is not role-aware client-shell
  certification; the M3 principal/session work remains separate.
- Property browser fixtures use the unslashed browser list/create paths and
  current classification/document contracts. The property and document
  harnesses block external requests and intercept all API requests; browser
  authentication, scanning and persistence are synthetic. They must not be
  used as live provider/database certification.
- Verification under Node 24.21.0 / Python 3.12.10: frontend, server and
  server-test typechecks passed; production build passed (existing stale
  Browserslist-data warning); 158 frontend/API/component tests, 177 Node BFF
  tests and 6 offline checksum tests passed. Static-build browser checks:
  property 5/5, staff list/navigation 4/4, classification 18/18, documents
  10/10. Offline Python discovery: 797 passed, 249 skipped; database suites
  and the unconfigured landed Entities source contract were not certified.
- Vitest is neither declared nor installed/configured. TypeScript suites use
  `node --import tsx --test "src/**/*.test.ts" "src/**/*.test.tsx"` and
  `node --import tsx --test "server/tests/*.test.ts"`, not Vitest. Do not let
  `npx vitest` download a new framework to disguise this missing check.
- Safe verification requires process-only empty `TEST_DATABASE_URL` and
  `TEST_MIGRATION_DATABASE_URL`, every DB opt-in disabled, and no ambient
  application/provider credentials. Python supports `PYTHON_DOTENV_DISABLED=1`.
  The offline Python run additionally blocked socket connections except the
  Windows asyncio `_fallback_socketpair` internal loopback call; it recorded
  zero other socket attempts. Blocking that internal call prevents async tests
  from starting and is a runner error, not a product failure. Node's explicit
  `dotenv.config()` ignores `DOTENV_CONFIG_PATH`; the full BFF run preloaded a
  test-only no-op for dotenv and a throwing `pg.Client.prototype.connect`
  guard before application imports. Existing route tests provide mock pools
  and loopback HTTP doubles. No DB suite was opted in, migrated or seeded.
- This completes the approved filtering/totals, labels, navigation and harness
  scope with offline evidence only. It does not close the full megaplan's
  reclassification design, complete multi-property wizard editing/readback,
  measured indexing, live authentication, legal-rule or pilot-release gates.
  SEC-BUILD-02, SEC-RUNTIME-03, TOOL-LINT-01 and TOOL-NODE-01 remain separate.

## M2 review follow-up (offline)

- Wizard document URLs require the persisted transfer UUID (`state.id`), never
  the human `TRF-*` reference. The property harness now rejects the latter;
  allowing both had hidden an existing application defect.
- BFF list query parsing must preserve literal question marks in values and
  subsequent parameters; FastAPI, not truncation, validates status values.
- Post-fix checks: 159 frontend/component, 178 BFF, 798 Python, 6 checksum,
  37 mocked browser checks, three typechecks and the production build passed.
- The 249 Python skips comprise 248 database-gated cases and one unconfigured
  landed Entities source-contract module. Particularly relevant: 85 v1 transfer,
  5 migration-016, 8 property-workflow and 25 core-edit/property DB cases.
  Eight status-authority skips exercise legacy handlers, not the v1 list.
  No live database, provider or authentication certification is implied.

## Startup and session-isolation review checkpoint

- `README.md` now documents the actual three-process startup: Vite 5173,
  Node BFF 3000, FastAPI 3100. Vite's proxy config reads `VITE_API_PORT` from
  process.env before dotenv loading, so export it explicitly; `.env` alone
  does not configure that proxy port. `npm run dev` does not start Python.
  Startup instructions are for an already approved environment, not permission
  to connect to shared services or apply migrations. M1 remains on hold.
- Login/refresh now carry a BFF-derived `principalKey` fingerprint of verified
  JWT identity/institution/role/ability claims. It is only a UI invalidation
  marker, never an authorization credential. Deploy compatible BFF/SPA versions;
  missing/malformed metadata fails closed. Existing JWT, tenant, cookie, CSRF
  and Web Locks checks remain authoritative and unchanged.
- Session generations invalidate outstanding protected responses, JSON bodies
  and replay attempts, and key protected React subtrees. Normal same-principal
  refresh preserves state. Cross-tab boundary messages and cookie checks on
  focus/visibility/request boundaries clear local state without adopting tokens.
  Intake history/prefill has a resettable per-session scope, preventing old
  navigation data from rehydrating another session's forms.
- `node e2e/session-isolation.check.mjs` requires a loopback Vite dev server
  on 4292 (override `SESSION_TEST_BASE`). It intercepts all API/auth traffic,
  blocks external HTTP requests, and drives the actual session module through
  its loaded URL, including any Vite HMR timestamp. Importing a different URL
  would create a second module instance and would not test the app's session.
- The README lists relevant PostgreSQL suites, opt-ins, fixture/cleanup hazards,
  exact-schema/host/name prerequisites and the missing actual-schema list/totals
  coverage. Do not enable DB tests without separate lifecycle approval. Counts,
  page rows and institution totals remain separate reads, not one snapshot.
  UI invalidation is not upstream revocation or cancellation of accepted writes.
- Checkpoint verification under Node 24.21.0 / Python 3.12.10: 166 frontend,
  179 BFF, 798 Python tests passed (249 deliberate DB/source-contract skips),
  6 checksum tests, all three typechecks and the production build passed.
  Browser checks: 10 session-isolation plus 37 existing static-build checks;
  synthetic transport only. No live auth/DB services, migrations or M1 work.

## DEEDLY-191 bounded property UI slice

- Saved-matter capture and existing-property attachment use the existing
  `POST /api/v1/transfers/{transfer UUID}/properties` contract. The transfer UUID
  is not the linked matter row UUID or the display reference. Search and readback
  keep their staff-only, institution-scoped backend contracts; no grants change.
- Both property search surfaces reject late responses. Saved-matter changes reset
  panel state; the wizard preserves all returned links on reload rather than
  displaying only the first. Confirmed matter creation binds its UUID into the
  wizard URL without resetting the current form or in-flight replay keys.
- Capture/attach retries retain request identity. A successful POST followed by a
  failed GET is reported as saved with unavailable readback and offers GET-only
  recovery. Failed/malformed property readback never means an empty saved list.
- Existing inactive, output and projection-less links remain readable. New UI
  writes remain input links only. Property editing/unlinking, primary selection,
  ordering, area capture, registry verification and cross-key manual deduplication
  require separate approved contracts; do not infer them from this slice.
- `BASE=http://127.0.0.1:<static-port> node e2e/matter-properties.check.mjs`
  covers capture/select, validation and write denials, failed/lost responses,
  duplicate/replay/conflict handling, multiple links, reload and stale requests.
  It intercepts every API request and blocks external requests; this is mocked
  browser evidence, not deployed auth, database, provider or privilege certification.
- Run Node tests under Node 24 with the existing `scripts/offline-test-guard.mjs`
  preload and empty database DSNs/disabled DB opt-ins. On Windows, invoke the
  selected Node executable directly: `npm.cmd` can use its adjacent Node binary
  even when another Node directory precedes it on PATH.

## DEEDLY-170A read-only milestone overview slice

- Milestone and activity reads bind through the canonical
  `transfers.matter_id` relationship only (`JOIN transfers t ON
  t.matter_id = m.id`), rechecking `t.accountable_institution_id`,
  `m.accountable_institution_id` and `m.matter_type = 'transfer'` in the read
  itself. `matters.source_record_id` has no uniqueness constraint and is never
  used as a fallback; missing, foreign or wrong-type canonical associations
  fail explicitly with 409, while duplicate legacy links are ignored. Reads
  never repair associations.
- The milestone overview renders only returned rows, preserves returned order,
  and keeps loading, failed, malformed and genuinely empty reads distinct.
  Counts are recorded milestone information, never legal readiness or transfer
  completion. Milestone and activity failures are independent; activity may be
  unavailable under the reviewed pilot grant matrix (no `milestone_history`
  grant) — that conflict stays explicit and grants are unchanged.
- Milestone editing, status changes, workflow transitions, instantiation,
  completion, waivers and reopening have no approved contract. UI issues no
  legacy milestone mutation requests; `TransferApi.updateMilestones` and
  `useTransfers.updateMilestones` fail without issuing a request. Do not
  restore quarantined milestone handlers or infer progression rules.
- No local audit events are fabricated. Activity rows render only returned
  data; a missing actor shows "Actor not recorded". The app-shell header's
  hard-coded "John Doe" display name is a separate pre-existing issue outside
  this slice.
- `BASE=http://127.0.0.1:<static-port> node e2e/milestone-overview.check.mjs`
  covers empty/malformed/failed reads, independent milestone/activity
  failures and retries, order preservation, no-editor read-only rendering,
  matter-switch clearing and stale-response rejection. It intercepts every
  API request and blocks external requests; this is mocked browser evidence,
  not deployed auth, database, grant or provider certification.

Milestone review Python regression runner: python scripts/verify-milestone-overview-offline.py. It selects six offline suites, disables dotenv and credential configuration, blocks asyncpg connections/pools and external sockets, permits only the Windows asyncio internal socketpair, and fails on any blocked attempt.
