#!/bin/sh
# Runs once, automatically, on first boot against an empty data volume
# (anything in /docker-entrypoint-initdb.d/ does). To re-run this after
# editing it: docker compose down -v && docker compose up -d --wait
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';

	-- Connect + see the schema. Table-level privileges (SELECT/INSERT/...)
	-- are granted per-table by migration 0001, once the tables exist.
	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
	GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};
EOSQL

echo "role ${APP_DB_USER} created (owns nothing, subject to RLS)"
