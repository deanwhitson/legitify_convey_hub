-- ============================================================================
-- deedly_pilot — post-grant runtime verification (run AFTER m1-pilot-grants.sql)
--
-- Run as:  deedly_pilot_app
-- Method:  psql -v ON_ERROR_STOP=1 -f m1-pilot-grants-verify.sql
--
-- A. Positive pilot flow — all inside one transaction, ROLLBACK at the end:
--    property create -> transfer create -> transfer update -> matter create
--    -> property<->matter link -> manual party attach -> requirement upsert
--    -> document insert ... RETURNING -> document op-log insert -> reference
--    reads -> audit-trigger assertions. Proves the SECURITY INVOKER audit
--    trigger fires under the app role; leaves zero residue.
-- B. Denial tests — each MUST raise insufficient_privilege; anything else
--    aborts the script non-zero.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Guards: exact database + executing role.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() <> 'deedly_pilot' THEN
    RAISE EXCEPTION 'verify script must run on deedly_pilot, connected to: %', current_database();
  END IF;
  IF current_user <> 'deedly_pilot_app' THEN
    RAISE EXCEPTION 'verify script must run as deedly_pilot_app, connected as: %', current_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A. Positive pilot flow (transactional — fully rolled back).
-- ---------------------------------------------------------------------------
BEGIN;
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

DO $$
DECLARE
  ai   int := 900001;      -- synthetic accountable_institution_id
  prop uuid; tr uuid; mat uuid; tp uuid; tdoc uuid;
  n    int;  dn text;
BEGIN
  -- 1. property create (INSERT-only grant) + audit trigger evidence
  INSERT INTO transfers.properties
    (property_id, street_address, city, province, property_type, accountable_institution_id)
  VALUES ('M1SYN-PROP-1', '1 Synthetic St', 'Cape Town', 'Western Cape', 'Freehold', ai)
  RETURNING id INTO prop;
  SELECT count(*) INTO n FROM public.audit_log
   WHERE table_name='properties' AND action='INSERT' AND record_id::text = prop::text;
  IF n <> 1 THEN RAISE EXCEPTION 'audit row missing: properties INSERT'; END IF;

  -- 2. transfer create (composite FK to properties) + audit row
  INSERT INTO transfers.transfers
    (transfer_id, property_address, purchase_price, accountable_institution_id, property_id, status)
  VALUES ('M1SYN-TR-1', '1 Synthetic St', 1000000, ai, prop, 'in_progress')
  RETURNING id INTO tr;
  SELECT count(*) INTO n FROM public.audit_log
   WHERE table_name='transfers' AND action='INSERT' AND record_id::text = tr::text;
  IF n <> 1 THEN RAISE EXCEPTION 'audit row missing: transfers INSERT'; END IF;

  -- 3. transfer update -> audit UPDATE row
  UPDATE transfers.transfers SET purchase_price = 1000001 WHERE id = tr;
  SELECT count(*) INTO n FROM public.audit_log
   WHERE table_name='transfers' AND action='UPDATE' AND record_id::text = tr::text;
  IF n <> 1 THEN RAISE EXCEPTION 'audit row missing: transfers UPDATE'; END IF;

  -- readback on the just-written row
  SELECT count(*) INTO n FROM transfers.transfers WHERE id = tr AND purchase_price = 1000001;
  IF n <> 1 THEN RAISE EXCEPTION 'transfer readback failed'; END IF;

  -- 4. matter create (status='in_progress' required for matter_type='transfer')
  INSERT INTO transfers.matters
    (reference_number, matter_type, status, accountable_institution_id)
  VALUES ('M1SYN-MAT-1', 'transfer', 'in_progress', ai)
  RETURNING id INTO mat;

  -- 5. property<->matter link
  INSERT INTO transfers.matter_properties
    (matter_id, property_kind, property_id, accountable_institution_id)
  VALUES (mat, 'input', prop, ai);

  -- 6. manual party attach (party_source='manual' requires manual_name,
  --    entity_type='person')
  INSERT INTO transfers.transfer_parties
    (transfer_id, entity_type, role, accountable_institution_id, party_source, manual_name)
  VALUES (tr, 'person', 'transferor', ai, 'manual', 'M1 Synthetic Seller')
  RETURNING id INTO tp;
  UPDATE transfers.transfer_parties SET is_primary_contact = true WHERE id = tp;

  -- 7. requirement upsert (INSERT then ON CONFLICT DO UPDATE -> needs I+U)
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

  -- 8. document insert ... RETURNING (exercises RETURNING under the grant)
  INSERT INTO transfers.transfer_documents (transfer_id, name, accountable_institution_id)
  VALUES (tr, 'm1syn.pdf', ai) RETURNING id INTO tdoc;
  IF tdoc IS NULL THEN RAISE EXCEPTION 'document RETURNING produced null id'; END IF;
  UPDATE transfers.transfer_documents SET status = 'uploaded' WHERE id = tdoc;

  -- 9. document operation log insert (append-only)
  INSERT INTO transfers.document_operation_log (operation, outcome, accountable_institution_id)
  VALUES ('document_created', 'success', ai);

  -- 10. reference-table reads (SELECT-only grants)
  PERFORM 1 FROM transfers.entity_type_definitions LIMIT 1;
  PERFORM 1 FROM transfers.matter_classification_options LIMIT 1;
  PERFORM 1 FROM transfers.party_role_definitions LIMIT 1;

  RAISE NOTICE 'A OK — property/transfer/matter/link/party/upsert/document/log flow verified with audit evidence';
END $$;

ROLLBACK;  -- synthetic rows AND their audit rows are discarded together

-- ---------------------------------------------------------------------------
-- B. Denial tests — each block must observe insufficient_privilege.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  -- ledger: all writes denied
  BEGIN
    INSERT INTO public.transfers_schema_migrations (filename, checksum)
    SELECT 'M1SYN-denied.sql', repeat('0', 64) WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: ledger INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ledger INSERT'; END;
  BEGIN
    UPDATE public.transfers_schema_migrations SET checksum='x' WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: ledger UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ledger UPDATE'; END;
  BEGIN
    TRUNCATE public.transfers_schema_migrations;
    RAISE EXCEPTION 'DENIAL FAILED: ledger TRUNCATE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ledger TRUNCATE'; END;

  -- reference-table write denied (SELECT-only grant)
  BEGIN
    INSERT INTO transfers.entity_type_definitions (code, label)
    SELECT 'm1syn_denied', 'M1 Synthetic Denied' WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: entity_type_definitions INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: reference INSERT'; END;

  -- quarantined-feature tables: writes and reads both denied
  BEGIN
    INSERT INTO public.users (email, name)
    SELECT 'm1@deny.test', 'M1 Synthetic Denied' WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: users INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: users INSERT (quarantined feature)'; END;
  BEGIN
    PERFORM 1 FROM public.users LIMIT 1;
    RAISE EXCEPTION 'DENIAL FAILED: users SELECT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: users SELECT'; END;
  BEGIN
    INSERT INTO transfers.proforma_statements
    (id, transfer_id, accountable_institution_id, matter_reference, tariff_schedule_id, statement_data)
    SELECT 'M1SYN-DENIED', gen_random_uuid(), 900001, 'M1SYN-MAT-DENIED', 'M1SYN-TARIFF-DENIED', '{}'::jsonb WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: proforma_statements INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: proforma_statements INSERT (quarantined accounts)'; END;
  BEGIN
    INSERT INTO transfers.milestone_history (milestone_id, action)
    SELECT gen_random_uuid(), 'm1_syn_verify' WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: milestone_history INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: milestone_history INSERT (quarantined milestones)'; END;
  BEGIN
    INSERT INTO transfers.parties (name, type)
    SELECT 'M1 Synthetic Denied', 'seller' WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: parties INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: parties INSERT (legacy table — v1 uses transfer_parties)'; END;

  -- ungranted reads denied
  BEGIN
    PERFORM 1 FROM transfers.classification_document_map LIMIT 1;
    RAISE EXCEPTION 'DENIAL FAILED: classification_document_map SELECT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ungranted transfers SELECT'; END;
  BEGIN
    PERFORM 1 FROM public.user_preferences LIMIT 1;
    RAISE EXCEPTION 'DENIAL FAILED: user_preferences SELECT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: ungranted public SELECT'; END;

  -- no DELETE anywhere: prove on a granted table
  BEGIN
    DELETE FROM transfers.document_operation_log WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: document_operation_log DELETE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: DELETE on granted table'; END;

  -- temp tables denied (PUBLIC TEMPORARY revoked)
  BEGIN
    CREATE TEMP TABLE m1_deny_tmp(id int);
    RAISE EXCEPTION 'DENIAL FAILED: CREATE TEMP TABLE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: TEMP TABLE'; END;

  -- schema DDL denied
  BEGIN
    CREATE TABLE transfers.m1_deny_probe(id int);
    RAISE EXCEPTION 'DENIAL FAILED: CREATE TABLE transfers';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: transfers-schema DDL'; END;
  BEGIN
    CREATE SCHEMA m1_deny_schema;
    RAISE EXCEPTION 'DENIAL FAILED: CREATE SCHEMA';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: CREATE SCHEMA'; END;

  -- audit-log tamper denied (INSERT is granted; UPDATE/DELETE are not)
  BEGIN
    UPDATE public.audit_log SET action='UPDATE' WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: audit_log UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: audit_log UPDATE'; END;
  BEGIN
    DELETE FROM public.audit_log WHERE false;
    RAISE EXCEPTION 'DENIAL FAILED: audit_log DELETE';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'denial ok: audit_log DELETE'; END;

  -- role escalation equivalent — SET ROLE can't execute inside a DO
  -- block's implicit transaction (raises 0A000 not 42501), so assert the
  -- underlying condition instead:
  IF pg_has_role('deedly_pilot_app','deedly_pilot_migrate','USAGE') THEN
    RAISE EXCEPTION 'DENIAL FAILED: app holds migrate role membership';
  END IF;
  RAISE NOTICE 'denial ok: migrate role membership absent';

  RAISE NOTICE 'B OK — all denial tests passed';
END $$;
