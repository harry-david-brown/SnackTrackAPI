---
name: snacktrack-backend-engineering
description: Build and diagnose SnackTrack Express/PostgreSQL backend and worker changes with correct service ownership, transactions, migrations, Redis capability boundaries, cache invalidation, concurrency control, durable jobs/outbox, error contracts, and regression tests. Use for SnackTrackAPI routes, repositories, services, schema changes, destructive mutations, distributed locks, queues/background jobs, production data inconsistencies, or read-only diagnosis. Load snacktrack-import-flow as well for mailbox/export domains and snacktrack-account-data-lifecycle for resets or deletion.
---

# SnackTrack Backend Engineering

Make server mutations durable, race-safe, observable, and consistent with every cache and background writer.

## Required workflow

1. Load `snacktrack-backend-architecture` for module ownership, dependency direction, type design, contracts, and cleanup rules.
2. Use `snacktrack-codebase-navigation` to trace route → service → repository/database → cache → tests.
3. Identify the authoritative mutation owner and every concurrent writer before editing.
4. Read the relevant references:
   - transactions, services, and caches: [references/transactions-and-caches.md](references/transactions-and-caches.md)
   - locks, schedulers, and races: [references/concurrency.md](references/concurrency.md)
   - safe diagnosis and verification: [references/diagnostics-and-testing.md](references/diagnostics-and-testing.md)
5. Define the response/error contract and postcondition before implementation.
6. Implement the narrowest cohesive service operation. Keep routes responsible for authentication, validation, and response construction.
7. Add regression tests at the durable service/repository boundary and any affected route contract.
8. Run `npm run build` and `npm run lint`; also lint changed/staged tests with the local ESLint binary and `--max-warnings=0`. Fix lint errors and warnings before finishing and re-run affected checks. Do not run focused or full tests unless the user explicitly requests them.

## Core rules

- Use one transaction for mutations that must succeed or roll back together.
- Acquire coordination locks before opening a database transaction or external call; release them in `finally`.
- Every writer of the same resource must participate in the same lock protocol.
- Prefer ownership-token/fenced distributed locks; never let an expired owner delete a newer owner’s lock.
- Add immutable ordered migrations through `MigrationRunner`; preserve applied checksums and make each migration safe for its documented fresh/existing-schema inputs.
- Invalidate every derived cache only after durable writes commit.
- Treat PostgreSQL import jobs and their transactional outbox as the durable queue authority. Redis/BullMQ loss may delay publication or processing but must not lose an accepted operation.
- Keep cache Redis fail-soft, but make distributed-lock and refresh-token correctness capabilities fail closed with stable dependency errors.
- Preserve stable machine-readable error codes and distinguish conflict, validation, provider, and server failures.
- Use read-only, narrowly scoped SQL for diagnosis; never expose credentials or unrelated user data.
- Tests must verify postconditions, rollback/release behavior, cache invalidation, and realistic races—not only that queries were called.

## Expected handoff

Summarize ownership, transaction boundaries, lock participants, cache effects, error behavior, migrations, the TypeScript check result, and any user-requested verification.
