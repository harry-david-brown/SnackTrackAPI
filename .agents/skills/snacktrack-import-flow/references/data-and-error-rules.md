# Data, consent, and error rules

## Gmail health

- Validate token health before enabling an import CTA when practical.
- Cache health briefly to avoid excessive provider calls, but invalidate it after reconnect/token changes.
- `invalid_grant` is a durable reconnect-required condition. Clear or disable unusable credentials while preserving the known account identity and already imported receipt history.
- A timeout/provider outage is temporary unavailability, not revocation. Do not destroy credentials or mark import complete.
- Preserve a machine-readable API error such as `GMAIL_RECONNECT_REQUIRED` so every UI surface chooses the same recovery.

## Consent

- One-time OAuth/import permission and ongoing email monitoring permission are separate product decisions.
- Obtain explicit permission before background inspection for future receipts or Uber data-ready messages.
- Store consent state and timestamps server-side; do not infer consent from connection alone.
- Revocation must stop scheduled reads promptly.
- Keep copy specific about what is read and why. Never imply SnackTrack can automatically download Uber’s export archive.

## Receipt identity and merging

- Gmail incremental imports should upsert by stable provider/message identity rather than create duplicates.
- Track new, updated, and unchanged counts accurately; zero new orders can still be a successful incremental sync.
- Export imports may contain richer historical data and line items. Apply documented overlap/cutoff replacement consistently and preserve Gmail receipts newer than the export coverage.
- Derive source coverage from durable receipt source metadata, not only from onboarding preferences.
- Recompute or invalidate dashboard, summary, recent-activity, and receipt-list caches after writes.

## PostgreSQL mutation safety

- Cast reused query parameters explicitly when PostgreSQL could infer conflicting enum/text/timestamp types; this avoids “inconsistent types deduced for parameter” failures.
- When changing a column referenced by a trigger, drop/recreate or otherwise migrate dependent trigger definitions in the same transaction.
- Make startup migrations idempotent and test both fresh and existing databases.

## Import/reset concurrency

- Build the complete writer set: manual Gmail import, app-triggered tracking, scheduled batch tracking, export upload, reset, clear, and deletion.
- Make every conflicting writer use the same per-user lock protocol.
- Acquire a destructive-operation lock before its transaction and release it in `finally`.
- Use ownership-token/fenced distributed locks so an expired owner cannot release a newer lock.
- Bound reset waits and return a retryable conflict when the current writer does not finish in time.
- Invalidate derived caches after commit; destructive client operations must remove stale cache values rather than leave them renderable.

## Error contract

For every failure, define:

1. HTTP status and stable machine-readable code.
2. Whether persisted lifecycle state changes.
3. Whether credentials remain usable.
4. Whether previous receipt data remains visible.
5. Which UI recovery action appears.
6. Which caches are invalidated/refetched.

Do not convert exceptions into a nominal success merely to keep the flow moving. A success response must mean the requested operation actually ran to its valid completion condition.

## Regression scenarios

- Import attempted with expired/revoked refresh token.
- Health check temporarily unavailable.
- Duplicate Gmail import with no new receipts.
- Export uploaded after Gmail history.
- Gmail receives orders newer than the export cutoff.
- Preference says export incomplete while CSV receipts exist.
- All three upload/checklist steps completed and tracking active.
- User clears receipts and returns to onboarding.
- Reset waits for an in-flight background sync or export upload, then leaves zero receipts and no eligible tracking state.
- Consent declined or revoked after connection.
- File-ready email detected but archive not yet downloaded.
