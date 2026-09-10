# 0005 — The short-lived client token

- **Status:** Accepted
- **Date:** 2026-09-10
- **Affects:** `apps/api/src/client/client-token.ts`, `grants.revoked_at`, the client-facing API

## Context

[ADR 0001](0001-capability-grants-instead-of-client-accounts.md) settled the two tiers: a database
row per link, and short-lived signed tokens minted from it. It did not say what those tokens are,
how they travel, or what revoking one actually does.

## Decision

**Format: HMAC-SHA256 over `base64url(json)`, hand-rolled in ~50 lines of `node:crypto`.** The
payload carries `{grant, studio, gallery, rights, epoch, exp}` and nothing else.

**Transport: the response body, then `Authorization: Bearer`.** Never a cookie.

**Revocation sets `revoked_at` and bumps `revocation_epoch`.** Both, because they kill different
things: `revoked_at` ends the magic link, the epoch ends badges already in a browser.

**TTL: one hour** (`CLIENT_TOKEN_TTL_SECONDS`), and presigned URLs outlive it at 90 minutes.

## Why

**No `alg` field, so there is nothing to negotiate and nothing to downgrade.** The JWT
signature-confusion family — `alg: none`, an HS256 signature verified against an RS256 key — needs a
field naming the algorithm in order to exist. One issuer, one verifier, one algorithm, no dependency.

**A cookie is sent automatically by any page on the origin**, which is a CSRF surface for a
credential handed to someone we never authenticated. The cost is that an `<img>` cannot carry the
credential, which is why `/api/client/gallery` embeds presigned URLs instead of redirecting per
thumbnail — and that turns out to be the cheaper design anyway.

**One signing secret, not one per grant.** A per-grant key would have to be read from the `grants`
row to verify anything, which is a database round trip per request — the exact cost tier 2 exists to
avoid. It would also put forgeable material in the table that leaks most easily; the server secret is
never in the database at all. Grant identity is inside the signed payload, so a badge cannot be
replayed against another grant.

**An epoch bump alone leaves the magic link working**, because tier 1 is a lookup on `token_hash`
with nothing in the row saying "revoked". Hence `revoked_at`. This corrects ADR 0001, which is
amended rather than superseded.

## Alternatives considered

- **`jose` / JWT** — a dependency and an algorithm-negotiation surface for a token only this API
  issues and only this API verifies.
- **An opaque token with a Redis lookup** — revocable instantly, at one round trip per thumbnail.
- **Per-grant signing keys** — see above.
- **The token in a query string** — leaks through history, `Referer` and screenshots.

## Consequences

**Good**

- Verification is local: no database, no Redis, no network on the hot path.
- Rotating `CLIENT_TOKEN_SECRET` invalidates every badge at once — a global emergency brake that
  per-grant revocation is not.
- The payload is inspectable, which makes the plane debuggable with `base64 -d`.

**Bad, and accepted**

- **Revocation is eventually consistent within an hour**, not the 5–15 minutes ADR 0001 imagined.
  A Redis denylist closes the gap when that is not good enough.
- Every API instance needs the same secret. Fine for a single-instance self-hosted deployment; it is
  the same caveat the in-memory rate limiter already carries.
- Rotating the secret logs every client out. Key versioning would fix it and is not built.
