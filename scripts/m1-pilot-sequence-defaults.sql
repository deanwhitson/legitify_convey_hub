\set ON_ERROR_STOP on
SAVEPOINT m1_sequence_defaults;
SET LOCAL search_path = pg_catalog;

DO $$
DECLARE
  expected_privileges text[] := ARRAY['SELECT','UPDATE','USAGE'];
  actual_privileges text[];
  table_acl_hash text;
  protected_state jsonb;
BEGIN
  IF current_database() <> 'deedly_pilot'
     OR current_user <> 'deedly_pilot_migrate'
     OR session_user <> 'deedly_pilot_migrate' THEN
    RAISE EXCEPTION 'must connect directly as deedly_pilot_migrate to deedly_pilot';
  END IF;
  SELECT array_agg(a.privilege_type ORDER BY a.privilege_type) INTO actual_privileges
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole = 'deedly_pilot_migrate'::regrole
    AND d.defaclobjtype = 'S' AND d.defaclnamespace = 'public'::regnamespace;
  IF actual_privileges IS DISTINCT FROM expected_privileges OR EXISTS (
    SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole = 'deedly_pilot_migrate'::regrole
      AND d.defaclobjtype = 'S' AND d.defaclnamespace = 'public'::regnamespace
      AND (a.grantee <> 'deedly_pilot_app'::regrole
           OR a.grantor <> 'deedly_pilot_migrate'::regrole OR a.is_grantable)
  ) THEN
    RAISE EXCEPTION 'sequence default differs from reviewed public app SELECT/UPDATE/USAGE grant; stop for review';
  END IF;
  SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_object(
    'oid',c.oid,'schema',n.nspname,'table',c.relname,'owner',c.relowner,'acl',c.relacl,
    'columns',(SELECT jsonb_agg(jsonb_build_object('attnum',a.attnum,'acl',a.attacl) ORDER BY a.attnum)
               FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
  ) ORDER BY n.nspname,c.relname)::text,'UTF8')),'hex') INTO table_acl_hash
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','transfers') AND c.relkind IN ('r','p','v','m','f');
  IF table_acl_hash IS DISTINCT FROM '9bb7f6388a944035770c0b04fd8b912d2ec488bf64c376da18bffe89d3c7bb70' THEN
    RAISE EXCEPTION 'current table/column ACLs or ownership differ from reviewed post-grant state';
  END IF;
  SELECT jsonb_build_object(
    'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) FROM pg_auth_members m),
    'roles',(SELECT jsonb_agg(jsonb_build_object('oid',r.oid,'name',r.rolname,'super',r.rolsuper,
               'inherit',r.rolinherit,'createrole',r.rolcreaterole,'createdb',r.rolcreatedb,'bypassrls',r.rolbypassrls)
               ORDER BY r.oid) FROM pg_roles r),
    'schemas',(SELECT jsonb_agg(jsonb_build_object('oid',n.oid,'owner',n.nspowner,'acl',n.nspacl) ORDER BY n.oid)
               FROM pg_namespace n WHERE n.nspname IN ('public','transfers')),
    'other_defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d
               WHERE NOT (d.defaclrole='deedly_pilot_migrate'::regrole AND d.defaclobjtype='S'
                          AND d.defaclnamespace='public'::regnamespace))
  ) INTO protected_state;
  PERFORM set_config('m1seq.protected_state',protected_state::text,true);
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE deedly_pilot_migrate IN SCHEMA public
  REVOKE SELECT, UPDATE, USAGE ON SEQUENCES FROM deedly_pilot_app RESTRICT;

DO $$
DECLARE
  effective_roles oid[];
  remaining_access jsonb;
  table_acl_hash text;
  protected_state jsonb;
BEGIN
  IF current_database() <> 'deedly_pilot'
     OR current_user <> 'deedly_pilot_migrate'
     OR session_user <> 'deedly_pilot_migrate' THEN
    RAISE EXCEPTION 'unexpected database or executing/session identity after revocation';
  END IF;
  SELECT array_agg(r.oid ORDER BY r.oid) INTO effective_roles
  FROM pg_roles r WHERE EXISTS (
    SELECT 1 FROM pg_roles s
    WHERE pg_has_role('deedly_pilot_app',s.oid,'SET') AND pg_has_role(s.oid,r.oid,'USAGE')
  );
  IF effective_roles IS NULL OR EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.oid = ANY(effective_roles)
      AND (r.rolsuper OR r.oid='deedly_pilot_migrate'::regrole
           OR r.rolname IN ('pg_read_all_data','pg_write_all_data'))
  ) THEN
    RAISE EXCEPTION 'app has an unreviewed ownership, superuser or predefined broad-access path';
  END IF;
  WITH applicable_defaults AS (
    SELECT 0::oid AS schema_oid,
      COALESCE((SELECT d.defaclacl FROM pg_default_acl d
                WHERE d.defaclrole='deedly_pilot_migrate'::regrole
                  AND d.defaclobjtype='S' AND d.defaclnamespace=0),
               acldefault('s','deedly_pilot_migrate'::regrole)) AS acl
    UNION ALL
    SELECT d.defaclnamespace,d.defaclacl FROM pg_default_acl d
    WHERE d.defaclrole='deedly_pilot_migrate'::regrole
      AND d.defaclobjtype='S' AND d.defaclnamespace<>0
  )
  SELECT jsonb_agg(jsonb_build_object('schema_oid',d.schema_oid,'grantee',a.grantee,
                                    'privilege',a.privilege_type,'grantable',a.is_grantable))
  INTO remaining_access
  FROM applicable_defaults d CROSS JOIN LATERAL aclexplode(d.acl) a
  WHERE a.grantee=0 OR a.grantee = ANY(effective_roles);
  IF remaining_access IS NOT NULL THEN
    RAISE EXCEPTION 'future migrator-created sequences still confer unreviewed app privileges: %', remaining_access;
  END IF;
  SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_object(
    'oid',c.oid,'schema',n.nspname,'table',c.relname,'owner',c.relowner,'acl',c.relacl,
    'columns',(SELECT jsonb_agg(jsonb_build_object('attnum',a.attnum,'acl',a.attacl) ORDER BY a.attnum)
               FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
  ) ORDER BY n.nspname,c.relname)::text,'UTF8')),'hex') INTO table_acl_hash
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','transfers') AND c.relkind IN ('r','p','v','m','f');
  IF table_acl_hash IS DISTINCT FROM '9bb7f6388a944035770c0b04fd8b912d2ec488bf64c376da18bffe89d3c7bb70' THEN
    RAISE EXCEPTION 'current table/column ACLs or ownership changed';
  END IF;
  SELECT jsonb_build_object(
    'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) FROM pg_auth_members m),
    'roles',(SELECT jsonb_agg(jsonb_build_object('oid',r.oid,'name',r.rolname,'super',r.rolsuper,
               'inherit',r.rolinherit,'createrole',r.rolcreaterole,'createdb',r.rolcreatedb,'bypassrls',r.rolbypassrls)
               ORDER BY r.oid) FROM pg_roles r),
    'schemas',(SELECT jsonb_agg(jsonb_build_object('oid',n.oid,'owner',n.nspowner,'acl',n.nspacl) ORDER BY n.oid)
               FROM pg_namespace n WHERE n.nspname IN ('public','transfers')),
    'other_defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d
               WHERE NOT (d.defaclrole='deedly_pilot_migrate'::regrole AND d.defaclobjtype='S'
                          AND d.defaclnamespace='public'::regnamespace))
  ) INTO protected_state;
  IF protected_state IS DISTINCT FROM current_setting('m1seq.protected_state')::jsonb THEN
    RAISE EXCEPTION 'memberships, role attributes, schema ACLs or unrelated defaults changed';
  END IF;
  RAISE NOTICE 'PASS: no effective app privileges from global or schema sequence defaults for deedly_pilot_migrate';
  RAISE NOTICE 'PASS: current table/column ACLs, ownership, memberships, role attributes, schema ACLs and unrelated defaults preserved';
END $$;

RELEASE SAVEPOINT m1_sequence_defaults;
