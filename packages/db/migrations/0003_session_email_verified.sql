-- auth_resolve_session also answers "is this account verified?"



DROP FUNCTION auth_resolve_session(text);


CREATE FUNCTION auth_resolve_session(p_session_id text)
  RETURNS TABLE (
    user_id           uuid,
    studio_id         uuid,
    expires_at        timestamptz,
    last_seen_at      timestamptz,
    email_verified_at timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT s.user_id, s.studio_id, s.expires_at, s.last_seen_at, u.email_verified_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = p_session_id
  $$;


REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;


-- Same guard 0002 ends with, for the same reason
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
    AND has_function_privilege(r.oid, 'public.auth_resolve_session(text)'::regprocedure, 'EXECUTE');

  IF cardinality(callers) = 0 THEN
    RAISE EXCEPTION 'no application role can execute auth_resolve_session after recreating it'
      USING HINT =
        'docker/postgres/init/01-create-app-role.sh must GRANT EXECUTE ON ROUTINES by '
        'default, and that script only runs against an empty data volume. Run: '
        'docker compose down -v && docker compose up -d --wait';
  END IF;

  RAISE NOTICE 'auth_resolve_session callable by: %', array_to_string(callers, ', ');
END
$$;
