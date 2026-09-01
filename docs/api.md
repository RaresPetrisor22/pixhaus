# API surface

Every route the finished product exposes. No implementations — this is the target, written
before the API exists so there is something to build against.

Routes are grouped by **auth plane**, because that is the axis that actually matters here: the
photographer plane and the client plane share almost no machinery.

---

## Conventions

**Base paths.** JSON lives under `/api`. Three things sit at the root because they are typed,
clicked, or probed by something that will not prepend `/api`: `/g/:token` (magic link), `/healthz`,
`/readyz`.

**No version prefix.** No `/api/v1`. The frontend and the API ship in the same repo and deploy
together, so there is never a client on an old contract. Add versioning the day that stops being
true, not before.

**Auth column vocabulary.** Every route below is labelled with exactly one of:

| Label           | Meaning                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `public`        | No credential.                                                                                |
| `session`       | Photographer session cookie. Tenant is derived from the session, never from the request body. |
| `grant:<right>` | Client capability token that must carry the named right bit.                                  |

**Two principals, one function.** Both `session` and `grant` resolve to a principal that goes into
the same call:

```
authorize(principal, action, resource, context) -> Decision
```

Actions: `gallery.view`, `gallery.manage`, `asset.view_preview`, `asset.download_full`,
`selection.favorite`, `selection.submit`. There are no permission checks anywhere else.

**Rights bits** (`grants.rights_mask`): `1 = view`, `2 = download`, `4 = favorite`. A delivery
gallery is `3`, a proofing gallery is `5`.

**Credential transport.**

- Photographer: `httpOnly`, `Secure`, `SameSite=Lax` session cookie. The value is the raw session
  token; `sessions.id` stores its SHA-256, so the database never holds a usable cookie.
- Client: `GET /g/:token` returns a short-lived signed token **in the response body**. The SPA holds
  it in memory and sends `Authorization: Bearer <token>`. Deliberately not a cookie — a cookie would
  be sent automatically by any page on the origin, which is a CSRF surface for a credential handed to
  someone we have not authenticated.

**IDs** are UUIDs everywhere. **Timestamps** are ISO 8601 UTC.

**Errors** are a consistent shape:

```json
{ "error": { "code": "gallery_not_found", "message": "..." } }
```

| Status | Used for                                             |
| ------ | ---------------------------------------------------- |
| `400`  | Malformed request.                                   |
| `401`  | No credential, or an expired/invalid one.            |
| `403`  | Valid credential, insufficient rights.               |
| `404`  | Not found **or not yours**.                          |
| `409`  | Conflict (duplicate email, asset already finalized). |
| `410`  | The grant is revoked or expired.                     |
| `413`  | Upload exceeds the size ceiling.                     |
| `422`  | Well-formed but semantically invalid.                |
| `429`  | Rate limited.                                        |

The `404`-not-`403` rule matters: a cross-tenant request must not be able to distinguish "this
gallery does not exist" from "this gallery exists and belongs to someone else". Returning `403`
would confirm existence. This falls out naturally from RLS — the row simply is not visible, so the
handler genuinely cannot tell the difference either.

---

## Plane A — photographer

### Account and session

| Method   | Path                            | Auth      | Notes                                                                                                         |
| -------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/auth/register`            | `public`  | Creates a studio **and** its first `owner` user in one transaction. Sends a verification email. Rate limited. |
| `POST`   | `/api/auth/verify-email`        | `public`  | Token in the body. Sets `users.email_verified_at`.                                                            |
| `POST`   | `/api/auth/resend-verification` | `public`  | Rate limited. Responds identically whether or not the address exists.                                         |
| `POST`   | `/api/auth/login`               | `public`  | Sets the session cookie. Rate limited per IP **and** per email.                                               |
| `POST`   | `/api/auth/logout`              | `session` | Deletes the current session row.                                                                              |
| `DELETE` | `/api/auth/sessions`            | `session` | "Sign out everywhere" — deletes every session for the user.                                                   |
| `GET`    | `/api/auth/me`                  | `session` | Current user + studio. What the SPA calls on boot to decide if it is logged in.                               |

Registration and login are two of the operations that must run before a tenant is known — see the
header of `packages/db/migrations/0002_auth_bootstrap.sql` and [ADR 0003](adr/0003-photographer-sessions-and-the-rls-bootstrap.md).

Rate limits, in-memory and therefore per API process:

| Route                 | Per IP      | Per email   |
| --------------------- | ----------- | ----------- |
| `register`            | 5 / hour    | —           |
| `login`               | 30 / 15 min | 10 / 15 min |
| `resend-verification` | 10 / hour   | 3 / hour    |
| `verify-email`        | 30 / hour   | —           |
| everything else       | 120 / min   | —           |

### Galleries

| Method   | Path                        | Auth      | Notes                                                                                                                                 |
| -------- | --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/galleries`            | `session` | `{ title }`. `studio_id` comes from the session, never the body.                                                                      |
| `GET`    | `/api/galleries`            | `session` | Paginated, newest first — served by `galleries (studio_id, created_at DESC)`.                                                         |
| `GET`    | `/api/galleries/:galleryId` | `session` |                                                                                                                                       |
| `PATCH`  | `/api/galleries/:galleryId` | `session` | Rename, change `status`.                                                                                                              |
| `DELETE` | `/api/galleries/:galleryId` | `session` | Cascades to assets, renditions, grants, favorites. Storage objects are swept separately — the database cascade does not delete bytes. |

### Upload

| Method   | Path                                    | Auth      | Notes                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/galleries/:galleryId/uploads`     | `session` | `{ filename, size, content_type }` → `{ asset_id, upload_url, expires_at }`. Inserts the asset as `pending` and mints a presigned PUT. **The declared size and content type are used only to scope the presigned URL — they are never trusted as facts.** |
| `POST`   | `/api/uploads/:assetId/finalize`        | `session` | The trust boundary. Server HEADs the object, reads magic bytes, records what it actually found, flips status to `uploaded`, enqueues the rendition job. `202`.                                                                                            |
| `GET`    | `/api/galleries/:galleryId/assets`      | `session` | Keyset paginated via opaque `?cursor=` — served by `assets (gallery_id, position, id)`. Never `OFFSET`.                                                                                                                                                   |
| `DELETE` | `/api/assets/:assetId`                  | `session` |                                                                                                                                                                                                                                                           |
| `GET`    | `/api/assets/:assetId/renditions/:kind` | `session` | `302` to a presigned GET. `kind` ∈ `thumb`, `grid`, `preview`.                                                                                                                                                                                            |

The browser's `PUT` of the actual bytes goes **directly to object storage** and appears nowhere in
this table, because it never reaches the API. See [ADR 0002](adr/0002-direct-to-storage-upload-with-server-side-finalize.md).

### Share links (grants)

| Method   | Path                               | Auth      | Notes                                                                                                                                                                                  |
| -------- | ---------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/galleries/:galleryId/grants` | `session` | `{ audience_email, rights, expires_at, label? }`. Generates the token, stores only its hash, emails the magic link. **The raw token is in this response and never retrievable again.** |
| `GET`    | `/api/galleries/:galleryId/grants` | `session` | Links on this gallery, with `last_seen_at`.                                                                                                                                            |
| `DELETE` | `/api/grants/:grantId`             | `session` | Revoke: `UPDATE ... SET revocation_epoch = revocation_epoch + 1`. Not a row delete — the record of what was shared survives.                                                           |
| `POST`   | `/api/grants/:grantId/resend`      | `session` | Re-sends the existing magic link. Rate limited.                                                                                                                                        |
| `GET`    | `/api/grants/:grantId/favorites`   | `session` | What this client selected, and whether they submitted. **M5.**                                                                                                                         |

### Bulk download

| Method | Path                                  | Auth      | Notes                                                        |
| ------ | ------------------------------------- | --------- | ------------------------------------------------------------ |
| `POST` | `/api/galleries/:galleryId/downloads` | `session` | Enqueue a zip build. `202` → `{ job_id }`. **M4.**           |
| `GET`  | `/api/downloads/:jobId`               | `session` | Poll. `{ status }`, plus a presigned URL once ready. **M4.** |

⚠️ **Zip job state has no home in the current schema.** The eight tables have nowhere to record
`job_id → status → result key`, and M4 also wants to cache a built zip by gallery version. That is
either a ninth table or Redis. Flagging it now rather than discovering it in M4 — it does not need
deciding today.

---

## Plane B — client

No account exists. The credential is the grant.

| Method   | Path                                           | Auth             | Notes                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/g/:token`                                    | `public`         | The magic link target. The token **is** the credential. Hashes it, loads the grant, checks expiry and revocation epoch, returns a short-lived signed token (5–15 min). Rate limited per grant. `410` if revoked or expired. |
| `POST`   | `/api/client/token`                            | `public`         | Refresh: exchange an unexpired short-lived token for a fresh one. **Re-checks the epoch against the database** — this is where revocation actually bites.                                                                   |
| `GET`    | `/api/client/gallery`                          | `grant:view`     | Gallery metadata plus paginated assets with dimensions and blurhash.                                                                                                                                                        |
| `GET`    | `/api/client/assets/:assetId/renditions/:kind` | `grant:view`     | `302` to a presigned GET, ~5 min. The per-thumbnail hot path: signature check only, no database round trip.                                                                                                                 |
| `POST`   | `/api/client/assets/:assetId/download`         | `grant:download` | Presigned GET with `content-disposition: attachment`.                                                                                                                                                                       |
| `POST`   | `/api/client/downloads`                        | `grant:download` | Zip of the whole gallery. **M4.**                                                                                                                                                                                           |
| `GET`    | `/api/client/downloads/:jobId`                 | `grant:download` | Poll. **M4.**                                                                                                                                                                                                               |
| `PUT`    | `/api/client/favorites/:assetId`               | `grant:favorite` | Heart. Idempotent — `UNIQUE (grant_id, asset_id)` makes a double tap a no-op, not a duplicate. **M5.**                                                                                                                      |
| `DELETE` | `/api/client/favorites/:assetId`               | `grant:favorite` | Un-heart. **M5.**                                                                                                                                                                                                           |
| `GET`    | `/api/client/favorites`                        | `grant:favorite` | This grant's current selection. **M5.**                                                                                                                                                                                     |
| `POST`   | `/api/client/selection/submit`                 | `grant:favorite` | Sets `grants.selection_submitted_at`, notifies the photographer. **M5.**                                                                                                                                                    |

**No `:galleryId` anywhere in this plane, on purpose.** The grant names exactly one gallery, so the
client's own identity determines which gallery they are talking about. There is no parameter to
tamper with — a client cannot even _express_ a request for another gallery. Contrast the
photographer plane, where `:galleryId` is supplied and must be authorized on every call.

Rights are checked **at presigned-URL mint time**, not at page render. The presigned URL is the real
security boundary; everything before it is UI.

---

## Operations

| Method | Path       | Auth     | Notes                                                                                                                     |
| ------ | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz` | `public` | Liveness. Is the process up. No dependency checks — a failing dependency must not get the container killed and restarted. |
| `GET`  | `/readyz`  | `public` | Readiness. Postgres, Redis, and storage reachable. `503` when not.                                                        |
