# Transactions and caches

## Mutation design

- Put cross-table invariants in a domain service, not a route.
- Own atomic work through `DatabaseTransactionRunner.withTransaction`; pass its narrow executor to transaction-aware repositories instead of exposing a raw pool/client to application code.
- Acquire locks before requesting the client when waiting may be long; avoid holding idle transactions.
- Release clients and external locks in nested `finally` blocks, including client-acquisition failures.
- Prefer resetting rows to database defaults by delete/reinsert or a canonical repository method when that matches foreign-key and audit requirements.
- Account for triggers, foreign keys, and check constraints before changing or deleting rows.

## Cache contract

List every derived resource before implementation:

- base and wrapped user summary;
- dashboard insights;
- receipt lists/details;
- import preferences/source coverage;
- Gmail/Outlook connection-health caches and the canonical import-preferences projection;
- any device or query cache owned by the app.

Invalidate server caches only after commit. A destructive client mutation should remove cached values immediately after success; ordinary updates may write authoritative responses and invalidate dependents.

Cache Redis is an optimization: reads degrade to misses and writes/invalidation may fail soft. Distributed locks and refresh-token consume/revocation are correctness boundaries and fail closed when unavailable. Keep these capabilities separate even when they share a Redis URL.

After initial Redis connection or reconnection, clear only SnackTrack projection-cache prefixes before enabling cache reads. Never clear BullMQ or refresh-token keys. Use per-process, per-key single flight around expensive projections so an outage or cold cache does not stampede PostgreSQL.

## Durable operation and outbox mutations

- Insert an accepted import operation and its dispatch outbox event in one transaction.
- State transitions, idempotency, active-job limits, cancellation, generation checks, and outbox suppression belong in the durable repository/service boundary.
- Queue publication marks the durable record queued only after BullMQ accepts it; failed publication remains retryable from the outbox.
- Administrative cancellation must exclude running and awaiting-upload work when that is the stated contract, suppress future dispatch atomically, and audit the mutation in the same transaction. Redis cleanup is best effort because recovered workers must still honor durable cancellation.

## Migrations

- Add ordered immutable files under `src/services/data/migrations/` and register them in the migration index.
- Never edit an applied migration: `MigrationRunner` records checksums and rejects drift.
- Support the documented fresh and representative existing schemas.
- Make constraint replacement transactional.
- Include every newly written enum/event value in fresh-table and migration constraints.
- Test the runner with a controlled database port and run fresh/legacy PostgreSQL integration cases when database verification is requested.
