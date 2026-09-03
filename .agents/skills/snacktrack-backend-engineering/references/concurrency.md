# Concurrency

## Build the writer set

Before a destructive or replacing mutation, search for every path that writes the same rows:

- manual Gmail import;
- dashboard/app-triggered tracking check;
- periodic/external tracking batch;
- queued Gmail/Outlook history, tracking, and export workers;
- CSV/ZIP export upload;
- receipt clear/reset;
- account deletion;
- repair/backfill jobs.

All conflicting writers must use one per-user coordination protocol. Locking only the destructive endpoint does not prevent an uncoordinated writer from committing afterward.

## Distributed-lock requirements

- Use an atomic acquire operation with a unique ownership token.
- Bound acquisition wait and lock TTL.
- Renew or fence operations that may exceed TTL.
- Release with compare-and-delete so an expired owner cannot delete a newer lock.
- Treat in-memory fallback as single-process only and never use it as a production substitute when configured Redis is unavailable.
- Distinguish genuine contention (`IMPORT_IN_PROGRESS`) from unavailable coordination infrastructure (`LOCK_BACKEND_UNAVAILABLE`). Status checks must not report “not locked” when the backend is unknown.
- Keep database transactions shorter than external provider work where possible.

## Race verification

Test ordering, not just method calls:

1. writer holds lock;
2. reset waits;
3. writer completes and releases;
4. reset acquires, deletes, commits, invalidates;
5. no stale writer can commit afterward.

Also test lock expiry/ownership replacement and multi-instance behavior when Redis is configured.

## Queue and worker recovery

- PostgreSQL `import_jobs` plus the transactional outbox are authoritative; BullMQ is delivery infrastructure.
- Create the durable operation and outbox event atomically. A producer outage leaves publishable work in PostgreSQL rather than hanging the request or losing it.
- Lock-dependent workers start only when the lock capability is ready, pause when it drops, and resume after recovery. Notification delivery may remain independent.
- Infrastructure-delay handling must not consume the normal business-processing attempt budget.
- Workers re-read durable status/generation before work and no-op cancelled or superseded jobs.
