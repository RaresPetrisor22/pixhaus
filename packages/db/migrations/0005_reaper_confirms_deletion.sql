-- Makes the reaper self-healing.
--
-- 0004 returned only `pending` rows, so once the sweep flipped one to
-- `orphaned` it became invisible to every later sweep. A worker that died
-- between that flip and the object delete leaked the bytes permanently -- and
-- the job retry could not help, because the retry re-reads the same sweep.
--
-- The status flip still has to come first: it is what stops the reaper deleting
-- an upload that finalized mid-sweep. So instead the row records when its
-- objects were actually deleted, and the sweep returns anything still unstamped.

ALTER TABLE assets ADD COLUMN objects_deleted_at timestamptz;


-- Partial, like assets_pending_created_idx: it indexes only the rows still
-- owed a delete, not every asset ever orphaned.
CREATE INDEX assets_orphaned_undeleted_idx
  ON assets (created_at)
  WHERE status = 'orphaned' AND objects_deleted_at IS NULL;


DROP FUNCTION assets_sweep_pending(interval);

CREATE FUNCTION assets_sweep_pending(p_older_than interval)
  RETURNS TABLE (
    id          uuid,
    studio_id   uuid,
    storage_key text,
    status      text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT a.id, a.studio_id, a.storage_key, a.status
    FROM assets a
    WHERE (a.status = 'pending' AND a.created_at < now() - p_older_than)
       OR (a.status = 'orphaned' AND a.objects_deleted_at IS NULL)
    ORDER BY a.created_at
  $$;


REVOKE ALL ON FUNCTION assets_sweep_pending(interval) FROM PUBLIC;


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
