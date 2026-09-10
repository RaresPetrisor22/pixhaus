# Architecture decision records

One decision per file: the context that forced it, and what it costs. The decision itself is visible
in the code — the reasoning is not.

ADRs are immutable once merged. A decision that turns out wrong gets a new ADR superseding it; the
old one is marked `Superseded by NNNN`. The exception is a step that moved rather than reversed:
0002's hashing note and 0001's revocation note are amended in place and dated.

| #                                                                  | Title                                              | Status                       |
| ------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------- |
| [0001](0001-capability-grants-instead-of-client-accounts.md)       | Capability grants instead of client accounts       | Accepted, amended 2026-09-10 |
| [0002](0002-direct-to-storage-upload-with-server-side-finalize.md) | Direct-to-storage upload with server-side finalize | Accepted, amended 2026-09-09 |
| [0003](0003-photographer-sessions-and-the-rls-bootstrap.md)        | Photographer sessions and the RLS bootstrap        | Accepted                     |
| [0004](0004-bullmq-on-redis-for-the-rendition-queue.md)            | BullMQ on Redis for the rendition queue            | Accepted                     |
| [0005](0005-the-short-lived-client-token.md)                       | The short-lived client token                       | Accepted                     |
