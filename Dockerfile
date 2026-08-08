# syntax=docker/dockerfile:1
#
# One Dockerfile, two targets:
#
#   --target api      the HTTP server
#   --target migrate  a one-shot container that applies migrations and exits
#
# They share the dependency install, so the second costs almost nothing.
#
# The build context is the repo root, not apps/api — a pnpm workspace package
# cannot be installed without the root manifest, the workspace file, and the
# lockfile.

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo


# ---------------------------------------------------------------------------
# deps — every dependency, installed from manifests alone.
#
# Only the package.json files are copied here, not the source. Docker caches
# this layer on their contents, so editing application code does not trigger a
# reinstall.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile


# ---------------------------------------------------------------------------
# build — compile apps/api to dist/
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN pnpm --filter @pixhaus/api build


# ---------------------------------------------------------------------------
# api — runtime. Production dependencies and compiled output only: no source,
# no TypeScript, no dev tooling.
# ---------------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @pixhaus/api

COPY --from=build /repo/apps/api/dist apps/api/dist

# The node image ships an unprivileged `node` user. Containers run as root
# unless told otherwise, and this one has no reason to.
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]


# ---------------------------------------------------------------------------
# migrate — one-shot. Runs the migration runner, then exits.
#
# No build stage: packages/db is plain TypeScript with no decorators, so Node
# strips the types and runs the source directly. That is the same property that
# lets `pnpm db:migrate` work without a compile step.
# ---------------------------------------------------------------------------
FROM base AS migrate
ENV NODE_ENV=production

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --prod --filter @pixhaus/db

COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations

USER node

CMD ["node", "packages/db/src/migrate.ts", "up"]
