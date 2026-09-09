# 0004 — BullMQ on Redis for the rendition queue

- **Status:** Accepted
- **Date:** 2026-09-09
- **Affects:** `apps/worker`, `packages/jobs`, finalize, the reaper

## Context

Finalize returns `202` and hands the work off: download the original, make three renditions, write
them back. That is seconds of CPU and tens of megabytes per photo, and a wedding upload arrives as
hundreds of them at once. It cannot run in the request.

The requirements are ordinary: retries with backoff, a dead-letter state, repeatable jobs for the
reaper, and no new infrastructure — Redis is already in the stack.

## Decision

BullMQ on the existing Redis.

`packages/jobs` holds the queue names, payload types and job options, imported by both producer and
consumer. A queue whose contract lives in one of its two ends is how the two drift apart.

Two queues, two producers:

- `renditions` — the API enqueues from finalize with `jobId: assetId`, so a double-finalize cannot
  double-enqueue. Three attempts, exponential backoff; exhausted retries set the asset to `failed`.
- `reaper` — no producer. The worker registers a BullMQ job scheduler on boot, and BullMQ generates
  the jobs on a cron pattern. A sweep is caused by a clock, not by a user.

## Alternatives considered

- **`pg-boss` or `LISTEN`/`NOTIFY`** — one less moving part, and Postgres is already there. Rejected
  because Redis is there too, and M4's zip jobs want it regardless.
- **A hand-rolled Redis list consumer** — no retries, no backoff, no DLQ, no repeatable jobs. All
  four are requirements, and rebuilding them badly is worse than a dependency.
- **A hosted queue** — this is self-hosted software. An account requirement is a non-starter.

## Consequences

**Good**

- Retries, backoff, DLQ and schedulers are configuration, not code.
- The worker scales independently of the API, and its memory is bounded by job concurrency.
- Job state is inspectable with `redis-cli` when something misbehaves.

**Bad, and accepted**

- Redis becomes load-bearing rather than incidental, and `/readyz` checks it.
- Redis persistence is not a database. A lost queue means renditions that never ran — recoverable by
  requeueing `uploaded` assets, but nothing does that automatically yet.
- BullMQ owns its Redis key layout, so migrating off it is a rewrite of both ends.
