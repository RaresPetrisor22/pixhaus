-- The whole Pixhaus data model: eight tables, their indexes, and the row-level
-- security policies that turn studio_id from a convention into a wall.
--
-- The runner wraps this file in a transaction and runs it as the database
-- OWNER. The owner therefore owns every table created here, and the
-- application role -- which owns nothing -- is subject to the policies at the
-- bottom. That asymmetry is the entire point of the two-role setup in
-- docker/postgres/init/01-create-app-role.sh.
--
-- Conventions used throughout:
--   * uuid primary keys, generated server-side by gen_random_uuid()
--   * timestamptz for every point in time, never timestamp
--   * text + CHECK for enumerations, never a native enum type: adding a value
--     to a CHECK is one ALTER, and removing one is possible at all
--   * studio_id on every row, guaranteed consistent by composite foreign keys


-- ===========================================================================
-- Helpers
-- ===========================================================================

CREATE FUNCTION current_studio_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$ SELECT nullif(current_setting('app.studio_id', true), '')::uuid $$;


CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- ===========================================================================
-- 1. studios -- the tenant
-- ===========================================================================
--
-- One row per photography business. This is the root of every ownership chain
-- in the database;

CREATE TABLE studios (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug       text        NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

 -- This index is the lookup path for slug-addressed routes.
  UNIQUE (slug)
);

CREATE TRIGGER studios_set_updated_at
  BEFORE UPDATE ON studios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ===========================================================================
-- 2. users -- the photographer, plane A
-- ===========================================================================
--
-- A real account: password, session, email verification. Note that there is no client user. Clients hold grants (table 7).
--
-- Email is globally unique rather than unique per studio. That makes login a
-- single unambiguous lookup by email; the cost is that one address cannot
-- belong to two studios. For a product where a studio is a business, that is
-- the right trade.

CREATE TABLE users (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id         uuid        NOT NULL REFERENCES studios (id) ON DELETE CASCADE,

  -- Stored already-lowercased
  email             text        NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),

  -- argon2id, encoded string (parameters included).
  password_hash     text        NOT NULL,

  role              text        NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),

  -- Nullable timestamp rather than a boolean: it answers "verified?" and
  -- "when?" with one column, and cannot drift out of sync with a separate date.
  email_verified_at timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- The login lookup, and the uniqueness rule, in one index.
  UNIQUE (email),

  -- It exists so that children
  -- can declare FOREIGN KEY (user_id, studio_id) and have Postgres guarantee
  -- the two agree. See sessions below.
  UNIQUE (id, studio_id)
);


CREATE INDEX users_studio_id_idx ON users (studio_id);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ===========================================================================
-- 3. sessions -- server-side, revocable
-- ===========================================================================

CREATE TABLE sessions (
  id           text        PRIMARY KEY CHECK (length(id) = 64),
  user_id      uuid        NOT NULL,
  studio_id    uuid        NOT NULL,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,

  -- Composite: a session's studio_id cannot disagree with its user's.
  FOREIGN KEY (user_id, studio_id) REFERENCES users (id, studio_id) ON DELETE CASCADE
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);


-- ===========================================================================
-- 4. galleries -- a set of assets, plus rights granted over it
-- ===========================================================================
--
-- One gallery model, not two. "Delivery" and "proofing" are not gallery types;
-- they are rights masks on the grants pointing at this row.

CREATE TABLE galleries (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id  uuid        NOT NULL REFERENCES studios (id) ON DELETE CASCADE,
  title      text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status     text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- FK target for assets and grants; see the note on users.
  UNIQUE (id, studio_id)
);

-- The dashboard: "my galleries, newest first". Leading with studio_id also
-- makes this the index that cascades a studio deletion.
CREATE INDEX galleries_studio_created_idx ON galleries (studio_id, created_at DESC);

CREATE TRIGGER galleries_set_updated_at
  BEFORE UPDATE ON galleries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ===========================================================================
-- 5. assets -- one uploaded original
-- ===========================================================================
--
-- The row is created BEFORE the bytes exist, at the moment we hand out a
-- presigned PUT, and it starts life in 'pending'. Everything the client claims
-- about the upload stays NULL until finalize, when the server goes and looks at
-- the object itself: content_type from magic bytes, size_bytes from a HEAD,
-- content_hash computed server-side. If a column here could be forged by the
-- browser, it is nullable and filled in later.

CREATE TABLE assets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id        uuid        NOT NULL,
  studio_id         uuid        NOT NULL,

  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'uploaded', 'processing',
                                                  'ready', 'failed', 'orphaned')),

  -- Object key of the original. Contains this row's id, so it is unique by
  -- construction and needs no unique index to prove it.
  storage_key       text        NOT NULL,

  original_filename text        NOT NULL,

  -- All server-observed, all NULL until finalize has verified the object.
  content_type      text        CHECK (content_type IS NULL OR content_type LIKE 'image/%'),
  content_hash      text        CHECK (content_hash IS NULL OR length(content_hash) = 64),
  size_bytes        bigint      CHECK (size_bytes IS NULL OR size_bytes > 0),
  width             integer     CHECK (width IS NULL OR width > 0),
  height            integer     CHECK (height IS NULL OR height > 0),

  -- Written by the worker; lets the grid paint a placeholder before any
  -- rendition has loaded.
  blurhash          text,

  -- Manual ordering within the gallery. Plain integer: reordering renumbers a
  -- range, which is fine at gallery scale.
  position          integer     NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- FK target for renditions and favorites.
  UNIQUE (id, studio_id),

  FOREIGN KEY (gallery_id, studio_id) REFERENCES galleries (id, studio_id) ON DELETE CASCADE
);

-- The hot path: render one gallery in display order. `id` is the tiebreaker
-- that makes keyset pagination stable when positions collide -- with 500
-- photos in a virtualized grid, we page by (position, id), never by OFFSET.
-- Leading with gallery_id also serves the cascade from galleries.
CREATE INDEX assets_gallery_position_idx ON assets (gallery_id, position, id);

--  Every presigned upload URL creates a row that may never
-- be finalized -- the tab closed, the wifi died, someone was probing the API.
-- Partial, so it indexes only the handful of rows actually in flight rather
-- than every asset ever uploaded.
CREATE INDEX assets_pending_created_idx ON assets (created_at) WHERE status = 'pending';

CREATE TRIGGER assets_set_updated_at
  BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ===========================================================================
-- 6. renditions -- derived images
-- ===========================================================================
--
-- Immutable: a rendition is replaced, never edited, so there is no updated_at
-- and no trigger.

CREATE TABLE renditions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid        NOT NULL,
  studio_id   uuid        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('thumb', 'grid', 'preview')),
  storage_key text        NOT NULL,
  format      text        NOT NULL DEFAULT 'webp' CHECK (format IN ('webp', 'jpeg', 'avif')),
  width       integer     NOT NULL CHECK (width > 0),
  height      integer     NOT NULL CHECK (height > 0),
  size_bytes  bigint      NOT NULL CHECK (size_bytes > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),


  UNIQUE (asset_id, kind),

  FOREIGN KEY (asset_id, studio_id) REFERENCES assets (id, studio_id) ON DELETE CASCADE
);


-- ===========================================================================
-- 7. grants -- plane B, the capability
-- ===========================================================================
--
-- This row IS the permission. There is no client account it hangs off; the
-- grant names a gallery, a set of rights, an audience, and a window, and that
-- is the whole of the client's identity.
--
-- rights_mask is a bitmask:
--     1  view       browse the gallery and its previews
--     2  download   fetch originals
--     4  favorite   heart assets and submit a selection
-- so a delivery gallery is 3 (view+download) and a proofing gallery is 5
-- (view+favorite). 
--
-- revocation_epoch is the revocation mechanism. Short-lived signed tokens are
-- minted from this row carrying the epoch they were minted under; bumping the
-- epoch invalidates every outstanding token at its next mint, bounded by the
-- token TTL rather than instantly. Revoking is an UPDATE, not a DELETE, so the
-- record of what was shared survives.

CREATE TABLE grants (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id             uuid        NOT NULL,
  studio_id              uuid        NOT NULL,

  -- SHA-256 of the magic-link token, hex. Same reasoning as sessions.id: the
  -- email holds the only copy of the real token.
  token_hash             text        NOT NULL CHECK (length(token_hash) = 64),

  -- Who the link was issued to.
  audience_email         text        NOT NULL CHECK (audience_email = lower(audience_email)),

  -- Photographer-facing note, e.g. "Bride's parents".
  label                  text,

  rights_mask            integer     NOT NULL CHECK (rights_mask > 0 AND rights_mask < 8),
  revocation_epoch       integer     NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  expires_at             timestamptz NOT NULL,
  last_seen_at           timestamptz,
  selection_submitted_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- The client's entry point: GET /g/:token hashes the token and lands here.
  UNIQUE (token_hash),

  -- FK target for favorites.
  UNIQUE (id, studio_id),

  FOREIGN KEY (gallery_id, studio_id) REFERENCES galleries (id, studio_id) ON DELETE CASCADE
);

-- "Show me the share links on this gallery", and the cascade from galleries.
CREATE INDEX grants_gallery_id_idx ON grants (gallery_id);

CREATE TRIGGER grants_set_updated_at
  BEFORE UPDATE ON grants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ===========================================================================
-- 8. favorites -- a client's selection
-- ===========================================================================
--
-- Attached to a grant, not to a user, because no client user exists. This is
-- the table where the no-accounts decision stops being an auth detail and
-- starts shaping the data model: two people sent two different links to the
-- same gallery have two independent selections, and that falls out for free.

CREATE TABLE favorites (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id   uuid        NOT NULL,
  asset_id   uuid        NOT NULL,
  studio_id  uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Hearting is idempotent: double-tapping is ON CONFLICT DO NOTHING, not a
  -- duplicate row. Also the cascade path from grants.
  UNIQUE (grant_id, asset_id),

  -- Two composite FKs, so the grant and the asset are provably in the same
  -- studio. Without them you could blind-INSERT a favorite pointing at another
  -- tenant's asset id.
  FOREIGN KEY (grant_id, studio_id) REFERENCES grants (id, studio_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, studio_id) REFERENCES assets (id, studio_id) ON DELETE CASCADE
);

-- "Which assets did they pick", and the cascade from assets.
CREATE INDEX favorites_asset_id_idx ON favorites (asset_id);


-- ===========================================================================
-- Row-level security
-- ===========================================================================
--
-- One rule, eight times: a row is visible if, and writable only if, its
-- studio_id matches the tenant set on this transaction.
--
-- This is the SECOND wall. The first is the repository layer, which requires
-- tenant context to build a query at all. RLS is what catches the raw query
-- someone writes at 2am that skips the repository -- it turns a cross-tenant
-- leak from a code review miss into an impossibility.
--
-- ENABLE, not FORCE: the table owner still bypasses these policies, which is
-- what keeps migrations, psql, and backups working. The application role owns
-- nothing, so it is bound by them.
--
-- Every policy carries WITH CHECK as well as USING. USING filters what you can
-- read; WITH CHECK constrains what you can write. Without it you could not see
-- another tenant's rows but could still INSERT rows tagged with their id.
--
-- The client plane goes through these same policies: when a grant is resolved,
-- the API sets app.studio_id to the grant's studio and the client's queries run
-- inside the owning tenant. RLS is the tenant wall; authorize() is the rights
-- wall. 

ALTER TABLE studios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE galleries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE renditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE grants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites  ENABLE ROW LEVEL SECURITY;

-- studios is the only table keyed on its own id rather than a studio_id column.
CREATE POLICY studios_tenant ON studios
  FOR ALL USING (id = current_studio_id()) WITH CHECK (id = current_studio_id());

CREATE POLICY users_tenant ON users
  FOR ALL USING (studio_id = current_studio_id()) WITH CHECK (studio_id = current_studio_id());

CREATE POLICY sessions_tenant ON sessions
  FOR ALL USING (studio_id = current_studio_id()) WITH CHECK (studio_id = current_studio_id());

CREATE POLICY galleries_tenant ON galleries
  FOR ALL USING (studio_id = current_studio_id()) WITH CHECK (studio_id = current_studio_id());

CREATE POLICY assets_tenant ON assets
  FOR ALL USING (studio_id = current_studio_id()) WITH CHECK (studio_id = current_studio_id());

CREATE POLICY renditions_tenant ON renditions
  FOR ALL USING (studio_id = current_studio_id()) WITH CHECK (studio_id = current_studio_id());

CREATE POLICY grants_tenant ON grants
  FOR ALL USING (studio_id = current_studio_id()) WITH CHECK (studio_id = current_studio_id());

CREATE POLICY favorites_tenant ON favorites
  FOR ALL USING (studio_id = current_studio_id()) WITH CHECK (studio_id = current_studio_id());


