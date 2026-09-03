# Atomic reset workflow

## Server sequence

1. Authenticate and authorize the current user; never accept an arbitrary target identity.
2. Acquire the shared per-user mutation/import lock, waiting for an existing writer only within a bounded timeout.
3. Ensure Gmail/Outlook sync, scheduled tracking, manual import, queued workers, and export upload all use that same lock.
4. Open a database transaction.
5. Advance the account's import generation and supersede active durable import jobs before deleting their source state.
6. Remove provider credentials and connection identity required by the reset contract.
7. Delete all receipt sources and dependent operational/audit rows.
8. Replace lifecycle preferences with true schema defaults rather than hand-maintaining a partial field list.
9. Commit.
10. Release the lock in `finally` using ownership-safe semantics.
11. Invalidate server summary, wrapped, receipt, import-preference, and provider-health caches.
12. Return a stable success response with useful counts; on lock timeout return a conflict/retry response.

Do not implement a fresh reset as sequential client calls such as delete receipts → disconnect Gmail → reset preferences. Partial failure and in-flight writers make that sequence observably non-atomic.

## Client sequence

1. Invoke the single authoritative reset endpoint with a timeout long enough to wait for an existing import.
2. On success, remove affected query-cache entries rather than leaving stale data visible during invalidation.
3. Clear only feature-local device state included in the reset contract; preserve authentication/session storage.
4. Clear the per-user onboarding completion marker last.
5. Navigate declaratively to the initial authenticated experience.
6. On failure, keep the existing state visible and offer retry; do not claim partial success.

## Race tests

Cover at least:

- reset while a background Gmail sync holds the lock;
- reset while an Outlook or outage-recovered queued worker holds or awaits the lock;
- reset while an export upload holds the lock;
- scheduler eligibility immediately after reset;
- cache hit after reset;
- reset repeated on an already-fresh account;
- transaction failure before commit;
- lock timeout and ownership-safe release.
- an old-generation worker observing superseded state and refusing to commit.
