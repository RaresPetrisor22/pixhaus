# 0003 — Photographer sessions, and the RLS bootstrap

- **Status:** Accepted
- **Date:** 2026-09-01
- **Affects:** `sessions`, `users`, migration `0002`, the app role's grants, every authenticated route

## Context

The problem:

**RLS makes login impossible.** Every policy in `0001` reads
`USING (studio_id = current_studio_id())`, where `current_studio_id()` comes from a variable the
caller sets per transaction. At login the caller holds an email, not a studio — so
`current_studio_id()` is NULL, the predicate is never TRUE, and the app role sees no rows. The same
applies to resolving a session cookie and to verifying an email token. `docs/api.md` referred to a
"RLS bootstrap note" that did not exist, and neither did the mechanism.

## Decision

**Un-tenanted lookups go through three `SECURITY DEFINER` functions**, added in `0002`:

```
auth_lookup_user_by_email(text)               login, resend-verification
auth_lookup_user_by_verification_token(text)  verify-email
auth_resolve_session(text)                    every authenticated request
```

They are owned by the migration owner, which owns the tables; `0001` uses `ENABLE ROW LEVEL SECURITY`
rather than `FORCE`, so the owner is not subject to its own policies and the function body sees every
row. Each is `STABLE` — the bootstrap layer reads and never writes — takes one unguessable key, and
returns a fixed handful of columns. `EXECUTE` is revoked from `PUBLIC`; the app role keeps it via an
`ALTER DEFAULT PRIVILEGES ... ON ROUTINES` line in the init script, and `0002` refuses to apply if
that pairing has come apart.

Registration needs none of this. It generates the studio's UUID in the application, declares it, and
only then inserts — so `WITH CHECK (id = current_studio_id())` passes on a tenant that does not exist
yet.

Above the bootstrap sits `TenantDb.withTenant(studioId, fn)`, the only way to obtain a queryable
client. There is no un-scoped alternative to reach for.

## Alternatives rejected

- **Redis sessions.** A second client, a second readiness check, and two stores that can disagree
  about whether you are signed in. The table already exists, cascades correctly, and one indexed
  primary-key lookup per request is not a bottleneck at this scale.
- **A second pool connected as the owner.** Every query on it bypasses RLS, so one forgotten
  predicate is a cross-tenant leak with no second wall.
- **`BYPASSRLS` on the app role.** The same, permanently.
- **Relaxing the policies** with `OR current_studio_id() IS NULL`. Inverts fail-closed into
  fail-open: _forgetting_ to set the tenant would show you every tenant.
- **Stateless JWTs.** Cannot be revoked before expiry, which kills logout and "sign out everywhere".

## Consequences

- Two facts are load-bearing and invisible: the migration runner must connect as the role that owns
  the tables, and RLS must stay `ENABLE`, never `FORCE`. Adding `FORCE` — which reads like hardening
  — would silently break every login. `packages/db/src/rls.test.ts` asserts both.
- The init script must run before `0002`, and it only runs against an empty volume. Existing
  deployments need `docker compose down -v`.
- Three functions to maintain, and M3 adds a fourth for grant-by-token.
