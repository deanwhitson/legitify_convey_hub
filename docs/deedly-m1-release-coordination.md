# M1 — Release coordination plan

Status: **draft — pending Dean's decisions** (marked `[DECISION]`). This is a
coordination document, not an implementation slice; nothing here provisions
infrastructure, changes secrets, or touches a database. Completed migration
tooling is referenced, not reopened. External document/blob-storage recovery
is excluded from M1 (megaplan places it under M0 operational acceptance /
M7 document transport).

## Pilot permission checkpoint — 4 October 2026

The reviewed pilot grant transaction and independent app-role verifier passed.
The separate sequence-default remediation also committed and passed independent
read-only verification. These results supersede the historical pending-grant,
rotation and fixture descriptions in section 2 below. Owner credential rotation
and old-credential rejection were confirmed; temporary credential cleanup passed.

Current results, exact artifact digests, invocation requirements and coverage
limits are retained in [pilot permission evidence](deedly-m1-pilot-permission-evidence.md).
This is bounded database evidence, not application or production certification.
Hosting, secret delivery and release sign-offs remain open.

## 1. M1 exit-criteria checklist

| # | Megaplan M1 exit criterion | Status | Evidence / owner |
|---|---|---|---|
| 1 | Exact-artifact clean install + repeat-run tests | **Merged evidence** | PR #14 — `deedly_m1_artifact_verify` rehearsal: 27/27 clean install, 0-applied repeat, full ledger deep-equal incl. `applied_at` (`docs/deedly-m1-artifact-execution.md`) |
| 2 | Historical mismatch rejection before writes | **Merged evidence** | PR #9 preflight + PR #14 — checksum/name/ledger mismatches rejected before any SQL |
| 3 | Target-mismatch rejection | **Merged evidence** | PR #11 — direct-host/database expectation enforced; pooler refused |
| 4 | Negative TLS tests | **Merged evidence** | PR #10 — `db-tls*.test.mjs`, `test_db_ssl_context.py`/`test_db_tls_fixture.py` |
| 5 | Migration preservation checks | **Merged evidence** | PR #11 — transaction semantics preserved; advisory lock serializes runners |
| 6 | Approved fresh pilot target | **Executed — pending app deploy** | `deedly_pilot` provisioned + 27/27 artifact applied (see §2); needs hosted services pointed at it |
| 7 | Recoverable release procedure | **Implementation gap** | §6 below defines it; needs owner sign-off after D1–D4 |
| 8 | Legacy `neondb` untouched / outside pilot path | **Done** | All rehearsals used disposable DBs; legacy untouched by construction |
| 9 | Startup fails closed on missing required non-dev config | **Merged evidence** | PR #15 — both services validate production config at startup |
| 10 | Environment health/readiness behavior | **Merged evidence** (code) + **gap** (live) | `/live` + `/ready` implemented PR #15; live verification is §7 — needs D1/D2 |
| 11 | Secrets delivery / rotation | **Decision needed** | `[DECISION]` D2 — names defined, delivery mechanism undecided |
| 12 | Approved deployment/CI configuration + release artifact manifest | **Partially merged / decision needed** | manifest + artifact hardening merged (PR #13/#14); *provider* contract + deploy-lock coordination `[DECISION]` D3 |
| 13 | Routing / separate ports / worker runtimes / file persistence / network restrictions | **Decision needed** | `[DECISION]` D3 (FastAPI host), D4 (internal-lane transport); §2 |
| 14 | Recovery objectives / alert ownership / incident sign-off | **Decision needed** | `[DECISION]` D5 |

## 2. Hosting topology — existing configuration vs proposed

**Existing (configured, not yet verified live):**

- `vercel.json` — Vite SPA + `api/[...path].ts`/`api/index.ts` serverless
  functions that import the compiled Express BFF (`dist/server/`). Rewrites
  send `/api/*` to the BFF and everything else to `index.html` — i.e. the
  same-origin-under-`/api` model the auth/cookie contract requires
  (HTTPS + `Secure; SameSite=Strict`).
- `build:server` compiles the BFF and copies `db-tls.mjs` + the approved
  manifest into `dist/server/` (PR #15); `includeFiles: dist/server/**`
  packs them into the serverless bundle.

**Proposed (not configured, needs approval):**

- **FastAPI** has *no* deployment config — only `requirements.txt` +
  `uvicorn`. It must NOT be a Vercel serverless function (cold starts, no
  persistent pool, 30s+ upstream S2S work). **Recommended default:**
  a single small container on AWS **App Runner** (or ECS Fargate) in
  `us-east-1` — the Neon direct host already lives there, keeping the
  DB lane in-region. App Runner is deliberately boring for a pilot:
  managed HTTPS, always-on min-1 instance, health checks. **Cost
  assumption (estimate only, not an acceptance):** 1 vCPU / 2 GB,
  always-on ≈ **$30–45/month**; a load balancer adds ~$16–20/month if
  ECS is chosen instead. Front it with the platform WAF/ingress already
  used for Legitify services where available. Liveness check →
  `/api/health/live`; traffic gate → `/api/health/ready`.
- **BFF↔FastAPI lane** (`DEEDLY_API_BASE_URL`): currently `https`-required
  in production validation. If the two run in the same private network a
  plain-http internal hop is a `[DECISION]` alternative — only with a
  documented private-network contract; default stays `https`.
- **Database**: Neon PostgreSQL (existing).

**Isolated pilot database** — target provided by Dean (D1 environment
decision taken):

- Neon project `deedly-pilot`, database `deedly_pilot`, endpoint
  `ep-muddy-dew-b71c24az.c-13.us-east-1.aws.neon.tech` (us-east-1 — same
  region as the FastAPI hosting default above).
- **Credential notes:** the project-owner credential lands on `neondb`
  (the project's default database) — it is a bootstrap/provisioning
  credential only, never a runtime or migration secret. The provided DSN
  carries `channel_binding=require`, which our TLS resolver deliberately
  rejects — deployment DSNs use `sslmode=verify-full` + the Neon CA with
  `channel_binding` omitted (or `prefer` where supported). The owner
  password was shared in-session; rotate it before relying on it as a
  bootstrap secret.
- **Provisioned (approved and executed):** `deedly_pilot` created on the
  endpoint; the two roles below created; the approved artifact executed
  via preflight → migrate → re-preflight — **27/27 applied**.
  **Provenance:** approved source revision `2e8192874c3088b838f99697feaee10b2a93df02`;
  manifest sha256 `596bca2a95647f0283572d6c788047ffe3c75e94805b2fa85d6b32a8bb42d854`;
  runner revision `b3b35c9` (this branch, `m1/release-coordination`).
  **Execution incident (recorded):** the first migrate run failed on
  `001_initial_schema.sql` at `CREATE EXTENSION uuid-ossp` — the migrate
  role lacked `CREATE` on the database. The file runs in an implicit
  transaction: zero statements persisted, no ledger row was written
  (verified by the subsequent clean install — no partial state, no skip
  anomalies). Granted `CREATE ON DATABASE` and re-ran: 27/27 applied,
  ledger checksums == manifest, no extras, repeat run skipped 27/0.
- **Historical privilege audit (before the successful 4 October correction):**

  | Probe / check | Result | Verdict |
  |---|---|---|
  | app `INSERT`/`UPDATE`/`DELETE` on `transfers_schema_migrations` | succeeded (rolled back) | **GAP** — default-priv grant covered the ledger |
  | app `TRUNCATE` ledger | denied | OK |
  | app `CREATE SCHEMA` / `CREATE TABLE public.*` | denied | OK |
  | app `CREATE TEMP TABLE` | succeeded | **GAP** — `PUBLIC` retains `TEMPORARY` on the database |
  | app `ALTER TABLE` | denied (not owner) | OK |
  | app `SET ROLE deedly_pilot_migrate` | denied; `pg_has_role` f/f | OK |
  | app `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `public` tables (27) | granted | OK |
  | app access to `transfers` schema (36 tables) | denied — no `USAGE` on schema; only 17/36 tables carry grants | **GAP** — runtime tables unreachable |
  | sequences | none exist in the schema (UUID/identity design) | nothing needed now |
  | `neondb_owner` membership | Neon auto-granted member+admin in both roles | note — bootstrap account; keep or revoke by policy |

  **Grant-script design (historical narrative; see the checkpoint above
  for the executed revision and corrected membership procedure).** Scope reconciled against middleware, not mounting:
  **every non-v1 router on both services is quarantined**
  (`quarantineLegacyRoute` → JWT then 503 "Legacy endpoint unavailable").
  Live DB code = `routers/v1/*` + their service/repository imports +
  health/readiness. **No grant supports a quarantined feature** — the
  earlier draft's accounts/tariff/clause/catalogue/users grants traced
  entirely to quarantined routers and were all removed.

  **Atomic apply+verify (single `psql -1` transaction):** guards →
  db-level revokes/grants → assert original membership options
  (`admin=t, inherit=f, set=f`) → **temporarily enable `SET TRUE` on the
  two owner memberships** (required — Neon grants membership with
  `set_option=f`, so `SET LOCAL ROLE` is denied without it; live run
  confirmed) → `SET LOCAL ROLE deedly_pilot_migrate` (all 63 tables +
  the transfers schema are owned by migrate — grants issued as owner
  silently no-op; live run confirmed) → object grants + default-privilege
  revocation → 63-row per-table effective-permission verify →
  `SET LOCAL ROLE deedly_pilot_app` → positive pilot flow under a
  savepoint (rolled back) → 16 denial tests → `SET LOCAL ROLE NONE`
  (verified legal in-transaction on PG18; returns to session user
  `neondb_owner`) → **restore membership options exactly**
  (`admin=t, inherit=f, set=f`) → verify restore + session identity →
  `COMMIT` only if every check passed. Membership changes and object
  grants live in one transaction — any failure rolls back both; the
  post-run catalog state is identical to pre-run.

  - `REVOKE TEMPORARY ... FROM PUBLIC` — granted to no one.
  - **I+U (5):** transfers.transfers, matters, transfer_parties,
    transfer_documents, transfer_document_requirements (upsert).
  - **I only (7):** transfers.properties, matter_properties,
    party_relationship_assignments, matter_estate_contexts,
    representative_assignments, document_operation_log;
    public.audit_log (invoker trigger writes — see below).
  - **SELECT only (11):** public.transfers_schema_migrations (readiness),
    public.bonds; transfers.matter_milestones, milestone_definitions,
    transfer_financials, matter_classification_options,
    entity_type_definitions, party_relationship_definitions,
    party_role_definitions, representative_capacity_definitions,
    document_requirement_rules.
  - **No grants (40):** all quarantined-feature tables — public.users
    (UPDATE site is in quarantined users routers), clauses,
    clause_versions, document_catalogue(+fields/requirements),
    document_templates, template_data_fields, generated_documents;
    transfers.account_firm_settings, tariff_schedules,
    proforma_statements, milestone_history, **parties** (v1 party data
    lives in transfer_parties — parties is legacy) — plus all
    never-referenced tables. No DELETE is granted anywhere (no live
    route deletes).
  - **`audit_log` INSERT caveat (documented):** the invoker trigger
    requires it for live transfers/properties writes, but the app can
    also forge rows — **not tamper-proof provenance**; tamper-evident
    audit is a follow-up.
  - **Verification inside the transaction:** exact database/role guards;
    a 63-row per-table expected matrix (SELECT/INSERT/UPDATE/DELETE +
    TRUNCATE/TRIGGER/REFERENCES always denied — `has_table_privilege`
    evaluates effective permissions incl. PUBLIC and role membership);
    database-level and schema-level checks; and a `pg_default_acl` check
    that **no** app default privileges survive — all defaults revoked,
    so future objects get zero app grants and any new access requires an
    explicit reviewed GRANT. Any mismatch raises → `psql -1` rolls
    everything back.
  - **Verify script `scripts/m1-pilot-grants-verify.sql`** (as
    `deedly_pilot_app`, standalone regression): same positive flow +
    denial suite for post-hoc re-verification; role-escalation asserted
    via `pg_has_role` (SET ROLE can't run inside a transaction — used
    `SET LOCAL ROLE` in the apply script instead).
  - **Bootstrap-owner membership:** unchanged; documented separately.
  - Roles are **not yet least-privilege** — pending approval + apply +
    verify.
- **Credential handling:** role passwords are generated values held in an
  ACL-protected handover file (`%TEMP%\deedly-pilot-credentials.txt`) —
  move to the approved secrets manager (D2) and delete the file. Owner
  password still pending rotation (shared in-session).
- **Two least-privilege roles:** `deedly_pilot_migrate` (owns schema,
  runs migrations via the artifact path only) and `deedly_pilot_app`
  (runtime: CONNECT + schema usage + DML only, **no DDL**) — a runtime
  credential can then never alter schema even if compromised.
- `verify-full` TLS with the platform CA; `connection_limit` set on the
  app role; statement_timeout left to the service-level probes.
- Neon **PITR** provides point-in-time recovery; the §5 backup/restore
  rehearsal evidence (PR #12) transfers — a fresh `pg_dump` rehearsal
  against this target before go-live is a gate item, not optional.
- **Cost assumption (estimate only):** a Neon scale-plan database of this
  size fits the existing plan's compute envelope for a pilot; the
  marginal cost is storage + compute-hours for one more database —
  negligible-to-small, confirm against the current Neon plan before
  approving `[DECISION]`.

## 3. Secrets, configuration, CA handling

**Required names** (names only — values live in the provider's secret
store; `docs/deedly-m1-startup-readiness.md` is the authority):

| Secret / config | Consumer | Notes |
|---|---|---|
| `DATABASE_URL` (or discrete `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) | BFF + FastAPI | production validation requires a real DSN or real discrete values |
| `SECRET_KEY` | both (BFF service-key, FastAPI) | required; not `dev-secret-change-me` |
| `JWT_SECRET` | both | every authenticated request depends on it — both services must get the *same* value |
| `LEGITIFY_API_BASE_URL` | both | https-only in production |
| `DEEDLY_API_BASE_URL` | BFF | https-only; points at the FastAPI deployment |
| `DB_SSL_CA_FILE` / `PGSSLROOTCERT` / DSN `sslrootcert` | both | CA for `verify-full`; delivery = mounted file or platform-managed CA `[DECISION]` D2 |
| `DOCUMENT_TOKEN_SECRET` | FastAPI | **policy `[DECISION]` D6** — recommended: independent secret (rotation isolation from `SECRET_KEY`); fallback to `SECRET_KEY` exists today |
| `AUTH_ALLOWED_ORIGINS` | BFF | deployed SPA origin(s); unset ⇒ same-origin Host match (acceptable for the pilot if `/api` is same-origin) |
| `MIGRATIONS_MANIFEST` | both | only if the manifest is mounted outside the package; unset = packaged copy |

**Rotation:** values rotate via the provider's secret store + a rolling
restart — no code change needed. `JWT_SECRET` rotation invalidates all
sessions → coordinate with the pilot window (recommend scheduling with
the firm).

## 4. Deployment ↔ migration coordination

**Existing control:** the runner's Postgres advisory lock serializes
*migrators* — two `migrate.mjs` runs can't interleave (PR #11).

**Limit:** that lock lives **inside the runner** — it does not stop a
release pipeline from deploying app code while a migration runs, nor two
releases from racing each other.

**Proposed coordination — three enforceable layers (recommended):**

1. **Pipeline concurrency** — a single `release` GitHub Actions workflow
   (manual `workflow_dispatch` only) with
   `concurrency: { group: m1-pilot-release, cancel-in-progress: false }`.
   GitHub enforces one run at a time; a second dispatch **queues**, never
   overlaps — unlike `cancel-in-progress: true` it cannot kill a migration
   halfway.
2. **Environment approval gate** — the job targets a GitHub
   `environment: pilot` with a *required reviewers* protection rule, so
   migration+deploy cannot run without a named approver — the accountable
   release authorization, enforced by the platform not by discipline.
   `[DECISION]` — needs repo-admin to create the environment + rule.
3. **Runner advisory lock** (existing, merged) — last-line defense inside
   `migrate.mjs`: two migrators can't interleave even if the pipeline
   layers are bypassed. **Limit:** it does not stop a deploy racing a
   migration or two pipelines racing — that's what layers 1–2 add.

Then, ordering within the (now serialized) release:

4. **Migration before app rollout** — run `migrate.mjs --migrations-dir=
   <recovered-artifact> --expect-manifest-sha256=<approved>` first; only
   then deploy BFF+FastAPI. The `/ready` schema gate (`schema-drift` /
   `schema-missing-migrations`) holds instances not-ready until the ledger
   matches the packaged manifest — so a mid-migration app instance never
   serves traffic.
5. **Fresh pilot only** — no `--baseline-through`, no ledger rewriting,
   no in-place upgrade of an existing DB.

## 5. Release order, readiness gates, failure/rollback

Order (per release):

```
1. Preflight (read-only)  : migrate-preflight.mjs against the artifact
2. Apply migrations       : migrate.mjs --migrations-dir/--expect-…
3. Post-apply preflight   : PASS, 0 pending
4. Deploy FastAPI         : /api/health/ready = ready
5. Deploy BFF+SPA         : /api/health/ready = ready (upstream probe
                            confirms FastAPI readiness too)
6. Smoke                  : §7 bounded live checks
```

**Rollback — compatibility-based checklist.** The exact-schema readiness
gate makes rollback a *compatibility question*, not a deploy preference:

1. **Is the target build's packaged manifest identical to the current
   ledger?** (compare manifest sha256 vs the ledger checksums via
   `migrate-preflight --migrations-dir/--expect-manifest-sha256`, or the
   recorded digests in the release record.)
   - **Yes** → code rollback is safe: redeploy that build; `/ready`
     recovers as soon as instances come up.
   - **No** (the bad release applied migrations) → **do not roll back
     code.** The older build will report `schema-missing-migrations` /
     `schema-drift` and stay not-ready. Forward-only: ship a fix build on
     the *same* schema, or — last resort — the backup-restore procedure
     (`docs/deedly-m1-backup-restore-evidence.md`), which is a separate
     approved recovery, not a deploy step.
2. **Never** edit applied SQL, rewrite the ledger, or use
   `--baseline-through` to make a rollback "fit" — the checksum gate
   exists precisely to forbid that.
3. **Migration failure mid-run:** per-file transactions mean a failed
   file rolls back; the ledger records exactly what applied. Recovery =
   rerun the same pinned artifact (idempotent skips) — never hand-patch.
4. **Session/auth compatibility:** a code rollback keeps `JWT_SECRET`
   unchanged ⇒ existing sessions survive; if a secret rotated in between,
   sessions re-login — expected, not an outage.
5. **Post-rollback verification:** both `/ready` endpoints `ready`, the
   §7 smoke re-run, and the rollback recorded in the release record with
   the manifest digests compared.

## 6. Approved artifact — provenance, storage, retention, ownership

- **Provenance:** three values recorded independently at approval time —
  approved source revision, expected manifest sha256 (git-blob digest),
  runner revision. Stored in the release record
  (`docs/deedly-m1-artifact-execution.md` pattern).
- **Storage:** canonical copy = the git object store (recoverable via
  `migration-recover.mjs --revision`). Retained physical copy for
  recovery drills — location proposed: the same evidence store as the
  §5 rehearsal output (`m1ex-run/` pattern), access-controlled.
- **Ownership — proposed roles for approval (no individuals named):**

  | Item | Proposed accountable role | Proposed retention |
  |---|---|---|
  | Approved artifact copy + provenance record | Schema/data owner (per G2) | Pilot duration + 90 days |
  | Release/rehearsal run logs & evidence | Release coordinator (engineering lead role) | Pilot duration + 90 days |
  | Secret-store values & rotation records | Platform owner role | Per provider policy; rotation events logged for pilot duration |
  | Pilot database backups (PITR + dumps) | Platform owner role | Neon PITR window + a weekly dump retained ≥30 days `[DECISION]` |
  | On-call / incident ownership | Ops owner role | For pilot duration |

  All assignments are proposals awaiting Dean's approval — `[DECISION]` D7.
- **Integrity:** retained copies verify against the pinned manifest
  digest; self-verify alone is explicitly not approval.

## 7. Bounded live-readiness verification plan (pilot environment)

After D1–D4 are approved and the environment exists — bounded, read-only,
no fixture data:

1. `GET /api/health/live` on **both** services → 200, no dependency.
2. `GET /api/health/ready` on **both** → `ready`, `checks` all `ok`
   (config/database/schema; BFF also `upstream`).
3. Kill/unreachable DB → both `/ready` → 503 `database: unavailable`
   while `/live` still 200; restore → next probe `ready` (no restart).
4. Deploy a build packaged with a stale manifest (or point at a DB with
   fewer applied rows) → `/ready` → `schema-missing-migrations`/`drift`.
5. FastAPI up + DB down → BFF `/ready` → 503 `upstream`/`unavailable`
   (proves the upstream probe is a *readiness* probe, not liveness).
6. Confirm responses/logs contain no DSN/hostname/secret — labels only.
7. Confirm `/api/auth` origin guard on the deployed origin (forged
   `Origin` → 403 before any upstream call).

## 8. Technical defaults vs decisions needed from Dean

**Technical defaults** — recommended; implementable without further input
(treated as decided unless objected to):

| ID | Default |
|---|---|
| T1 | FastAPI as one always-on container (App Runner / ECS Fargate, `us-east-1`, ~1 vCPU/2 GB); `/live` = liveness, `/ready` = traffic gate |
| T2 | Release serialization via Actions `concurrency` group + `environment: pilot` approval gate + runner advisory lock (§4) |
| T3 | Two-role DB model — `deedly_pilot_migrate` owns schema, `deedly_pilot_app` gets DML only, no DDL |
| T4 | Release order: preflight → migrate → verify → FastAPI → BFF+SPA → smoke (§5) |
| T5 | Rollback is compatibility-gated, not preference-gated (§5 checklist) |

**Decisions needing Dean's input** — smallest set:

| ID | Decision | Recommended default | Blocks |
|---|---|---|---|
| **D1** | ~~Approve the isolated pilot DB~~ — **provided** (`deedly-pilot` / `deedly_pilot`); remaining: create the two roles + shaped DSNs | §2 details | ~~environment~~ |
| **D2** | Secret-delivery provider + CA file delivery | provider env secrets; `DB_SSL_CA_FILE` via managed CA/mounted file | environment |
| **D3** | FastAPI host + authorize the `pilot` environment protection rule (repo admin) + accept the ~$30–65/mo cost estimate | App Runner | environment |
| **D4** | BFF↔FastAPI transport | `https` (fail closed) unless a documented private-network contract permits http | environment |
| **D5** | Name the on-call/incident owner | per megaplan G6 | go-live |
| **D6** | `DOCUMENT_TOKEN_SECRET` independent vs `SECRET_KEY` fallback | independent secret | environment |
| **D7** | Approve the §6 ownership/retention table (roles + periods) | as proposed | go-live |

D1–D4 unblock the pilot environment; D5–D7 are sign-offs. Nothing in the
T-column spends money or provisions anything — they are the engineering
positions this plan recommends implementing once D1–D4 are approved.
