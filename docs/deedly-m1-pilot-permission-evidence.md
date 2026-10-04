# Pilot database permission evidence — 4 October 2026

## Result and provenance

The reviewed grant script committed once against the approved isolated pilot
database. Its standalone verifier passed under direct application-role login.
A separate sequence-default correction committed once under direct migration-role
login and passed fresh read-only verification. This report summarizes the saved
credential-free runner status logs inspected during code review; it does not
represent a new database connection or a rerun.

| Artifact | SHA-256 of executed bytes |
|---|---|
| `scripts/m1-pilot-grants.sql` | `2546504B8FC388B650FBFE4FE3AFCADF2627C3AC3A64FE2576ECB87B19978FEE` |
| `scripts/m1-pilot-grants-verify.sql` | `430E557DE3AA6D8AC274118E6C467566FA0886EEAAD05195BD85CEE912ED4364` |
| `scripts/m1-pilot-sequence-defaults.sql` | `F08E8005C40BC93679D2B7083B534D741DD50BE3D112B1F9EC3878927E5B7711` |

SQL bytes were independently hashed during review. Git/checkouts may transform
line endings: recheck actual bytes before any separately authorized execution.
Publishing these scripts does not authorize executing them.

## Invocation contracts

- Grant script: direct owner login, approved target, verified TLS, exclusive
  administration/data window; `psql -X -v ON_ERROR_STOP=1 -1 -f scripts/m1-pilot-grants.sql`.
- Standalone verifier: direct app login; `psql -X -v ON_ERROR_STOP=1 -f scripts/m1-pilot-grants-verify.sql`.
  It manages its own positive-flow transaction and rollback; do not wrap it in `-1`.
- Sequence-default remediation: direct migrator login; `psql -X -v ON_ERROR_STOP=1 -1 -f scripts/m1-pilot-sequence-defaults.sql`.
  It is a captured-state remediation with exact preconditions, not an idempotent
  migration. It rejects the already-remediated state. Do not rerun it.

Credentials were entered through local masked dialogs, never committed. The
saved logs confirm finally cleanup, disposed secure inputs and absent pilot
credential files. Verified client TLS used verify-full and TLS 1.3.

## Verified scope

- Grant invocation, standalone verifier and final evidence each exited 0.
- All 63 reviewed table rows matched the permission matrix: SELECT 23,
  INSERT 12, UPDATE 5; final evidence reported no DELETE, TRUNCATE,
  REFERENCES, TRIGGER or MAINTAIN on those tables.
- App CONNECT and schema USAGE were present; database CREATE/TEMPORARY
  and schema CREATE were absent.
- Exact relevant memberships, including OIDs/grantors/options, were restored;
  temporary owner-issued non-admin SET grants were removed.
- The 27-row ledger and all 12 captured runtime/audit table snapshots were
  unchanged, including the original 10 audit rows. Fixture residue was zero.
- Sequence remediation apply/verify exited 0. No effective app sequence-default
  privileges remained through migrator global/schema defaults, PUBLIC,
  inheritance or SET-then-inheritance paths. Protected table/column ACLs,
  ownership, memberships, captured role attributes, schema/database ACLs and
  unrelated defaults matched the before snapshot. No user sequences existed.

Saved source logs (local temporary evidence, not a durable external archive):
- `m1pilot-authorized-2546504B-attempt1-status.log`
- `m1pilot-authorized-2546504B-attempt1-final-evidence.log`
- `m1pilot-sequence-remediation-F08E8005-attempt2-status.log`

## Code review and limits

Membership grants are grantor-specific; original cloud_admin rows remain
untouched. Positive tests use the application search path before the fixture
savepoint and assert that it survives rollback. Fixture values follow the
captured installed constraints. Zero-row denied INSERTs use valid target
columns/types and retain explicit failure assertions if access is allowed.

During merge review, 11 offline fixture/catalog-model checks and 10 sequence
default checks passed; git diff whitespace checks passed. These model/static
checks do not replace PostgreSQL execution evidence and are stored locally in
temporary review tooling, not claimed as repository CI coverage.

Earlier authorized attempts failed and rolled back on circular ADMIN grants,
missing runtime search path and invalid fixtures; they were not retried without
separate authorization. Independent post-failure comparisons passed.

This scope does not establish actor attribution, tamper-proof audit provenance,
legacy property-sync DELETE-branch coverage, real file upload/scanning, deployed
application readiness or production certification. Default-privilege assurance
applies to future objects created as the migrator under the checked state;
later default/membership changes and objects created by other roles need review.
No new migrations, deployment or database executions occurred during merge review.
