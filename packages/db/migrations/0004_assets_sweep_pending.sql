-- The reaper's one query.
--
-- Every presigned upload URL creates a `pending` row that may never be
-- finalized. Sweeping them is inherently cross-tenant, and the app role cannot
-- see across tenants -- so this joins the three SECURITY DEFINER functions from
-- 0002. It returns identifiers only; the caller re-enters per studio through
-- withTenant to do the actual updates.

CREATE FUNCTION assets_sweep_pending(p_older_than interval)
  RETURNS TABLE (
    id          uuid,
    studio_id   uuid,
    storage_key text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT a.id, a.studio_id, a.storage_key
    FROM assets a
    WHERE a.status = 'pending'
      AND a.created_at < now() - p_older_than
    ORDER BY a.created_at
  $$;


REVOKE ALL ON FUNCTION assets_sweep_pending(interval) FROM PUBLIC;


-- Same guard as 0002: if the app role cannot execute this, the reaper would
-- fail at runtime rather than here.
DO $$
DECLARE
  callers text[];
BEGIN
  SELECT coalesce(array_agg(r.rolname ORDER BY r.rolname), '{}')
    INTO callers
  FROM pg_roles r
  WHERE r.rolcanlogin
    AND NOT r.rolsuper
    AND r.rolname <> current_user
    AND has_function_privilege(r.oid, 'public.assets_sweep_pending(interval)'::regprocedure, 'EXECUTE');

  IF cardinality(callers) = 0 THEN
    RAISE EXCEPTION 'no application role can execute assets_sweep_pending'
      USING HINT =
        'docker/postgres/init/01-create-app-role.sh must GRANT EXECUTE ON ROUTINES by '
        'default, and that script only runs against an empty data volume. Run: '
        'docker compose down -v && docker compose up -d --wait';
  END IF;
END
$$;
