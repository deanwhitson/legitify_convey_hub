-- ============================================================================
-- deedly_pilot — application-role grants: ATOMIC apply + verify (REVIEW ONLY)
--
-- Target:    ep-muddy-dew-b71c24az.c-13.us-east-1.aws.neon.tech / deedly_pilot
-- Run as:    neondb_owner
-- Method:    psql -X -v ON_ERROR_STOP=1 -1 -f m1-pilot-grants.sql
--
-- ATOMICITY: psql -1 wraps the entire file in ONE transaction. Order:
--   1. guards        — exact database + executing role (abort -> nothing)
--   2. snapshot exact membership rows; db-level REVOKE TEMPORARY + USAGE;
--      add two temporary owner-issued SET grants (ADMIN/INHERIT FALSE),
--      keeping the original cloud_admin membership rows untouched
--   3. grants        — SET LOCAL ROLE deedly_pilot_migrate (table/schema
--      owner), all REVOKE/GRANT + default-privilege changes
--   4. matrix verify — 63-row per-table effective-permission check
--   5. SET LOCAL ROLE deedly_pilot_app; positive pilot flow in a SAVEPOINT
--      -> assertions -> ROLLBACK TO SAVEPOINT (fixtures never commit)
--   6. denial tests — every denied op must raise insufficient_privilege
--   7. SET LOCAL ROLE NONE (verified on PG18: legal in-txn, returns to
--      session user neondb_owner) -> assert identity -> REVOKE only the
--      two owner-issued grants -> compare exact membership snapshot +
--      effective role access under neondb_owner -> COMMIT
--
-- ROLLBACK GUARANTEE: membership-option changes and object grants live in
-- the same transaction — any failure anywhere drops BOTH together; the
-- database can never be left with SET enabled on the memberships or with
-- partial grants.
--
-- SCOPE: live DB code only — routers/v1/* + their services/repositories +
-- health/readiness. Every non-v1 router on both services is quarantined
-- (503 "Legacy endpoint unavailable"); NO grant supports a quarantined
-- feature. No DELETE is granted anywhere (no live route deletes).
--
-- AUDIT PROVENANCE: GRANT INSERT on public.audit_log is REQUIRED — the
-- artifact's audit_trigger_function() is SECURITY INVOKER and live audited
-- writes (transfers, properties) insert rows AS THE APP. Consequence: the
-- app can also forge audit rows — this is NOT tamper-proof provenance.
-- Tamper-evident audit is a follow-up, out of scope.
--
-- BOOTSTRAP NOTE: cloud_admin granted neondb_owner ADMIN TRUE, INHERIT
-- FALSE, SET FALSE in both pilot roles. Preserve those exact rows; add
-- separate owner-issued ADMIN FALSE, INHERIT FALSE, SET TRUE rows only
-- for this transaction, remove them before COMMIT, and compare row OIDs,
-- role/member/grantor IDs and all options against the original snapshot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Guards: exact database + executing role.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() <> 'deedly_pilot' THEN
    RAISE EXCEPTION 'must run on deedly_pilot, connected to: %', current_database();
  END IF;
  IF current_user <> 'neondb_owner' OR session_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'must connect as neondb_owner: current=% session=%', current_user, session_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Database + public-schema level — must run AS neondb_owner (owns the
--    database; public schema is owned by pg_database_owner).
--    All 63 TABLES and the transfers SCHEMA are owned by
--    deedly_pilot_migrate — GRANT/REVOKE on them must run AS that role;
--    membership alone grants nothing (the first run proved this: every
--    table grant silently no-opped and the script aborted on default
--    privileges — the transaction rolled back cleanly).
-- ---------------------------------------------------------------------------
-- assert the original membership options so restoration below is exact;
-- if Neon ever changes these, abort rather than restore the wrong state
DO $$
DECLARE
  memberships jsonb;
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members m
      WHERE m.member = 'neondb_owner'::regrole
        AND m.roleid IN ('deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole)) <> 2
  OR (SELECT count(*) FROM pg_catalog.pg_auth_members m
      WHERE m.member = 'neondb_owner'::regrole
        AND m.roleid IN ('deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole)
        AND m.grantor = 'cloud_admin'::regrole
        AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option) <> 2
  THEN
    RAISE EXCEPTION 'expected exactly two cloud_admin grants (admin=t,inherit=f,set=f), with no other grantors';
  END IF;
  IF pg_catalog.pg_has_role('neondb_owner','deedly_pilot_migrate','SET')
     OR pg_catalog.pg_has_role('neondb_owner','deedly_pilot_app','SET') THEN
    RAISE EXCEPTION 'unexpected existing owner SET path to a pilot role';
  END IF;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) INTO memberships
  FROM pg_catalog.pg_auth_members m
  WHERE m.member IN ('neondb_owner'::regrole, 'deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole)
     OR m.roleid IN ('deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole)
     OR m.grantor IN ('neondb_owner'::regrole, 'deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole);
  PERFORM pg_catalog.set_config('m1pilot.memberships_before', memberships::text, true);
END $$;

REVOKE TEMPORARY ON DATABASE deedly_pilot FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO deedly_pilot_app;

-- temporarily enable SET using separate owner-issued non-admin grants;
-- leave cloud_admin rows untouched and remove only these grants at step 7
GRANT deedly_pilot_migrate TO neondb_owner
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY neondb_owner;
GRANT deedly_pilot_app TO neondb_owner
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY neondb_owner;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members m
      WHERE m.member = 'neondb_owner'::regrole
        AND m.roleid IN ('deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole)
        AND m.grantor = 'neondb_owner'::regrole
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option) <> 2
  OR NOT pg_catalog.pg_has_role('neondb_owner','deedly_pilot_migrate','SET')
  OR NOT pg_catalog.pg_has_role('neondb_owner','deedly_pilot_app','SET') THEN
    RAISE EXCEPTION 'temporary non-admin SET grants do not match the reviewed procedure';
  END IF;
END $$;

-- switch to the schema/table owner for all object-level grants
SET LOCAL ROLE deedly_pilot_migrate;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public    FROM deedly_pilot_app;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA transfers FROM deedly_pilot_app;

GRANT USAGE ON SCHEMA transfers TO deedly_pilot_app;

-- SELECT + INSERT + UPDATE (5) — v1 write paths incl. upsert targets
GRANT SELECT, INSERT, UPDATE ON TABLE
  transfers.transfers,
  transfers.matters,
  transfers.transfer_parties,
  transfers.transfer_documents,
  transfers.transfer_document_requirements
TO deedly_pilot_app;

-- SELECT + INSERT (7) — append-only writes + invoker audit inserts
GRANT SELECT, INSERT ON TABLE
  transfers.properties,
  transfers.matter_properties,
  transfers.party_relationship_assignments,
  transfers.matter_estate_contexts,
  transfers.representative_assignments,
  transfers.document_operation_log,
  public.audit_log
TO deedly_pilot_app;

-- SELECT only (11) — control table + live-read reference tables
GRANT SELECT ON TABLE
  public.transfers_schema_migrations,
  public.bonds,
  transfers.matter_milestones,
  transfers.milestone_definitions,
  transfers.transfer_financials,
  transfers.matter_classification_options,
  transfers.entity_type_definitions,
  transfers.party_relationship_definitions,
  transfers.party_role_definitions,
  transfers.representative_capacity_definitions,
  transfers.document_requirement_rules
TO deedly_pilot_app;

-- NO GRANTS (40) — quarantined-feature tables (users, clauses, catalogue,
-- templates, generated_documents; account_firm_settings, tariff_schedules,
-- proforma_statements, milestone_history, parties) + never-referenced
-- tables. A future enabled route requires a reviewed GRANT.

-- ---------------------------------------------------------------------------
-- 3. Default privileges: remove ALL app defaults on future objects — the old
--    S/I/U/D default is how the ledger became writable; the SELECT default
--    from the earlier draft goes too. Future access = explicit reviewed GRANT.
--    Runs as deedly_pilot_migrate (current role after the switch above) —
--    FOR ROLE is unavailable here because membership does not authorize it.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public    REVOKE ALL ON TABLES FROM deedly_pilot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA transfers REVOKE ALL ON TABLES FROM deedly_pilot_app;

-- ---------------------------------------------------------------------------
-- 4. Matrix verification — per-table effective permissions via
--    has_table_privilege (includes PUBLIC grants + role memberships, so
--    inherited access is covered) + REFERENCES/TRUNCATE/TRIGGER must be
--    denied on every table + db/schema level + no app default privileges
--    survive on future objects.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  bad text[] := '{}';
BEGIN
  IF NOT has_database_privilege('deedly_pilot_app','deedly_pilot','CONNECT')    THEN bad := bad || 'db:app CONNECT missing'; END IF;
  IF     has_database_privilege('deedly_pilot_app','deedly_pilot','CREATE')     THEN bad := bad || 'db:app CREATE present'; END IF;
  IF     has_database_privilege('deedly_pilot_app','deedly_pilot','TEMPORARY')  THEN bad := bad || 'db:app TEMPORARY present'; END IF;
  IF NOT has_database_privilege('deedly_pilot_migrate','deedly_pilot','CREATE') THEN bad := bad || 'db:migrate CREATE missing'; END IF;
  IF NOT has_schema_privilege('deedly_pilot_app','public','USAGE')              THEN bad := bad || 'schema:public USAGE missing'; END IF;
  IF     has_schema_privilege('deedly_pilot_app','public','CREATE')             THEN bad := bad || 'schema:public CREATE present'; END IF;
  IF NOT has_schema_privilege('deedly_pilot_app','transfers','USAGE')           THEN bad := bad || 'schema:transfers USAGE missing'; END IF;
  IF     has_schema_privilege('deedly_pilot_app','transfers','CREATE')          THEN bad := bad || 'schema:transfers CREATE present'; END IF;
  IF     pg_has_role('deedly_pilot_app','deedly_pilot_migrate','USAGE')         THEN bad := bad || 'role: app can use migrate'; END IF;

  FOR r IN SELECT * FROM (VALUES
    -- transfers I+U (5)
    ('transfers','transfers',true,true,true,false),
    ('transfers','matters',true,true,true,false),
    ('transfers','transfer_parties',true,true,true,false),
    ('transfers','transfer_documents',true,true,true,false),
    ('transfers','transfer_document_requirements',true,true,true,false),
    -- transfers I (6)
    ('transfers','properties',true,true,false,false),
    ('transfers','matter_properties',true,true,false,false),
    ('transfers','party_relationship_assignments',true,true,false,false),
    ('transfers','matter_estate_contexts',true,true,false,false),
    ('transfers','representative_assignments',true,true,false,false),
    ('transfers','document_operation_log',true,true,false,false),
    -- transfers SELECT-only (9)
    ('transfers','matter_milestones',true,false,false,false),
    ('transfers','milestone_definitions',true,false,false,false),
    ('transfers','transfer_financials',true,false,false,false),
    ('transfers','matter_classification_options',true,false,false,false),
    ('transfers','entity_type_definitions',true,false,false,false),
    ('transfers','party_relationship_definitions',true,false,false,false),
    ('transfers','party_role_definitions',true,false,false,false),
    ('transfers','representative_capacity_definitions',true,false,false,false),
    ('transfers','document_requirement_rules',true,false,false,false),
    -- transfers ungranted (16)
    ('transfers','parties',false,false,false,false),
    ('transfers','account_firm_settings',false,false,false,false),
    ('transfers','tariff_schedules',false,false,false,false),
    ('transfers','proforma_statements',false,false,false,false),
    ('transfers','milestone_history',false,false,false,false),
    ('transfers','clearance_records',false,false,false,false),
    ('transfers','compliance_certificates',false,false,false,false),
    ('transfers','classification_document_map',false,false,false,false),
    ('transfers','classification_milestone_map',false,false,false,false),
    ('transfers','classification_party_role_rules',false,false,false,false),
    ('transfers','matter_accounts',false,false,false,false),
    ('transfers','matter_account_entries',false,false,false,false),
    ('transfers','municipal_accounts',false,false,false,false),
    ('transfers','refunds',false,false,false,false),
    ('transfers','transfer_conditions',false,false,false,false),
    ('transfers','transfer_guarantees',false,false,false,false),
    -- public granted (3)
    ('public','audit_log',true,true,false,false),
    ('public','transfers_schema_migrations',true,false,false,false),
    ('public','bonds',true,false,false,false),
    -- public ungranted (24)
    ('public','users',false,false,false,false),
    ('public','clauses',false,false,false,false),
    ('public','clause_versions',false,false,false,false),
    ('public','document_catalogue',false,false,false,false),
    ('public','document_catalogue_fields',false,false,false,false),
    ('public','document_catalogue_requirements',false,false,false,false),
    ('public','document_templates',false,false,false,false),
    ('public','template_data_fields',false,false,false,false),
    ('public','generated_documents',false,false,false,false),
    ('public','activity_log',false,false,false,false),
    ('public','cancellations',false,false,false,false),
    ('public','communications',false,false,false,false),
    ('public','document_parties',false,false,false,false),
    ('public','document_template_versions',false,false,false,false),
    ('public','documents',false,false,false,false),
    ('public','fica_verifications',false,false,false,false),
    ('public','firms',false,false,false,false),
    ('public','generated_document_clauses',false,false,false,false),
    ('public','golden_record_links',false,false,false,false),
    ('public','matter_parties',false,false,false,false),
    ('public','party_bank_accounts',false,false,false,false),
    ('public','template_version_clauses',false,false,false,false),
    ('public','template_version_fields',false,false,false,false),
    ('public','user_preferences',false,false,false,false)
  ) AS e(sch,tbl,sel,ins,upd,del)
  LOOP
    IF has_table_privilege('deedly_pilot_app', r.sch||'.'||r.tbl, 'SELECT')     <> r.sel
    OR has_table_privilege('deedly_pilot_app', r.sch||'.'||r.tbl, 'INSERT')     <> r.ins
    OR has_table_privilege('deedly_pilot_app', r.sch||'.'||r.tbl, 'UPDATE')     <> r.upd
    OR has_table_privilege('deedly_pilot_app', r.sch||'.'||r.tbl, 'DELETE')     <> r.del
    OR has_table_privilege('deedly_pilot_app', r.sch||'.'||r.tbl, 'TRUNCATE')
    OR has_table_privilege('deedly_pilot_app', r.sch||'.'||r.tbl, 'TRIGGER')
    OR has_table_privilege('deedly_pilot_app', r.sch||'.'||r.tbl, 'REFERENCES')
    THEN bad := bad || (r.sch||'.'||r.tbl);
    END IF;
  END LOOP;

  -- future default privileges: no app privilege letters may survive
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = 'deedly_pilot_migrate'::regrole
      AND d.defaclobjtype = 'r'
      AND d.defaclacl::text ~ 'deedly_pilot_app=[a-zA-Z]'
  ) THEN bad := bad || 'default-privileges: app defaults still present'; END IF;

  IF array_length(bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'grant verification FAILED for: %', array_to_string(bad, ', ');
  END IF;
  RAISE NOTICE 'matrix OK — 63 tables + db/schema/defaults verified';
END $$;

-- ---------------------------------------------------------------------------
-- 5. Switch to the app role inside the transaction (SET enabled at step 2
--    on the session user's membership), then prove the live flow under
--    savepoint and roll fixtures back.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE deedly_pilot_app;
SET LOCAL search_path = transfers, public;

DO $$
BEGIN
  IF current_user <> 'deedly_pilot_app' THEN
    RAISE EXCEPTION 'runtime path check must execute as deedly_pilot_app';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(current_user, 'transfers', 'USAGE')
     OR NOT pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE') THEN
    RAISE EXCEPTION 'app schema USAGE missing for runtime search_path';
  END IF;
  IF pg_catalog.current_setting('search_path') <> 'transfers, public'
     OR pg_catalog.to_regclass('matters') IS DISTINCT FROM 'transfers.matters'::regclass THEN
    RAISE EXCEPTION 'runtime search_path must resolve matters to transfers.matters';
  END IF;
END $$;

SAVEPOINT m1_fixtures;

DO $$
DECLARE
  ai   int := 900001;                 -- synthetic accountable_institution_id
  prop uuid; tr uuid; mat uuid; tp uuid; tdoc uuid;
  n    int;  dn text;
BEGIN
  -- property create + audit row (invoker trigger)
  INSERT INTO transfers.properties
    (property_id, street_address, city, province, property_type, accountable_institution_id)
  VALUES ('M1SYN-PROP-1', '1 Synthetic St', 'Cape Town', 'Western Cape', 'Freehold', ai)
  RETURNING id INTO prop;
  SELECT count(*) INTO n FROM public.audit_log
   WHERE table_name='properties' AND action='INSERT' AND record_id::text = prop::text;
  IF n <> 1 THEN RAISE EXCEPTION 'audit row missing: properties INSERT'; END IF;

  -- transfer create (FK to property) + readback + audit row
  INSERT INTO transfers.transfers
    (transfer_id, property_address, purchase_price, accountable_institution_id, property_id, status)
  VALUES ('M1SYN-TR-1', '1 Synthetic St', 1000000, ai, prop, 'in_progress')
  RETURNING id INTO tr;
  SELECT count(*) INTO n FROM public.audit_log
   WHERE table_name='transfers' AND action='INSERT' AND record_id::text = tr::text;
  IF n <> 1 THEN RAISE EXCEPTION 'audit row missing: transfers INSERT'; END IF;

  -- transfer update -> audit UPDATE row + readback
  UPDATE transfers.transfers SET purchase_price = 1000001 WHERE id = tr;
  SELECT count(*) INTO n FROM public.audit_log
   WHERE table_name='transfers' AND action='UPDATE' AND record_id::text = tr::text;
  IF n <> 1 THEN RAISE EXCEPTION 'audit row missing: transfers UPDATE'; END IF;
  SELECT count(*) INTO n FROM transfers.transfers WHERE id = tr AND purchase_price = 1000001;
  IF n <> 1 THEN RAISE EXCEPTION 'transfer readback failed'; END IF;

  -- matter + property link
  INSERT INTO transfers.matters (reference_number, matter_type, status, accountable_institution_id)
  VALUES ('M1SYN-MAT-1', 'transfer', 'in_progress', ai) RETURNING id INTO mat;
  INSERT INTO transfers.matter_properties (matter_id, property_kind, property_id, accountable_institution_id)
  VALUES (mat, 'input', prop, ai);

  -- manual party attach + update
  INSERT INTO transfers.transfer_parties
    (transfer_id, entity_type, role, accountable_institution_id, party_source, manual_name)
  VALUES (tr, 'person', 'transferor', ai, 'manual', 'M1 Synthetic Seller')
  RETURNING id INTO tp;
  UPDATE transfers.transfer_parties SET is_primary_contact = true WHERE id = tp;

  -- requirement upsert (INSERT + ON CONFLICT DO UPDATE -> needs I+U)
  INSERT INTO transfers.transfer_document_requirements
    (transfer_id, accountable_institution_id, requirement_key, display_name, source)
  VALUES (tr, ai, 'm1syn_req', 'M1 Synthetic Requirement', 'baseline');
  INSERT INTO transfers.transfer_document_requirements
    (transfer_id, accountable_institution_id, requirement_key, display_name, source)
  VALUES (tr, ai, 'm1syn_req', 'M1 Synthetic Requirement v2', 'baseline')
  ON CONFLICT (transfer_id, requirement_key)
  DO UPDATE SET display_name = EXCLUDED.display_name;
  SELECT display_name INTO dn FROM transfers.transfer_document_requirements
   WHERE transfer_id = tr AND requirement_key = 'm1syn_req';
  IF dn <> 'M1 Synthetic Requirement v2' THEN RAISE EXCEPTION 'upsert readback failed'; END IF;

  -- document INSERT ... RETURNING + update (RETURNING relies on the SELECT grant)
  INSERT INTO transfers.transfer_documents (transfer_id, name, accountable_institution_id)
  VALUES (tr, 'm1syn.pdf', ai) RETURNING id INTO tdoc;
  IF tdoc IS NULL THEN RAISE EXCEPTION 'document RETURNING produced null id'; END IF;
  UPDATE transfers.transfer_documents SET status = 'uploaded' WHERE id = tdoc;

  -- append-only operation log + reference reads
  INSERT INTO transfers.document_operation_log (operation, outcome, accountable_institution_id)
  VALUES ('document_created', 'success', ai);
  PERFORM 1 FROM transfers.entity_type_definitions LIMIT 1;
  PERFORM 1 FROM transfers.matter_classification_options LIMIT 1;
  PERFORM 1 FROM transfers.party_role_definitions LIMIT 1;

  RAISE NOTICE 'positive flow OK — full pilot write path verified as app role';
END $$;

ROLLBACK TO SAVEPOINT m1_fixtures;   -- synthetic rows AND audit rows discarded

DO $$
BEGIN
  IF current_user <> 'deedly_pilot_app' THEN
    RAISE EXCEPTION 'runtime path check must execute as deedly_pilot_app';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(current_user, 'transfers', 'USAGE')
     OR NOT pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE') THEN
    RAISE EXCEPTION 'app schema USAGE missing for runtime search_path';
  END IF;
  IF pg_catalog.current_setting('search_path') <> 'transfers, public'
     OR pg_catalog.to_regclass('matters') IS DISTINCT FROM 'transfers.matters'::regclass THEN
    RAISE EXCEPTION 'runtime search_path must resolve matters to transfers.matters';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Denial tests — each must raise insufficient_privilege; a success or a
--    different error aborts the whole transaction.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  BEGIN INSERT INTO public.transfers_schema_migrations (filename, checksum)
    SELECT 'M1SYN-denied.sql', repeat('0', 64) WHERE false;
    RAISE EXCEPTION 'FAIL: ledger INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ledger INSERT'; END;
  BEGIN UPDATE public.transfers_schema_migrations SET checksum='x' WHERE false;
    RAISE EXCEPTION 'FAIL: ledger UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ledger UPDATE'; END;
  BEGIN TRUNCATE public.transfers_schema_migrations;
    RAISE EXCEPTION 'FAIL: ledger TRUNCATE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ledger TRUNCATE'; END;
  BEGIN INSERT INTO transfers.entity_type_definitions (code, label)
    SELECT 'm1syn_denied', 'M1 Synthetic Denied' WHERE false;
    RAISE EXCEPTION 'FAIL: reference INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: reference INSERT'; END;
  BEGIN INSERT INTO public.users (email, name)
    SELECT 'm1@deny.test', 'M1 Synthetic Denied' WHERE false;
    RAISE EXCEPTION 'FAIL: users INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: users INSERT (quarantined)'; END;
  BEGIN PERFORM 1 FROM public.users LIMIT 1;
    RAISE EXCEPTION 'FAIL: users SELECT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: users SELECT'; END;
  BEGIN INSERT INTO transfers.proforma_statements
    (id, transfer_id, accountable_institution_id, matter_reference, tariff_schedule_id, statement_data)
    SELECT 'M1SYN-DENIED', gen_random_uuid(), 900001, 'M1SYN-MAT-DENIED', 'M1SYN-TARIFF-DENIED', '{}'::jsonb WHERE false;
    RAISE EXCEPTION 'FAIL: proforma INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: proforma INSERT (quarantined)'; END;
  BEGIN INSERT INTO transfers.milestone_history (milestone_id, action)
    SELECT gen_random_uuid(), 'm1_syn_verify' WHERE false;
    RAISE EXCEPTION 'FAIL: milestone_history INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: milestone_history INSERT (quarantined)'; END;
  BEGIN INSERT INTO transfers.parties (name, type)
    SELECT 'M1 Synthetic Denied', 'seller' WHERE false;
    RAISE EXCEPTION 'FAIL: parties INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: parties INSERT (legacy table)'; END;
  BEGIN PERFORM 1 FROM transfers.classification_document_map LIMIT 1;
    RAISE EXCEPTION 'FAIL: ungranted transfers SELECT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ungranted transfers SELECT'; END;
  BEGIN PERFORM 1 FROM public.user_preferences LIMIT 1;
    RAISE EXCEPTION 'FAIL: ungranted public SELECT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ungranted public SELECT'; END;
  BEGIN DELETE FROM transfers.document_operation_log WHERE false;
    RAISE EXCEPTION 'FAIL: DELETE on granted table';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: DELETE'; END;
  BEGIN CREATE TEMP TABLE m1_deny_tmp(id int);
    RAISE EXCEPTION 'FAIL: CREATE TEMP TABLE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: TEMP TABLE'; END;
  BEGIN CREATE TABLE transfers.m1_deny_probe(id int);
    RAISE EXCEPTION 'FAIL: CREATE TABLE transfers';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: transfers DDL'; END;
  BEGIN CREATE SCHEMA m1_deny_schema;
    RAISE EXCEPTION 'FAIL: CREATE SCHEMA';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: CREATE SCHEMA'; END;
  BEGIN UPDATE public.audit_log SET action='UPDATE' WHERE false;
    RAISE EXCEPTION 'FAIL: audit_log UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: audit_log UPDATE'; END;
  BEGIN DELETE FROM public.audit_log WHERE false;
    RAISE EXCEPTION 'FAIL: audit_log DELETE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: audit_log DELETE'; END;
  -- role escalation equivalent (SET ROLE can't run inside a txn):
  IF pg_has_role('deedly_pilot_app','deedly_pilot_migrate','USAGE') THEN
    RAISE EXCEPTION 'FAIL: app holds migrate role membership';
  END IF;
  RAISE NOTICE 'denial tests OK — 16 checks passed';
END $$;

-- ---------------------------------------------------------------------------
-- 7. Restore session identity (SET LOCAL ROLE NONE -> session user
--    neondb_owner, verified on PG18 inside a transaction), then restore the
--    ORIGINAL membership options exactly — admin=t, inherit=f, set=f — and
--    verify both the catalog state and the executing identity before the
--    implicit COMMIT. Any failure here aborts membership changes AND all
--    object grants together.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE NONE;

DO $$
BEGIN
  IF current_user <> 'neondb_owner' OR session_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'cannot remove temporary grants: current=% session=%', current_user, session_user;
  END IF;
END $$;

REVOKE deedly_pilot_migrate FROM neondb_owner GRANTED BY neondb_owner RESTRICT;
REVOKE deedly_pilot_app FROM neondb_owner GRANTED BY neondb_owner RESTRICT;

DO $$
DECLARE
  memberships jsonb;
  baseline jsonb := pg_catalog.current_setting('m1pilot.memberships_before')::jsonb;
BEGIN
  IF current_user <> 'neondb_owner' OR session_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'session identity not restored: current=% session=%', current_user, session_user;
  END IF;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) INTO memberships
  FROM pg_catalog.pg_auth_members m
  WHERE m.member IN ('neondb_owner'::regrole, 'deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole)
     OR m.roleid IN ('deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole)
     OR m.grantor IN ('neondb_owner'::regrole, 'deedly_pilot_migrate'::regrole, 'deedly_pilot_app'::regrole);
  IF baseline IS NULL OR memberships IS DISTINCT FROM baseline THEN
    RAISE EXCEPTION 'membership restoration differs from baseline (row OIDs, roles, members, grantors or options)';
  END IF;
  IF pg_catalog.pg_has_role('neondb_owner','deedly_pilot_migrate','SET')
     OR pg_catalog.pg_has_role('neondb_owner','deedly_pilot_app','SET')
     OR pg_catalog.pg_has_role('neondb_owner','deedly_pilot_migrate','USAGE')
     OR pg_catalog.pg_has_role('neondb_owner','deedly_pilot_app','USAGE')
     OR pg_catalog.pg_has_role('deedly_pilot_app','deedly_pilot_migrate','MEMBER')
     OR pg_catalog.pg_has_role('deedly_pilot_app','deedly_pilot_migrate','SET') THEN
    RAISE EXCEPTION 'unexpected effective pilot role access after membership restoration';
  END IF;
  RAISE NOTICE 'restore verified — exact membership rows match baseline; temporary grants absent';
END $$;

-- end of file -> COMMIT under psql -1: grants persist ONLY if everything above passed
