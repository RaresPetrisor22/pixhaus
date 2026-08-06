# 0001 — Capability grants instead of client accounts

- **Status:** Accepted
- **Date:** 2026-08-05
- **Affects:** `grants` and `favorites` tables, the client-facing API, `authorize()`

## Context

The product requires that a client opens a link without making an account. But the photographer
still needs expiry, per-recipient revocation, and different rights per link — requirements that
normally imply accounts.

Second constraint: a 500-photo gallery is 500 thumbnail requests. Whatever we check per image has to
be cheap.

## Decision

A client's identity is a **capability grant** — a row that _is_ the permission:

```
grants(id, gallery_id, studio_id, token_hash, audience_email,
       rights_mask, revocation_epoch, expires_at, ...)
```

Access is two-tier:

1. The magic link carries a long-lived random token (we store only its SHA-256). `GET /g/:token`
   loads the grant, checks expiry and epoch, and mints —
2. a short-lived signed token (5–15 min) carrying `{grant_id, rights_mask, epoch}`. Every subsequent
   request verifies that signature only.

Revocation is `UPDATE grants SET revocation_epoch = revocation_epoch + 1`.

**Why two tiers:** a pure signed token is fast but unrevocable; a DB lookup per request is revocable
but costs 500 queries per gallery view. Tier 2 gives speed, tier 1 gives revocation.

## Alternatives considered

- **Real client accounts** — contradicts the requirement, and still needs a table naming
  `(user, gallery, rights, expiry)`. That table is a grant. So: grants _plus_ an account system.
- **Unguessable URL, no DB row** — no enforceable expiry, no revocation, no audit. The row is the
  only difference, and it is the part that matters.
- **Per-gallery password** — can't be revoked per recipient, and makes the client type a credential.

## Consequences

**Good**

- No client account system to build or support.
- Revocation is one `UPDATE`; expiry is one column.
- Rights as a bitmask means delivery and proofing galleries are one code path.
- `favorites.grant_id` gives two recipients independent selections for free.
- The client API needs no `:galleryId` — a client cannot express a request for another gallery.

**Bad, and accepted**

- Revocation is eventually consistent, bounded by the token TTL. A Redis denylist closes the gap if
  that is not good enough.
- No cross-gallery history for a client sent several links.
- A forwarded magic link works. Bounded by expiry, revocation, and rate limiting — not prevented.
- No sub-grants or delegation (explicit non-goal).
