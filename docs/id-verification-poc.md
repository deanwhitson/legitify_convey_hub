# Deedly passport identity-verification POC (Sumsub) — implementation map

**Branch:** `codex/sumsub-passport-poc` from `main` `d7f858f`.
**Status:** bounded proof of concept for team review. Fixture mode works fully
offline; sandbox mode is wired but untested (no Sumsub account exists yet);
live verification is NOT authorised and NOT tested.

## 1. Boundaries and ownership

**Backend owner: FastAPI (`python_server`)** owns all provider calls and
verification state. Rationale: the service already owns matter/party writes
(`routers/v1/transfers.py` + `services/transfer_party_service.py`), the
external-provider client pattern (`clients/entities.py`: injected
`httpx.AsyncClient`, `transport` test seam, timeout budgets, retry rules),
and institution scoping from the independently verified JWT
(`auth/dependencies.py::require_jwt`, `auth/policy.py`). The Node BFF remains
a thin auth-forwarding proxy (`server/routes/v1/goldenRecords.ts` pattern) and
gains no provider authority.

**Subject binding.** A verification attempt binds to an existing, authorised
`transfer_parties` row reached only through an authorised transfer:
`_authorize_transfer` (tenant-scoped, client-party fail-closed rule) +
`transfer_parties.transfer_id`/`accountable_institution_id` match. Subjects
are natural persons only (`entity_type = 'person'` — Golden Record-linked or
manual). A company/trust party verifies through a *specifically selected*
natural-person representative: the staff caller passes
`onBehalfOfPartyId` (a company/trust `transfer_parties` row on the same
transfer, same institution); the subject stays the person row in the path
and the attempt records `subject_kind = 'representative'` together with the
persisted `on_behalf_of_party_id`, which the status API returns on reload.
A non-person subject or a person `onBehalfOfPartyId` is rejected `422` — an
entity is never verified as a passport holder. Honest limitation: the
codebase has no dedicated representative-authorisation domain contract, so
the POC validates only that the selected representative is a person party on
the same authorised transfer — it records individual verification *on
behalf of* the entity and does not claim legal representative authority.

**Identity inputs.** Institution comes from the verified JWT
(`user.accountable_institution_id`), never from the payload. The provider
`externalUserId` is a server-derived opaque reference
`dly-<env>-<sha256(env|ai|transfer_party_id)[:24]>`: deterministic (so an
existing attempt is found, not duplicated), scoped by environment +
institution + subject, and irreversible. Browser-supplied applicant IDs,
level names and tenant IDs are never trusted.

**Storage.** Two new tables in migration
`src/lib/migrations/030_deedly_id_verification.sql` (authored with the
standard PROPOSED header — **not applied** anywhere; applying is a separate
approved step and grants follow the deployment runbook):

- `id_verification_attempts` — one row per (environment, AI, subject) attempt
  cycle: opaque external ref, provider applicant id, configured level, app
  status, sanitised review summary, correlation fields, provider/recorded
  timestamps. Unique key `(environment, accountable_institution_id,
  transfer_party_id, attempt_no)`; a partial unique index enforces one
  *open* attempt per subject so concurrent starts fold onto the same row
  instead of duplicating provider applicants.
- `id_verification_events` — append-only event ledger: dedupe key, attempt
  ref, event type, review fields, provider `createdAtMs`, received/processed
  times, and an `applied` processing flag. Raw webhook bodies are never
  stored — only allowlisted fields.

Event receipt and attempt-state application are one atomic repository
operation (`apply_event`): the durable implementation runs event INSERT +
attempt UPDATE inside a single transaction; a post-insert failure rolls
back the whole call, so a redelivery re-processes instead of folding onto a
half-processed event. A previously received but unapplied event (`applied =
false` path) is resumed and completed rather than treated as an ordinary
duplicate; `duplicate` is acknowledged only after durable successful
handling. Repository errors are translated into a sanitised retryable
storage failure (503), never a silent loss.

Repositories are dependency-injected: `InMemoryIdVerificationRepository` is
allowed **only** in `SUMSUB_MODE=fixture` (clearly labelled, per-process);
`sandbox` mode requires `PostgresIdVerificationRepository` and fails closed
(503 storage-unavailable) if the migration is not applied.

**Webhook placement.** The webhook route lives on FastAPI only
(`POST /api/v1/webhooks/sumsub`), reading
`request.body()` raw bytes before any parsing. It is deliberately *not*
proxied through the BFF: `server/index.ts` installs `express.json()`
globally, which would consume and reserialise the body before forwarding,
breaking HMAC-over-raw-bytes. Remote delivery therefore targets the FastAPI
service URL directly (documented in setup; localhost cannot receive remote
webhooks — a public HTTPS ingress is a deferred dependency).

## 2. Modes

`SUMSUB_MODE` (FastAPI env):

| Mode | Behaviour |
|---|---|
| `disabled` (default) | All verification routes return 503 `configuration_unavailable`. No provider objects exist. |
| `fixture` | In-memory repository + synthetic provider client. Every outcome carries `simulated: true` and a "SYNTHETIC" label. Zero provider traffic, no camera/document submission. |
| `sandbox` | `SumsubApiClient` + durable repository + all secrets required. Sandbox applicant namespace is kept separate by the `environment` column (`sandbox`), never `live`. |
| anything else (incl. `live`) | Refused at config resolution: live verification is not authorised — treated as configuration-unavailable. |

Missing/partial sandbox config (app token, secret, base URL, level name,
webhook secret, database) → safe `configuration_unavailable`, never a silent
fallback to fixture success.

## 3. Provider contract (Sumsub docs, accessed 2026-10-08)

- **API auth:** `X-App-Token`, `X-App-Access-Ts` (unix seconds),
  `X-App-Access-Sig` = lowercase hex HMAC-SHA256 of `ts + METHOD + path?query
  + body` — `docs.sumsub.com/reference/authentication`.
- **Applicant:** `POST /resources/applicants?levelName=<level>` body
  `{externalUserId}` → `{id}`; lookup by external ref:
  `GET /resources/applicants/-;externalUserId=<ref>`; review status:
  `GET /resources/applicants/{id}/status`.
- **SDK token:** `POST /resources/accessTokens/sdk` body
  `{ttlInSecs, userId, levelName}` → `{token}` — applicant-scoped, opaque,
  ≤1KB, treated as an arbitrary string, forwarded to the browser with
  `Cache-Control: no-store` and never logged.
- **WebSDK:** `@sumsub/websdk-react@2.9.0` (React wrapper over
  `@sumsub/websdk@2.9.0`) — `SumsubWebSdk` component with `accessToken`,
  `expirationHandler` (promised token renewal → `POST .../refresh`),
  `onMessage`, `onError`; the underlying `snsWebSdk` mounts an iframe
  (`camera; microphone; geolocation; clipboard-write; hid` allow) into the
  container. Loaded via `React.lazy` **only in sandbox mode** — the
  provider SDK is never fetched in fixture/disabled mode. UI callbacks
  are flow-progress signals only; they cannot set verified state.
- **Webhook auth:** `x-payload-digest` + `x-payload-digest-alg`
  (`HMAC_SHA256_HEX` default, `HMAC_SHA512_HEX` also accepted; `SHA1` is
  legacy and refused). Digest is HMAC over the *raw body bytes* with the
  webhook secret — compared with `hmac.compare_digest`, digest length and hex
  encoding validated first — `docs.sumsub.com/docs/webhook-manager`.
- **Events (user-verification webhooks):** payload fields `type`,
  `applicantId`, `externalUserId`, `correlationId` (shared across related
  events — NOT a unique event id), `levelName`, `sandboxMode`,
  `testMode` (manual sends only), `reviewStatus`, `reviewResult
  {reviewAnswer, rejectLabels, reviewRejectType, buttonIds}`,
  `createdAtMs`, `clientId`. Retry schedule: up to 6 deliveries; our
  endpoint must answer within 10s.
- **Sandbox presets:** Face match, Cross check, Image quality, Duplicates,
  PoA — each Skip/Run/Approve/Reject. Sandbox has no production approval
  algorithms — integration evidence only, not authenticity evidence.

## 4. Provider → app status mapping

Attempt `status` values: `not_started`, `started`, `pending`, `verified`,
`retry_requested`, `declined`, `review_required`, plus transport states
`configuration_unavailable` / `provider_unavailable` which are never stored
as verdicts.

| Provider event | App transition |
|---|---|
| `applicantCreated` | → `started` |
| `applicantPending` | → `pending` |
| `applicantReviewed` `reviewAnswer=GREEN` | → `verified` |
| `applicantReviewed` `reviewAnswer=RED` `reviewRejectType=RETRY` | → `retry_requested` |
| `applicantReviewed` `reviewAnswer=RED` `reviewRejectType=FINAL` | → `declined` |
| `applicantReviewed` RED/unknown/other missing `reviewRejectType` | → `review_required` |
| `applicantReviewed` missing/unrecognised `reviewResult` | → `review_required` (unrecognised can never become verified) |
| `applicantOnHold`, `applicantAwaitingService`, `applicantWorkflowFailed` | → `review_required` |
| `applicantReset` | → `not_started` (opens a new attempt cycle) |
| `testMode=true` | stored flagged, never applied to the attempt |
| unknown `type` | stored as `unhandled`, no transition, HTTP 200 |

`sandboxMode` in the payload must match the configured environment or the
event is rejected. `externalUserId` must bind to a known attempt's opaque
ref — unknown refs are accepted (200, provider sees a handled delivery) but
record as `unmatched` and never create an association.

**Dedupe key:** `sha256(environment | type | applicantId | correlationId |
reviewStatus | reviewAnswer | createdAtMs)` — `correlationId` is shared
across related events, so it cannot dedupe alone; identical redeliveries
fold onto one event row (replay-safe), while distinct events of the same
type on the same applicant are kept.

**Attempt binding:** `externalUserId` alone is never sufficient
authority. The resolver requires an exact applicantId match against bound
attempts (mismatch ⇒ `binding_mismatch`, never applied) and, when both
sides assert one, a compatible `levelName`. Retry cycles reuse the same
provider applicant, and `inspectionId` is an applicant-scoped identifier
(deprecated in the provider docs) — NOT a per-cycle identity — so it is
recorded and cross-checked but never routes an event. With multiple
cycles sharing the binding, the owning cycle is resolved by the event's
provider `createdAtMs` against recorded attempt start times (the cycle
window `[started_at, next_started_at)`): a newer event with the SAME
inspectionId binds the current cycle; an event inside an older window
binds that older cycle (disposition `prior_cycle`); an event predating
all recorded cycles, a missing timestamp, or an inspectionId
contradicting a recorded one is `ambiguous` ⇒ authenticated provider
reconcile, applied only when the reconcile confirms; reconcile failure ⇒
recorded but not applied.

**Ordering/staleness:** each applied event records its `createdAtMs`. The
ordering guard is revalidated inside the attempt row lock in `apply_event`,
so two deliveries that resolved before either committed cannot both apply:
strictly older ⇒ `stale`; an equal provider timestamp ⇒ `ambiguous`
(recorded, not applied) unless the apply carries an explicit
provider-confirmed verdict from reconciliation. The row lock is never held
across a provider call — reconciliation happens beforehand and only its
verdict enters the transaction.

**Reconciliation** (`GET /resources/applicants/{id}/status`) requires a
FINAL review status before any verdict applies: only `completed` maps a
reviewAnswer to a status (`GREEN`→verified, `RED+RETRY`→retry_requested,
`RED+FINAL`→declined, `RED`/unrecognised⇒review_required). Interim
statuses (`init`/`pending`/`prechecked`/`queued`/`awaitingUser`) map to
`pending`; `onHold` ⇒ `review_required`; missing/unrecognised status ⇒
reconcile fails and the event is not applied. A GREEN answer alone is
never an approval — the provider documents GREEN appearing in onHold —
and the persisted review summary is the provider-confirmed one, not the
ambiguous incoming event's. Terminal `verified`/`declined` is not regressed; a legitimate
new cycle (reset → pending → reviewed) proceeds only through events newer
than the terminal event's provider time. Equal timestamps are treated as
ambiguous → reconcile, not applied.

## 5. API surface

FastAPI (`/api/v1`):

- `POST /api/v1/transfers/{id}/parties/{partyId}/id-verification/session` —
  staff `transfers:write`, authorised transfer + person party. Start or
  resume: get-or-create attempt → provider applicant → SDK access token
  (sandbox) or synthetic token (fixture). Returns mode, status, opaque
  attempt id, token + TTL. Response `no-store`.
- `GET .../id-verification` — staff `transfers:read`; sanitised status
  summary (never raw provider payloads).
- `POST .../id-verification/refresh` — staff `transfers:write`; short-lived
  token renewal for the open attempt (authorised token renewal for the
  WebSDK expiry callback).
- `POST .../id-verification/retry` — staff `transfers:write`; only valid
  from `retry_requested`/`declined`/`not_started`; starts a new attempt
  cycle (attempt_no+1). Start/retry eligibility is enforced server-side:
  an open attempt resumes, a verified attempt refuses with `not_retryable`
  (a new attempt is never silently created after verified), and retry from
  a non-retryable status is refused.
- `POST /api/v1/webhooks/sumsub` — no JWT; provider HMAC only. Body cap
  64 KiB. Responses: `200` handled/duplicate/unmatched/test-mode/out-of-order;
  `503` on storage failure (never acknowledged before durable — provider
  retries), `401` invalid/missing signature or unsupported algorithm,
  `400` malformed/oversized/environment-mismatched payload.
- `POST /api/v1/webhooks/sumsub-fixture` — **fixture mode only** (404 in
  every other mode), and inside fixture mode still closed unless explicitly
  enabled: it requires the operator-set `SUMSUB_FIXTURE_RECEIVER_TOKEN`
  credential, presented in the `X-Dev-Fixture-Token` request header and
  compared in constant time, AND a loopback peer. A missing/unconfigured
  token, a wrong/absent header, or a non-loopback peer all get 404 — so
  fixture mode on a reachable host is never an unauthenticated status
  injector, and a fixed header value alone is not treated as
  authentication. The route injects a labelled synthetic event through the
  same dedupe/binding/apply path so the offline demo exercises real code.
- `GET /api/v1/id-verification/provider-status` is NOT a route — server-side
  reconcile happens inside the service (authenticated GET applicant status),
  not via a browser-callable endpoint.

BFF (`server/routes/v1/transfers.ts`, appended): `requireJwt` +
auth-forwarding proxy to FastAPI for the four staff routes (GET status,
POST session/refresh/retry), mirroring `goldenRecords.ts`. No webhook
proxy — the provider calls FastAPI directly.

UI entry point: `StepParties` `PartyCard` — a "Verify identity" button on
persisted person parties and "Verify representative" on persisted
company/trust parties, enabled only when the matter is saved (`state.id`,
`party.persistedPartyId`). For entity parties the card offers a
representative selector listing the matter's saved person parties; the
panel then opens on the chosen person with `onBehalfOfPartyId` set to the
entity. The panel (`IdVerificationPanel`) renders: subject + on-behalf-of
label + environment + `simulated` banner on every fixture outcome, status
badge, reported checks (performed/not_reported — a configured level is
never presented as proof each check ran), capture container (fixture:
labelled simulation placeholder, no SDK load; sandbox: lazy-loaded
`@sumsub/websdk-react` WebSDK mount), and the disclaimer that a provider
outcome is not evidence acceptance. Switching party/matter/session
remounts via `key`, disposes the SDK and discards stale responses
(generation guard).

A provider outcome never marks DOC-001/FICA accepted, never satisfies a
checklist obligation, and never advances a matter.

## 6. Secrets and data minimisation

- `SUMSUB_APP_TOKEN`, `SUMSUB_APP_SECRET`, `SUMSUB_WEBHOOK_SECRET` — server
  env only; webhook secret is separate from the API signing secret. Never
  in `VITE_`, bundles, URLs, logs, fixtures or responses. SDK access tokens
  are responses, no-store, never logged or persisted.
- Stored data is allowlisted only: statuses, reason codes (`rejectLabels`),
  `reviewRejectType`, level name, provider/event timestamps, opaque ids. No
  passport images, selfies, OCR/MRZ payloads, raw webhook bodies or tokens.
- Retention plan (docs §setup): attempt/event rows are POC-scoped; deletion
  is a local `DELETE` per attempt id — a local delete does NOT delete
  provider-side data (provider deletion is a separate dashboard/API action).

## 7. Deferred dependencies (honest)

Sumsub account + sandbox credentials; applied migration on a real DB; public
HTTPS webhook ingress; Vercel staging config (documented, not deployed);
WebSDK CSP allowances (`connect-src`/`frame-src` to `*.sumsub.com`, camera
permission) for the approved host; live-trial authorisation; per-check
evidence depth via status API; NFC is MobileSDK-only and out of scope.

## 8. Local setup

1. Repo deps: `npm install` (adds `@sumsub/websdk-react@2.9.0` — browser SDK
   for sandbox mode only) and `python_server` deps per repo convention.
2. FastAPI env (same `.env` the service reads):
   - Fixture demo (default for local review): `SUMSUB_MODE=fixture` AND
     `SUMSUB_FIXTURE_RECEIVER_TOKEN=<choose-a-local-token>` — the second
     variable explicitly enables the local simulation receiver (unset ⇒
     the endpoint is closed).
   - Disabled: `SUMSUB_MODE=off` — all verification routes answer
     `503 configuration_unavailable`.
   - Sandbox (needs the deferred account): `SUMSUB_MODE=sandbox` + the five
     `SUMSUB_*` fields in `.env.example`. Missing/partial → `503
     configuration_unavailable`, never a silent fixture fallback.
3. Run FastAPI on `PORT=3100` and the BFF on `PORT=3000` with
   `DEEDLY_API_BASE_URL=http://localhost:3100` (both read `PORT` — distinct
   ports required, per AGENTS.md).
4. Webhook delivery in sandbox mode targets the FastAPI service directly:
   `POST <fastapi-public-https>/api/v1/webhooks/sumsub`. Localhost cannot
   receive remote webhooks; a public HTTPS ingress and a durable DB with
   migration 030 applied are the remote-delivery dependencies.

Fixture demo walkthrough (no Sumsub account needed):

```powershell
# FastAPI terminal
$env:SUMSUB_MODE='fixture'; $env:SUMSUB_FIXTURE_RECEIVER_TOKEN='local-demo-token'; $env:PORT='3100'; python main.py
# BFF terminal
$env:PORT='3000'; $env:DEEDLY_API_BASE_URL='http://localhost:3100'; npm run dev:server
# Browser: open a saved matter -> Parties -> a saved person party -> "Verify identity"
#  -> "Start verification" shows the labelled simulated session.
# Inject a synthetic outcome through the same apply path the real webhook uses:
curl -X POST http://localhost:3100/api/v1/webhooks/sumsub-fixture `
  -H 'Content-Type: application/json' -H 'X-Dev-Fixture-Token: local-demo-token' `
  -d '{"type":"applicantReviewed","applicantId":"FIXTURE-APPLICANT-0001","externalUserId":"<from the session attempt>","createdAtMs":"2026-10-08 10:00:00.000","reviewResult":{"reviewAnswer":"GREEN"}}'
# "Refresh status" in the panel then shows Verified + Simulated.
```

The subject's opaque `externalUserId` is logged nowhere; obtain it for the
demo from the attempt row (or from `build_external_ref(env, ai, party_id)`).

### Integrated demo harness (no servers, no auth, no DB)

`src/idv-harness/` builds a standalone synthetic demo that mounts the **real**
`IdVerificationEntry` component (the same code `StepParties` renders) over a
labelled in-page mock backend (`mockBackend.ts`) and a mocked
`@sumsub/websdk-react` module (`mockWebSdk.tsx`, aliased only in
`vite.config.idv.ts`). It exercises entry, panel, capture mount, SDK message
lifecycle, refresh, event→status, reload persistence, subject switching,
representative selection and narrow layouts — with zero network traffic and
no JWT/tenant simulation (the in-page backend stands in for the whole
server; it does not relax the real authz path, which the backend suite
covers separately).

```powershell
npx vite build --config vite.config.idv.ts   # -> dist-idv/
node scripts/idv-harness-check.mjs           # serve + Playwright checks
```

Driver hooks (`window.__idv`, `window.__sdkEmit/__sdkExpire`) exist only in
the harness bundle — they are the harness's synthetic controls, equivalent
to the fixture webhook role.

## 9. Team demo script + results template

Scenarios to show (all fixture mode, synthetic subjects only):

| # | Scenario | Action | Expected |
|---|----------|--------|----------|
| 1 | Not started | Open panel on saved person party | `not_started`, Start button |
| 2 | Simulated session | Start | `fixture` mode banner, simulated token, capture placeholder — no provider traffic |
| 3 | Simulated verified | Inject `applicantReviewed GREEN` via fixture receiver | status `verified` + `Simulated` label |
| 4 | Retry path | Inject RED + `reviewRejectType=RETRY` | `retry_requested`, Retry button → new attempt cycle |
| 5 | Decline path | Inject RED + `reviewRejectType=FINAL` | `declined` + reject labels |
| 6 | Review required | Inject RED + unknown reject type | `review_required` |
| 7 | Missing config | `SUMSUB_MODE=off` | `configuration_unavailable` — distinct from decline |
| 8 | Entity party | Open "Verify representative" on a saved company party | person-representative selector; entity never the subject |
| 9 | Reload | Refresh page, reopen panel | authorised persisted state restored |
| 10 | Subject switch | Open panel for party A then party B | panel remounts; B never shows A's result |

Results template:

| Field | Entry |
|---|---|
| Scenario | (1–10 above or free text) |
| Subject reference | synthetic / opaque ref only — never a real person |
| Mode | fixture / sandbox |
| Date | |
| Requested checks | configured level name |
| Observed checks | provider-reported evidence only (performed / not_reported) |
| Outcome | app status observed |
| Elapsed time | |
| Evidence location | screenshot/log path (no secrets) |
| Limitation | what this run does NOT prove |

## 10. Verification results (this branch)

All offline; Node 24.x, Python 3.12, Playwright/Chromium.

| Suite | Command | Result |
|---|---|---|
| Python id-verification + readiness | `python -m unittest tests.test_id_verification tests.test_readiness` (from `python_server/`) | 94 run, **93 pass**, 1 skipped — the durable-Postgres `apply_event` integration class is opt-in under `TEST_DATABASE_URL` and was skipped (no disposable DB configured); durable DB coverage is therefore NOT claimed |
| Frontend id-verification | `npx tsx --test src/components/transfers/IdVerificationPanel.test.tsx src/lib/api/idVerification.test.ts` | **11/11 pass** |
| BFF party/matter proxies | `npx tsx --test server/tests/v1MatterParties.test.ts server/tests/v1MatterEditing.test.ts` | **24/24 pass** |
| Mounted browser harness | `npx vite build --config vite.config.idv.ts` + `node scripts/idv-harness-check.mjs` | **19/19 checks pass** — entry from party card, capture stays mounted through readiness/step/progress messages AND general `applicantStatus`/`onApplicantStatusChanged` payloads (interim AND final-looking), token-expiry refresh keeps capture alive, the documented `onApplicantVerificationCompleted` event exits to status, cancel exits, event→status, reload persistence, subject switching, representative panel, fixture-simulated capture, 390px layout; 0 external requests, 0 page errors |
| Typecheck | `npx tsc --noEmit` | clean |
| App build | `npm run build` | clean |
| Whitespace | `git diff --check` | clean |

Pre-existing suite note: full `unittest discover` on this base has ~119
`Settings(...)` TypeErrors in modules untouched by this branch
(`db_ssl_ca_file`/`db_ssl_no_verify` fields predate the POC on `main`) —
verified identical on the pristine base commit. `test_readiness`'s
migration-count assertion was updated 27→28 for the registered migration
030.

Review-fix regressions covered in `tests/test_id_verification.py`: durable
event insert contract (id/datetime/sanitised errors), post-insert failure
→ resumable replay → applied (fault injection), concurrent events on one
attempt, cross-attempt/previous-cycle/mismatched-applicant/old/equal/
missing-timestamp event binding, **same-applicant retry lifecycle**
(newer event with unchanged applicant/inspection ids binds the current
cycle; in-window event binds the older cycle; predates-all-cycles needs
reconcile), reconcile reviewStatus contract (onHold+GREEN ⇒ review
required, pending+GREEN ⇒ pending, missing/unknown status ⇒ not applied,
completed+GREEN ⇒ verified, completed+RED ⇒ retry_requested with the
provider-confirmed summary persisted), equal-timestamp concurrent events
cannot double-apply, reconcile-failure-not-applied, `/one` lookup path +
signing input + create/404/conflict/ambiguous-recovery,
`on_behalf_of_party_id` persistence + reload/switch, fixture-route
loopback+operator-token boundary (no token ⇒ closed, wrong/absent header
⇒ 404, non-loopback ⇒ 404), server-side start/retry transition policy
(verified/started/pending/retry_requested/declined/review_required/
no-open-attempt).

## 11. What this does and does not claim

- **Local UI/backend feasibility** — demonstrated offline: authz, subject
  binding, session lifecycle, webhook crypto/dedupe/ordering/atomic apply,
  attempt/event binding (applicantId + review-cycle + timestamps +
  reconcile), status mapping, stale-state guards, fixture/sandbox
  separation, and the mounted capture lifecycle (WebSDK progress messages
  keep capture mounted; only deliberate completion/cancel exits).
- **Sandbox integration correctness** — NOT demonstrated: requires the
  deferred Sumsub account, credentials, a durable DB with migration 030 and
  public webhook ingress.
- **Real verification effectiveness** — NOT demonstrated and NOT authorised:
  document authenticity, liveness efficacy and fraud-detection rates need a
  separately authorised live trial and suitable evaluation; one genuine
  passport test would not establish a detection rate.
- NFC is MobileSDK-only and out of scope; no web chip reading is claimed.
  OCR/MRZ checks, chip reading and cryptographic chip/signature
  authentication are not equivalent.

## 12. Cost note (provider figures, accessed 2026-10-08)

Public pricing listed a 14-day trial with 50 free checks; Basic
$1.35/verification with a $149 monthly minimum; Compliance $1.85 with a $299
minimum. These are provider charges — not total operating cost (hosting,
engineering, taxes, extras are separate) and not a subscription
recommendation. Verify trial eligibility, included checks and billing terms
before any activation. **No spend is authorised; no account exists.**
