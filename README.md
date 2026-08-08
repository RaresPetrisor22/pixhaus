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

Two endpoints exist so far:

| Endpoint   | Answers                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `/healthz` | Is the process alive? Checks nothing else, so a database blip cannot cause a restart loop. |
| `/readyz`  | Should this instance receive traffic? Checks Postgres; returns `503` when it cannot.       |

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

The worker and frontend are not built yet — see the [roadmap](#roadmap).

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
| `SMTP_URL`                                  | For magic links                                                     |
| `APP_URL`                                   | Public URL, used to build share links                               |

Any S3-compatible provider works. R2 is recommended: no egress fees, which matters a lot when clients
download multi-gigabyte galleries.

## Roadmap

- [x] M0 — Scaffold, Docker Compose, CI
- [ ] M1 — Photographer accounts
- [ ] M2 — Galleries and upload pipeline
- [ ] M3 — Share links, client gallery, downloads
- [ ] M4 — Bulk zip
- [ ] M5 — Favorites and selections

## After mvp goals

Payments and print sales, custom domains, watermarks, face detection, mobile apps, etc.
