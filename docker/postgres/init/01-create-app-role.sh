#!/bin/sh
# Runs once, automatically, on first boot against an empty data volume
# (anything in /docker-entrypoint-initdb.d/ does). To re-run this after
# editing it: docker compose down -v && docker compose up -d --wait
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';

	-- Connect + see the schema.
	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
	GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};

	-- Every table the owner creates from here on -- i.e. every table any
	-- migration ever adds -- is automatically readable and writable by the app
	-- role, with no per-migration GRANT boilerplate to forget.
	--
	-- A blanket DML grant is safe here because table privileges are not what
	-- separates tenants; the row-level security policies in migration 0001 are.
	-- Note what is NOT granted: no CREATE, no ALTER, no DROP. The app role can
	-- change rows and never the schema.
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_DB_USER};
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO ${APP_DB_USER};
EOSQL

echo "role ${APP_DB_USER} created (owns nothing, subject to RLS)"
