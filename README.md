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

Full write-up with diagrams and a threat model: [`docs/architecture.md`](docs/architecture.md).

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/aperture
cd aperture
cp .env.example .env
docker compose up
```

Open http://localhost:3000. This starts the API, worker, Postgres, Redis, MinIO (local S3), and Mailpit
(catches outgoing email at http://localhost:8025) — no external accounts needed to try it.

## Configuration

| Variable                                    | Description                                                         |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `STORAGE_ENDPOINT`                          | S3-compatible endpoint (MinIO, Cloudflare R2, Backblaze B2, Wasabi) |
| `STORAGE_BUCKET`                            | Bucket name                                                         |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | Bucket credentials — scope them to this bucket only                 |
| `DATABASE_URL`                              | Postgres connection string                                          |
| `REDIS_URL`                                 | Redis connection string                                             |
| `SMTP_URL`                                  | For magic links                                                     |
| `APP_URL`                                   | Public URL, used to build share links                               |

Any S3-compatible provider works. R2 is recommended: no egress fees, which matters a lot when clients
download multi-gigabyte galleries.

## Roadmap

- [ ] M0 — Scaffold, Docker Compose, CI
- [ ] M1 — Photographer accounts
- [ ] M2 — Galleries and upload pipeline
- [ ] M3 — Share links, client gallery, downloads
- [ ] M4 — Bulk zip
- [ ] M5 — Favorites and selections

## Non-goals

Payments and print sales, custom domains, face detection, mobile apps. Aperture delivers photos to
clients. That's the whole scope.

## Contributing

Issues and PRs welcome. If you're a photographer using this, bug reports about real workflows are worth
more than code.

## License

[AGPL-3.0](LICENSE)
