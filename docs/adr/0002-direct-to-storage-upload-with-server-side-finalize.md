# 0002 — Direct-to-storage upload with server-side finalize

- **Status:** Accepted
- **Date:** 2026-08-05
- **Amended:** 2026-09-09 — step 3 no longer computes the hash; see the note there.
- **Affects:** `assets` and its lifecycle, the upload API, the storage interface, the worker

## Context

A wedding gallery is 300–800 files at 15–40 MB each — ~10 GB per session, on hardware a photographer
self-hosts.

Proxying that through the API ties process concurrency to upload duration, pays for every byte twice
in bandwidth, and makes API scaling a function of the burstiest traffic in the system. The same
argument applies to downloads.

The catch: if the server never sees the bytes, it does not know what is in its bucket.

## Decision

The browser PUTs directly to storage via a presigned URL; the server then verifies the object
itself.

1. `POST /api/galleries/:id/uploads` — insert the asset as `pending`, mint a presigned PUT. The
   client's declared filename, size, and type scope that URL only; they are not recorded as facts.
2. Browser PUTs the bytes. Never touches the API.
3. `POST /api/uploads/:assetId/finalize` — **the trust boundary.** `HEAD` for real size, ranged `GET`
   for magic bytes. Only what the server observed is written. Status → `uploaded`, rendition job
   enqueued.

> **Amended 2026-09-09.** Step 3 originally computed `content_hash` here. The worker does it instead:
> it already streams the whole original, so hashing there is free, whereas hashing at finalize would
> pull every 40 MB file back through the API — the one cost this ADR exists to avoid. `content_hash`
> stays NULL until the worker writes it, alongside `width`, `height` and `blurhash`.

The presigned URL is scoped three ways: **key prefix** (can't write outside their path),
**exact `content-length`** (can't upload 40 GB), **short expiry** (a leaked URL dies in 15 min).

Presigned PUT signs `content-length` as an exact value rather than a range — `content-length-range` is
a POST-policy condition. Finalize's `HEAD` is the real ceiling either way.

**Finalize is not optional.** Without it, anyone who can get an upload URL can store arbitrary
content and have it recorded as a photo. This is enforced structurally: every server-observable
column in `assets` (`content_type`, `content_hash`, `size_bytes`, `width`, `height`) is nullable and
stays NULL until finalize.

## Alternatives considered

- **Proxy through the API** — the default; rejected on the cost argument above.
- **Trust client metadata, skip finalize** — an open file host. Tempting because the happy path looks
  identical; it only differs under attack.
- **Resumable upload (tus)** — better for 40 MB files on bad wifi, but needs a component in the
  request path or provider-specific multipart. Revisit post-MVP.
- **Presigned POST policy** — equivalent security, more awkward from a fetch-based SPA.

## Consequences

**Good**

- The API never touches an image byte in either direction. Steady-state serving cost ≈ zero.
- Downloads use the same mechanism, so rights enforcement has one shape: checked at mint time, with
  the presigned URL as the boundary.
- Storage stays behind a thin interface — MinIO and any S3-compatible provider are config.

**Bad, and accepted**

- Every presigned URL is a row that may never be finalized. The `orphaned` status and the partial
  index `(created_at) WHERE status = 'pending'` exist for this; the reaper is load-bearing.
- The bucket needs CORS configured.
- The provider must support presigned PUT with signed `content-length` and `content-type` headers.
- Finalize costs a round trip to storage — cheap next to what it replaces, not free.
