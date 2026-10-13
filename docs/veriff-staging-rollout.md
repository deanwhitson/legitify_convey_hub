# Veriff TEST integration on DEEDLY staging

Dean confirmed on 13 October 2026:

- Provider environment: **Veriff TEST integration**.
- Application target: **DEEDLY staging**.

Every provider result remains labelled simulated. The reported passport
acceptance/rejection in a TEST integration is useful flow evidence, not
evidence of real document authenticity checking.

## Target resolution

The inspected repository has Vercel configuration for the SPA/Express BFF.
Its release documents propose a separate FastAPI host and identify an isolated
pilot Neon database. They do not identify an active DEEDLY staging website,
FastAPI hosting service or staging database. Do not assume the pilot database
is staging or reuse its credentials.

Required identifiers before any remote changes:

1. Staging website URL and its hosting project/environment.
2. FastAPI hosting service and the staging HTTPS URL used by the BFF.
3. Staging database host/name/branch and the migration/runtime roles.

No remote settings, schema, grants or deployment were changed.

## Server settings

Configure these on the **staging Python service**, in its private secret store:

```dotenv
IDV_PROVIDER=veriff
VERIFF_MODE=test
VERIFF_BASE_URL=https://api-saas.veriff.com
VERIFF_API_KEY=<the selected TEST integration key>
VERIFF_SHARED_SECRET=<the selected TEST integration shared secret>
VERIFF_URL_ENCRYPTION_KEY=<stable Fernet key generated for staging>
SUMSUB_MODE=off
```

Use the exact base URL from the chosen integration's API Keys tab if it differs.
Never copy the local POC encryption key into staging by accident; generate a
staging key, retain it in the secret store and back it up for URL recovery.
Do not set these as VITE variables or in the browser-facing environment.

The BFF's existing `DEEDLY_API_BASE_URL` must point at the staging Python
service over HTTPS. Existing JWT, same-origin auth and database TLS controls
remain required. No authentication bypass is part of this setup.

## Concrete schema change for review

Apply `docs/proposals/veriff_verifications.sql` only after the identified
staging target and additive schema change are approved. Assign a migration
number and integrate with the established migration/checksum runbook. Review
the runtime role's SELECT/INSERT/UPDATE access to the new table and its read
access to the authorised transfer/party rows; do not grant broad schema access.

The table records institution/matter/party bindings, session references,
encrypted capture URLs and allowlisted decision summaries. No passport photos,
biometrics or raw provider identity payloads are stored there.

## Staging acceptance

1. Deploy compatible SPA/BFF/Python code from the Veriff integration branch.
2. Confirm normal staff login and an authorised saved manual person party with
   name, passport number and alpha-2 issuing country.
3. Start verification, open the hosted Veriff flow and return to Refresh status.
4. Use Station TEST session controls to exercise pending, approved, declined,
   resubmission/expiry and unknown outcomes. Approved needs a current matching
   passport decision payload; incomplete TEST payloads remain Review required.
5. Verify the TEST/simulated label remains visible even for Verified status.
6. Reload the panel and confirm the same durable attempt is retrieved.
7. Confirm another party/institution cannot read or resume that attempt.
8. Check technical provider/storage errors remain distinct from Declined.

No paid or LIVE verification is enabled. A later real-provider trial requires
the correctly identified LIVE/trial integration and its own consented test.

Rollback: restore prior application configuration/code while retaining the
new table and encryption key. Preserve unresolved creation reservations to
prevent duplicate provider sessions; reconcile them before attempting repair.
