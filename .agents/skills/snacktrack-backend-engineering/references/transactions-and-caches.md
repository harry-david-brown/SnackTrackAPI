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
- Gmail connection-health cache and the canonical import-preferences projection;
- any device or query cache owned by the app.

Invalidate server caches only after commit. A destructive client mutation should remove cached values immediately after success; ordinary updates may write authoritative responses and invalidate dependents.

## Migrations

- Add ordered immutable files under `src/services/data/migrations/` and register them in the migration index.
- Never edit an applied migration: `MigrationRunner` records checksums and rejects drift.
- Support the documented fresh and representative existing schemas.
- Make constraint replacement transactional.
- Include every newly written enum/event value in fresh-table and migration constraints.
- Test the runner with a controlled database port and run fresh/legacy PostgreSQL integration cases when database verification is requested.
