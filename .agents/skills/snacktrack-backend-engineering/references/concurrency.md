# Concurrency

## Build the writer set

Before a destructive or replacing mutation, search for every path that writes the same rows:

- manual Gmail import;
- dashboard/app-triggered tracking check;
- periodic/external tracking batch;
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
- Treat in-memory fallback as single-process only.
- Return conflict/retry semantics when acquisition times out.
- Keep database transactions shorter than external provider work where possible.

## Race verification

Test ordering, not just method calls:

1. writer holds lock;
2. reset waits;
3. writer completes and releases;
4. reset acquires, deletes, commits, invalidates;
5. no stale writer can commit afterward.

Also test lock expiry/ownership replacement and multi-instance behavior when Redis is configured.
