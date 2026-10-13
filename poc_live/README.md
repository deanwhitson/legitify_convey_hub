# Personal LIVE/trial email-passport POC

This is the real email → Veriff capture → signed result workflow for Dean's
personal testing, independent of canonical DEEDLY matter/Golden Record routes.
The existing simulated walkthrough remains a separate artifact. No platform
JWT is fabricated and no matter/party permissions are bypassed: this service
owns only its two new POC tables, and authenticates its one configured owner
with a Gmail-delivered one-time code.

The owner's session is encrypted, HttpOnly/Secure/SameSite=Strict and lasts
four hours. Login codes expire after ten minutes, allow five guesses and
have a three-per-hour sending limit. All mutations enforce the same origin.
Only authenticated owner requests can create/list/refresh passport cases.
Contacts and capture URLs are encrypted at rest, and passport/biometric/raw
provider payloads are never stored. Provider session ID, vendor reference
and end-user UUID must agree before a signed result can apply.

The POC starts with one LIVE session allowed. Available free trial quota must
be explicitly confirmed in server configuration. The form also requires
recipient/quota confirmation before sending. LIVE session creation is never
automatically retried after an ambiguous response. Email acceptance does not
prove delivery; uncertain sends are not retried automatically.

The client gets a private Veriff-hosted capture link. Results are retrieved
from the signed decision API every ten seconds while the owner's page is
open and remain available in Neon after reload. A verified result requires
provider approval, passport type, current expiry and matching full name.
Unknown, contradictory or incomplete outcomes require review. No result
accepts FICA evidence or establishes legal readiness.

Deployment inputs: POC_OWNER_EMAIL, POC_SMTP_HOST, POC_SMTP_USERNAME,
POC_SMTP_PASSWORD, POC_DATABASE_URL, POC_ENCRYPTION_KEY, POC_LIVE_API_KEY,
POC_LIVE_SHARED_SECRET, POC_LIVE_BASE_URL, POC_TEST_KEY_HASH,
POC_TRIAL_CONFIRMED=yes, POC_LIVE_SESSION_LIMIT=1. Server-only secrets are
derived from the user-configured private file and must never be embedded
in index.html or printed. Database TLS verifies certificate/hostname and
retains required channel binding using Psycopg/libpq, with a new connection
per database operation to avoid serverless event-loop pooling problems.

`schema.sql` adds two separate POC tables in deedly_pilot. It was applied
on 13 October 2026 using the user-selected connection with verified TLS and
required channel binding: both tables started with zero rows, and no existing
matter/party/Golden Record/checklist rows or grants were changed. Do not apply
the schema again or delete unresolved reservations. This is not a change to
the canonical migration release manifest.

The provider transport is copied unchanged from the existing authenticated
Veriff REST client when preparing the deployable folder; it is not a second
independent implementation. The folder can be deployed as a Vercel FastAPI
Preview under the existing project. No production alias is changed.

Keep records and encryption key on code rollback. Removing unresolved
reservations can duplicate checks or email sends. No SMTP send or LIVE
session should be triggered by tests; use mocked transports, then have the
owner sign in and deliberately send the single authorised invitation.

## Deployment checkpoint, 13 October 2026

Code-only Vercel Preview:
https://legitify-convey-9a5q6lapq-dean-whitsons-projects.vercel.app
Deployment `dpl_3ftgpcQ8ACLGguAqTTuH8iCYuYG5` built successfully using
explicit `@vercel/python` routing to avoid the existing project's Vite build
settings. The Python sign-in page was opened successfully in the browser.
Direct browser navigation to the health API was blocked by the browser client;
no authenticated hosted workflow has been exercised yet.

Activation is blocked pending explicit permission to upload the private Gmail
app password, LIVE Veriff credentials, Neon connection and POC encryption key
as sensitive server variables on Preview branch codex/veriff-passport-api.
Automatic approval review rejected that exact secret transfer because local
configuration/hosting authorisation did not explicitly authorise this egress.
No secret transfer occurred and no workaround was used. No email or LIVE
session was created. Production settings/alias remain untouched.

Offline evidence: 122 tests passed and one existing DB-gated class skipped
(123 reported cases). New tests cover owner authentication/CSRF, recipient
confirmation, encryption, trial/test-key guards, bound outcome mapping,
idempotent replay, and blocking email when the signed initial read fails.
JavaScript syntax and Python compilation checks passed. The current Veriff
portal showed an active trial with 0/20 checks used; one POC session is allowed
and a 48-hour creation window is prepared. A non-creating random-session LIVE
lookup returned unsigned 404, which does not conclusively validate the shared
secret. The actual send flow verifies an owned-session response before sending
the client capture link.
