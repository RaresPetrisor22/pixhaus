# Architecture decision records

One decision per file: the context that forced it, and what it costs. The decision itself is visible
in the code — the reasoning is not.

ADRs are immutable once merged. A decision that turns out wrong gets a new ADR superseding it; the
old one is marked `Superseded by NNNN`.

| #                                                                  | Title                                              | Status   |
| ------------------------------------------------------------------ | -------------------------------------------------- | -------- |
| [0001](0001-capability-grants-instead-of-client-accounts.md)       | Capability grants instead of client accounts       | Accepted |
| [0002](0002-direct-to-storage-upload-with-server-side-finalize.md) | Direct-to-storage upload with server-side finalize | Accepted |
