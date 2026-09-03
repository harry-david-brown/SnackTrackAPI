# Reset diagnostics

Use source timestamps to distinguish stale UI from data that was reinserted.

## Read-only investigation order

1. Query receipt counts grouped by `data_source`, including creation/first-seen ranges.
2. Query Gmail and provider-aware mailbox connection/token-presence booleans; never select token values.
3. Query import/export/consent/runtime preferences and their timestamps.
4. Query recent Gmail and provider-aware mailbox sync runs by trigger, outcome, start, completion, and counts.
5. Query durable import jobs, generation, and unpublished outbox state around the reset.
6. Query recent import preference event names and timestamps.
7. Compare the reset request time with writer completion and receipt insertion times.
8. Check server cache invalidation logs and client cache ownership.

## Safe query shape

Scope every query to the authenticated/test user ID and select only:

- booleans indicating credential presence;
- lifecycle enums and timestamps;
- aggregate counts and min/max timestamps;
- operation type/outcome/error code.

Never print email bodies, OAuth tokens, password hashes, refresh tokens, or unrelated users. Ask before querying a non-local or production database.

## Interpretation

- Rows whose creation timestamps precede reset plus nonzero cached UI only: likely stale cache.
- A sync starts before reset but commits rows after deletion: missing shared lock/race.
- Sync starts after reset with credentials/consent still active: incomplete reset contract.
- A queued worker commits after reset with an older import generation: missing durable-job supersession/generation enforcement.
- No receipt rows but summary remains nonzero: server or app analytics cache was not removed.
- Receipt rows remain and no delete/reset timestamp exists: the intended destructive endpoint did not run or targeted the wrong user/database.
