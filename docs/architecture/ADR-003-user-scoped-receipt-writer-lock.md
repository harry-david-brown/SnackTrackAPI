# ADR 003: User-scoped receipt writer locking

**Status:** Accepted

Every additive or destructive receipt workflow uses the same user-scoped writer lock. A lock handle
contains a unique owner token. Redis release is compare-and-delete, leases are renewed for long work,
and ownership is asserted before write batches and transaction commit. The in-memory fallback is
explicitly single-process only.

Gmail import, ongoing tracking, provider-export replacement, receipt clear, onboarding reset, and
account deletion participate. Different users may write concurrently; same-user contention returns
the stable busy contract or waits for the bounded period selected by the operation.

The complete inventory is maintained in `docs/ACCOUNT_DATA_LIFECYCLE.md`. Architecture checks reject
new receipt SQL outside the canonical repository, documented lifecycle operations, and migrations.
