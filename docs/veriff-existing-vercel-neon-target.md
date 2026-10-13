# Veriff TEST POC in the existing Vercel and Neon environments

Dean selected the existing Vercel application and Neon environment on
13 October 2026, while dedicated staging is being set up. This supersedes
the staging-only target choice; Veriff remains in TEST mode.

## Read-only inspection results

- Vercel project: `legitify-convey-hub`, ID `prj_yWs64XL0KRHSKTK5JxsIJSs0IhYE`.
- Team: `dean-whitsons-projects`, ID `team_AB913MRopZiwUOFDCbniRwfn`.
- Existing application alias: https://legitify-convey-hub.vercel.app.
- Latest listed deployment: `dpl_CQ93tCZHJuKkonFosCoKjobLNcCg`, Ready,
  Production, created 22 September 2026. It packages only Node
  `api/index` and `api/[...path]` functions.
- The current Production `DEEDLY_API_BASE_URL` points at
  `https://permitted-calculator-fitting-rec.trycloudflare.com`. Its public
  `/api/health/live` check failed; no local cloudflared process was found.
  The current API lane cannot be treated as available.
- Current Production `DB_SCHEMA` is `transfers`.
- The one specifically selected Production application DB connection setting,
  `ConveyHub_Transfers_POSTGRES_URL_NON_POOLING`, identifies Neon endpoint
  `ep-lucky-sun-awl88y3n.c-12.us-east-1.aws.neon.tech`, database
  `deedly_proposal_test`. A TLS-verified, read-only inspection failed with
  `InvalidPasswordError`; schema compatibility was therefore not verified.
- The older cached Preview configuration instead identifies
  `ep-icy-credit-aw21bc2n.c-12.us-east-1.aws.neon.tech`, database `neondb`.
  Read-only metadata inspection found `public.transfers` and no
  `transfer_parties` table. It is not interchangeable with the deployed target.
- Vercel lists the separate `deedly_pilot` integration too, but it is not the
  explicitly configured application DB connection selected above. No switch
  to the pilot database was made.

No application deployment, runtime configuration, database schema or grants
were changed. The project association was copied locally to ignored
`.vercel/project.json` for read-only CLI inspection.

## Activation work

1. Refresh the existing Vercel application DB setting with a working connection
   to the intended Neon database using the hosting secret settings. Keep
   connection strings/passwords out of chat and source control.
2. Recheck that target's canonical `transfers.transfers` and
   `transfers.transfer_parties` tables and manual passport fields. Apply only
   the reviewed Veriff table proposal after the exact target/schema is verified.
   Do not apply it to the cached Preview `neondb` or blindly migrate the app.
3. Establish a reachable Python API lane for this code. The existing
   `vercel.json` packages the Node BFF/SPA, not FastAPI. Vercel officially
   supports FastAPI as a Python function; a bounded Vercel-hosted API is a
   possible POC adaptation, but it is not implemented/deployed by this report
   and needs request lifecycle, pooling and routing validation. Do not point
   at an unavailable temporary tunnel.
4. Configure Veriff TEST API key/shared secret and a stable URL encryption
   key on the Python owner, with `IDV_PROVIDER=veriff`, `VERIFF_MODE=test`,
   and normal JWT/institution authorisation. Credentials remain absent from
   the private local Veriff configuration and inspected variable-name list.
5. Deploy compatible application/API code and run the saved-party flow in
   TEST mode, keeping all provider decisions labelled simulated.

The existing local implementation and tests remain in
`docs/veriff-api-integration.md`; the concrete additive table proposal is
`docs/proposals/veriff_verifications.sql`. None of the above infrastructure
checks attest passport authenticity or a real-provider trial.

## Secret handling during inspection

Automatic approval review rejected a bulk Production environment download
because unrelated secrets would be copied locally. No such download occurred.
Subsequent reads used encrypted variable metadata and narrowly selected target
settings. The single necessary DB connection setting was read only in process
memory for the authorised target check; its value was neither logged nor saved.

Official hosting reference checked 13 October 2026:
https://vercel.com/docs/frameworks/backend/fastapi.
