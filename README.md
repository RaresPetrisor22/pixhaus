# Pixhaus

> Self-hosted client galleries for photographers. Upload photos, send a link, done — your clients never make an account.

**Status: early development.** Not yet ready for production use. See [roadmap](#roadmap).

<!-- Add a screenshot here as soon as you have one. It's the single highest-impact thing in this file. -->

## Why

Every client gallery product is a subscription. Pixieset's free tier is 3 GB — about half a wedding.

Pixhaus is the same core workflow, self-hosted, with your own storage. You bring an S3-compatible
bucket; storage costs you roughly $0.15/month per 10 GB instead of $10.

## Features

- Upload full-resolution photos straight from the browser to your bucket
- Automatic thumbnails and web previews (ICC-correct, EXIF stripped)
- Share links with expiry, per-link permissions, and instant revocation
- **Clients need no account** — just a link
- Download single photos or the whole gallery as a zip
- Proofing mode: clients heart favorites and submit a selection

## How it works

A few decisions worth knowing before you read the code:

- **One gallery model, not two.** A gallery is a set of photos plus a grant of rights to an audience for
  a window. Delivery is `{view, download}`; proofing is `{view, favorite}`. Same table, different rights.
- **Clients have no accounts.** Access is a capability grant — a database row that _is_ the permission,
  presented via a signed magic link. Expiring, revocable, no password.
- **Photo bytes never touch the API.** Uploads go browser → bucket via presigned URL; downloads go
  bucket → browser. The API mints URLs and verifies objects server-side after upload. This is why it's
  cheap to run.

Documentation:

- [`docs/architecture.md`](docs/architecture.md) — diagrams, data model, threat model
- [`docs/api.md`](docs/api.md) — every route, method, and auth requirement
- [`docs/adr/`](docs/adr/) — why the load-bearing decisions were made

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/pixhaus
cd pixhaus
cp .env.example .env
docker compose up -d --wait
```

That is the whole thing — no Node install required. Compose starts Postgres, Redis, MinIO (local S3)
and Mailpit (catches outgoing email at http://localhost:8025), applies the database migrations, and
serves the API on http://localhost:3000. No external accounts needed to try it.

`--wait` blocks until every service passes its health check, so when the command returns the stack is
genuinely ready rather than merely started.

| Endpoint   | Answers                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `/healthz` | Is the process alive? Checks nothing else, so a database blip cannot cause a restart loop. |
| `/readyz`  | Should this instance receive traffic? Checks Postgres; returns `503` when it cannot.       |

Photographer accounts work as of M1:

| Method   | Route                           | Auth    |
| -------- | ------------------------------- | ------- |
| `POST`   | `/api/auth/register`            | public  |
| `POST`   | `/api/auth/verify-email`        | public  |
| `POST`   | `/api/auth/resend-verification` | public  |
| `POST`   | `/api/auth/login`               | public  |
| `POST`   | `/api/auth/logout`              | session |
| `DELETE` | `/api/auth/sessions`            | session |
| `GET`    | `/api/auth/me`                  | session |

Outgoing mail lands in Mailpit at http://localhost:8025; in development the verification link is also
written to the API log. Full detail in [`docs/api.md`](docs/api.md).

```bash
curl -X POST localhost:3000/api/auth/register -H 'content-type: application/json'   -d '{"studioName":"Your Studio","email":"you@example.com","password":"a long passphrase"}'
```

### Working on the code

Compose runs the API from a built image, so it will not pick up source edits. Either rebuild it:

```bash
docker compose up -d --build api
```

or run the API on the host against the compose services, which is faster to iterate on:

```bash
pnpm install
pnpm db:migrate          # migrations from your shell, as the owner role
pnpm build && pnpm api   # http://localhost:3000
```

Stop the containerised API first (`docker compose stop api`) or the two will fight over port 3000.

`pnpm test` runs the row-level-security suite against your dev database when `DATABASE_URL` is
reachable, and skips it with a message when it is not.

> **Editing `docker/postgres/init/`?** It runs once, on an empty data volume. Re-run it with
> `docker compose down -v && docker compose up -d --wait`.

The worker and frontend are not built yet — see the [roadmap](#roadmap).

## How auth works

Two planes, deliberately different. Only the first exists today.

**Photographers** get real accounts: argon2id passwords, email verification, and server-side sessions
in Postgres. The cookie is an opaque 256-bit token, `HttpOnly` and `SameSite=Lax`; the database stores
only its SHA-256, so a dump contains no usable credentials, and revoking a session is a row delete.

**Tenant isolation is enforced twice.** Every row carries `studio_id`, and every table has a row-level
security policy keyed on a per-transaction variable. `TenantDb.withTenant(studioId, fn)` is the only
way to obtain a database client, so a query cannot be written without a tenant — and if one ever is,
RLS returns nothing rather than someone else's rows.

Login, session lookup and email verification have to run _before_ the tenant is known, which RLS would
otherwise make impossible. They go through three narrow `SECURITY DEFINER` functions that each answer
one keyed question — see [ADR 0003](docs/adr/0003-photographer-sessions-and-the-rls-bootstrap.md).

Clients (M3) will not have accounts at all; see
[ADR 0001](docs/adr/0001-capability-grants-instead-of-client-accounts.md).

## Configuration

| Variable                                    | Description                                                         |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `STORAGE_ENDPOINT`                          | S3-compatible endpoint (MinIO, Cloudflare R2, Backblaze B2, Wasabi) |
| `STORAGE_REGION`                            | Region string the SDK requires — value is provider-specific         |
| `STORAGE_BUCKET`                            | Bucket name                                                         |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | Bucket credentials — scope them to this bucket only                 |
| `STORAGE_FORCE_PATH_STYLE`                  | `true` for MinIO; provider-dependent otherwise                      |
| `DATABASE_URL`                              | Postgres connection string                                          |
| `REDIS_URL`                                 | Redis connection string                                             |
| `SMTP_URL`                                  | Outgoing mail — magic links and verification                        |
| `SMTP_FROM`                                 | From address on those emails                                        |
| `APP_URL`                                   | Public origin, used to build links that go out in email             |
| `SESSION_TTL_HOURS`                         | Session lifetime, slid forward on use (default 336 = 14 days)       |
| `EMAIL_VERIFICATION_TTL_HOURS`              | Verification link lifetime (default 24)                             |

Any S3-compatible provider works. R2 is recommended: no egress fees, which matters a lot when clients
download multi-gigabyte galleries.

## Roadmap

- [x] M0 — Scaffold, Docker Compose, CI
- [x] M1 — Photographer accounts
- [ ] M2 — Galleries and upload pipeline
- [ ] M3 — Share links, client gallery, downloads
- [ ] M4 — Bulk zip
- [ ] M5 — Favorites and selections

## After mvp goals

Payments and print sales, custom domains, watermarks, face detection, mobile apps, etc.
