# DEEDLY Veriff passport API integration

Implemented locally on `codex/veriff-passport-api`, based on the existing
saved-party ID verification slice (`codex/sumsub-passport-poc`, a34bb3e).
This checkout is separate from the current S2S and Sumsub checkouts.

## Behaviour

From a saved matter's person party, select Verify identity → Start verification
→ Open Veriff passport check. The actual subject captures their passport and
selfie directly in Veriff. Return to DEEDLY and select Refresh status. The
server retrieves and authenticates the decision through Veriff's API. Reloading
the panel retrieves its durable binding and decision again.

Company/trust verification uses the existing selected natural-person
representative flow; it does not establish legal representative authority.
Staff initiation does not authorise staff to capture themselves for a client.

The existing Node BFF forwards the verified caller's JWT to FastAPI.
FastAPI rechecks institution, matter, natural-person party and read/write
abilities. The API accepts no provider session ID, institution ID or outcome
from the browser. Client-role callers remain denied.

Set `IDV_PROVIDER=veriff` on the Python service. The existing paths remain:

- GET `/api/v1/transfers/{transfer}/parties/{party}/id-verification`
- POST the same path plus `/session`, `/refresh` or `/retry`

`/session` uses `POST /v1/sessions`, with `document.type=PASSPORT` and opaque
`vendorData`/`endUserId`. PASSPORT initialization is not proof the hosted flow
restricts document types; confirm that in Station. `/refresh` returns the
same hosted capture URL, not a new chargeable session. GET status uses
`GET /v1/sessions/{session UUID}/decision`, signs the UUID with HMAC-SHA256,
and verifies the response HMAC against the original bytes.

## Result rules

| Veriff result | DEEDLY status |
| --- | --- |
| `verification:null` | Pending |
| 9001 / approved, PASSPORT, current expiry, matching saved subject | Verified |
| 9001 with expired/missing expiry, non-passport, missing/mismatching subject details | Review required |
| 9102 / declined | Declined |
| 9103 / resubmission_requested | Retry requested |
| 9104 / expired, 9121 / abandoned | Retry requested |
| Unknown or contradictory code/status | Review required |
| Bad signature, identity correlation or provider/DB failure | Technical unavailable; no fabricated decline |

"Matching saved subject" requires the current saved name, passport number
and issuing country to match captured fields. The manual person party must
have `id_type=passport`, a number and an ISO alpha-2 country such as DE or ZA.
Golden Record parties currently have no authoritative cached passport pair;
their outcomes require review rather than being treated as fully matched.
Name comparison is conservative (case/spacing/punctuation/diacritics normalized);
different name order/additional names require review. A saved identity change
invalidates the verification context and blocks automatic new/resumed sessions.
Expiry is evaluated on the current South African calendar date.

Individual liveness/face-match checks are shown as unavailable because the
aggregate decision payload does not prove each individual check ran. Configure
the Veriff integration for document + selfie IDV. Results do not accept FICA
evidence, advance a checklist or update Legitify Golden Records.

## Configuration and storage

Copy `veriff.env.example` settings into the Python service's private `.env`
or its deployment secret store. Use the integration's exact API base URL,
API key and shared secret from Station. Do not put keys in VITE variables,
source control or this chat. Generate and back up the Fernet URL encryption key
once. It encrypts hosted capture URLs at rest; the URLs remain bearer-like
capabilities and are returned only to authorised staff over the protected API.

`VERIFF_MODE=test` labels every result simulated. Test integrations do not
verify document authenticity. `trial`/`live` label the configured real integration;
the API key determines the actual provider environment. An operator must
confirm the matching Station environment before enabling either mode.
Only use a free, available trial quota for the POC; paid usage is not enabled
or authorised by this implementation.

Durable storage is required in every Veriff mode. The additive SQL proposal is
`docs/proposals/veriff_verifications.sql`; it is intentionally outside the
migration runner and has **not been applied**. Assign a migration number and
review runtime SELECT/INSERT/UPDATE grants for the chosen isolated/deployment
database before application. Missing table/grants fail closed before provider
session creation. No production, shared or local schema was modified here.

The repository commits a `creating` reservation before the provider POST,
serializing starts with an institution/subject/integration-scoped transaction
advisory lock. Session IDs and encrypted URLs bind back to that reservation.
Interrupted/ambiguous creation stays unresolved and does not automatically
create another session. Reconcile that opaque reference in Station before an
administrator repairs the binding; never delete a hold simply to retry.
Retain the table if rolling code back so session history is preserved.

Signed decision retrieval uses optimistic state versions. It cannot overwrite
a concurrently updated row; a missing pending decision cannot erase a settled
outcome. No public webhook/tunnel, email invitation, client login or provider
SDK is added. Manual status refresh is the bounded POC result mechanism.

No passport images, biometric data, names, passport numbers or raw provider
payloads are stored in verification rows. Provider identity fields are matched
transiently against the authorised party. Rows retain references, an identity
fingerprint, encrypted capture URL, allowlisted check summaries and timestamps.
Veriff's own data retention remains controlled by the account settings.

## Local validation and demo

Install Python requirements in the approved local environment. From repo root:

```powershell
python scripts/verify-veriff-offline.py
node --import ./scripts/offline-test-guard.mjs --import tsx --test src/components/transfers/VeriffCapture.test.tsx src/components/transfers/IdVerificationPanel.test.tsx src/lib/api/idVerification.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --config vite.config.idv.ts
python -m http.server 4318 --bind 127.0.0.1 --directory dist-idv
```

Open http://127.0.0.1:4318/idv-harness.html?provider=veriff for the actual
DEEDLY panel with fictional parties and clearly labelled synthetic backend.
Do not follow its synthetic provider capture link. Use its demo outcome controls
to inspect pending/verified/declined/review states. This harness is excluded
from the production app and does not certify the backend or provider.

For the real app, use the established Vite/BFF/FastAPI three-process startup
in README.md, with distinct BFF/Python ports and `DEEDLY_API_BASE_URL` pointing
at Python. Supply normal authorised authentication and database configuration;
no fake access tokens or authentication bypasses are introduced.

Dean reported the valid German passport accepted and expired South African
passport rejected in Veriff on 13 October 2026. These are user-reported provider
tests, not DEEDLY API integration evidence. Repeat through the saved-party
DEEDLY flow once the real integration and storage are configured, recording only
the sanitised status/attempt/check summary. Do not store passport photos as test
fixtures. Test results cannot establish a fraud-detection rate.

Official docs accessed 13 October 2026:

- https://devdocs.veriff.com/apidocs/v1sessions
- https://devdocs.veriff.com/apidocs/v1sessionsiddecision-1
- https://devdocs.veriff.com/docs/general-faq

Remaining live dependencies: private Veriff credentials and correct mode,
approved durable schema/grants, a working authenticated DEEDLY environment,
and an end-to-end consenting-subject trial. No deployment or paid checks were
performed.

## Validation evidence, 13 October 2026

- Python: 100 passed, one existing Sumsub durable PostgreSQL test class skipped
  (101 reported cases). Veriff transport uses MockTransport; repository/lifecycle
  seams are synthetic. No real Veriff PostgreSQL persistence was exercised.
- Node: 14 UI/API tests plus 21 BFF route regression tests passed. New BFF cases
  cover unchanged JWT forwarding for all three Veriff session actions, write
  denial before upstream activity, signed-result projection transport and safe
  configuration/provider/storage error relay without arbitrary upstream details.
- Frontend and BFF/test TypeScript checks passed; production and harness Vite
  builds passed.
- Mounted local browser: saved-party panel opens Veriff capture; simulated
  verified and declined states render correctly; a second party remains Not
  started. Screenshot: workspace `output/veriff-poc/deedly-veriff-verified-demo.jpg`.
- A private `python_server/.env` was prepared with a newly generated URL
  encryption key. API credentials are blank. The file is ignored by Git.

This is local mocked integration evidence, not live-provider, deployed
authentication, database/grant or production certification.
