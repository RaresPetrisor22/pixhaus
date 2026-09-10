-- Share links: the revocation column, and the fifth bootstrap function.
--
-- WHY revoked_at EXISTS
--
-- 0001's header says revocation is `revocation_epoch + 1`, and that is true of
-- the short-lived tokens minted from a grant -- they carry the epoch they were
-- minted under and fail at their next refresh. But it is not true of the magic
-- link, which is a lookup on token_hash and has nothing in the row that says
-- "revoked". The client whose access was just revoked clicks the same link in
-- the same email and is issued a fresh token under the new epoch.
--
-- So revocation is both, and they kill different things:
--
--     revoked_at        the magic link, immediately
--     revocation_epoch  tokens already in a browser, at their next refresh
--
-- The epoch keeps a second job: any change that should invalidate outstanding
-- tokens without ending the grant -- reducing rights, for instance.


ALTER TABLE grants ADD COLUMN revoked_at timestamptz;


-- ===========================================================================
-- grants_lookup_by_token -- the fifth bootstrap function
-- ===========================================================================
--
-- GET /g/:token. the token hash is the only
-- thing we hold, and the studio is what we are trying to learn. The policy
-- evaluates against NULL and returns nothing.
--



CREATE FUNCTION grants_lookup_by_token(p_token_hash text)
  RETURNS TABLE (
    id               uuid,
    studio_id        uuid,
    gallery_id       uuid,
    rights_mask      integer,
    revocation_epoch integer,
    expires_at       timestamptz,
    revoked_at       timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT g.id, g.studio_id, g.gallery_id, g.rights_mask,
           g.revocation_epoch, g.expires_at, g.revoked_at
    FROM grants g
    WHERE g.token_hash = p_token_hash
  $$;


REVOKE ALL ON FUNCTION grants_lookup_by_token(text) FROM PUBLIC;


-- Same guard as 0002 and 0004: if the app role cannot execute this, the magic
-- link would fail at runtime rather than here.
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
    AND has_function_privilege(r.oid, 'public.grants_lookup_by_token(text)'::regprocedure, 'EXECUTE');

  IF cardinality(callers) = 0 THEN
    RAISE EXCEPTION 'no application role can execute grants_lookup_by_token'
      USING HINT =
        'docker/postgres/init/01-create-app-role.sh must GRANT EXECUTE ON ROUTINES by '
        'default, and that script only runs against an empty data volume. Run: '
        'docker compose down -v && docker compose up -d --wait';
  END IF;
END
$$;
