-- The RLS bootstrap
--
-- THE PROBLEM
--
-- Every policy in 0001 has the same shape:
--
--     USING (studio_id = current_studio_id())
--
-- and current_studio_id() reads a variable the caller sets per transaction. So
-- the deal is: declare which tenant you are, then query. Anything you did not
-- declare is invisible.
--
-- That works for every request made by somebody already logged in. It does not
-- work for the requests that establish who they are, because there the tenant
-- id is the *answer*, not something the caller holds
--
-- THE FIX:
--
-- Three SECURITY DEFINER functions, below. A SECURITY DEFINER function runs
-- with the privileges of the role that owns it rather than the role that calls
-- it. Migrations run as the database OWNER, so the
-- owner owns these functions; the owner also owns every table, and 0001 says
-- ENABLE ROW LEVEL SECURITY rather than FORCE, which means the owner is not
-- subject to its own policies. 


-- ===========================================================================
-- 1. Email verification 
-- ===========================================================================


ALTER TABLE users
  ADD COLUMN email_verification_token_hash text
    CHECK (email_verification_token_hash IS NULL
           OR length(email_verification_token_hash) = 64),
  ADD COLUMN email_verification_sent_at timestamptz;


CREATE UNIQUE INDEX users_email_verification_token_hash_idx
  ON users (email_verification_token_hash)
  WHERE email_verification_token_hash IS NOT NULL;


-- ===========================================================================
-- 2. The bootstrap functions
-- ===========================================================================
--
CREATE FUNCTION auth_lookup_user_by_email(p_email text)
  RETURNS TABLE (
    id                uuid,
    studio_id         uuid,
    password_hash     text,
    email_verified_at timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT u.id, u.studio_id, u.password_hash, u.email_verified_at
    FROM users u
    WHERE u.email = lower(p_email)
  $$;


CREATE FUNCTION auth_lookup_user_by_verification_token(p_token_hash text)
  RETURNS TABLE (
    id                         uuid,
    studio_id                  uuid,
    email_verified_at          timestamptz,
    email_verification_sent_at timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT u.id, u.studio_id, u.email_verified_at, u.email_verification_sent_at
    FROM users u
    WHERE u.email_verification_token_hash = p_token_hash
  $$;

CREATE FUNCTION auth_resolve_session(p_session_id text)
  RETURNS TABLE (
    user_id      uuid,
    studio_id    uuid,
    expires_at   timestamptz,
    last_seen_at timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT s.user_id, s.studio_id, s.expires_at, s.last_seen_at
    FROM sessions s
    WHERE s.id = p_session_id
  $$;


-- ===========================================================================
-- 3. Who is allowed to call them
-- ===========================================================================
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. That is a
-- poor default for a function that bypasses row-level security, so revoke it.
--
-- The app role keeps its access by a different route: the init script runs
--
--     ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
--       GRANT EXECUTE ON ROUTINES TO <app role>;

REVOKE ALL ON FUNCTION auth_lookup_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_user_by_verification_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;


-- Against a database whose init
-- script predates the ON ROUTINES line, every CREATE FUNCTION here gets only
-- the PUBLIC grant, the REVOKE takes it away, and the application ends up
-- unable to call functions that exist and look fine. Login would fail with a
-- permissions error nobody expects to see in an auth path.
--
-- So refuse to apply instead. The whole migration is one transaction, so
-- raising here rolls back everything above it.
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
    RAISE EXCEPTION 'no application role can execute the auth bootstrap functions'
      USING HINT =
        'docker/postgres/init/01-create-app-role.sh must GRANT EXECUTE ON ROUTINES by '
        'default, and that script only runs against an empty data volume. Run: '
        'docker compose down -v && docker compose up -d --wait';
  END IF;

  RAISE NOTICE 'auth bootstrap functions callable by: %', array_to_string(callers, ', ');
END
$$;
