---
name: snacktrack-backend-engineering
description: Build and diagnose SnackTrack Express/PostgreSQL backend changes with correct service ownership, transactions, migrations, cache invalidation, concurrency control, error contracts, and regression tests. Use for SnackTrackAPI routes, repositories, services, schema changes, destructive mutations, distributed locks, background jobs, production data inconsistencies, or read-only database diagnosis. Load snacktrack-import-flow as well for Gmail/export domains and snacktrack-account-data-lifecycle for resets or deletion.
---

# SnackTrack Backend Engineering

Make server mutations durable, race-safe, observable, and consistent with every cache and background writer.

## Required workflow

1. Use `snacktrack-codebase-navigation` to trace route → service → repository/database → cache → tests.
2. Identify the authoritative mutation owner and every concurrent writer before editing.
3. Read the relevant references:
   - transactions, services, and caches: [references/transactions-and-caches.md](references/transactions-and-caches.md)
   - locks, schedulers, and races: [references/concurrency.md](references/concurrency.md)
   - safe diagnosis and verification: [references/diagnostics-and-testing.md](references/diagnostics-and-testing.md)
4. Define the response/error contract and postcondition before implementation.
5. Implement the narrowest cohesive service operation. Keep routes responsible for authentication, validation, and response construction.
6. Add regression tests at the durable service/repository boundary and any affected route contract.
7. Run `npm run build` as the API TypeScript check. Do not run focused or full tests unless the user explicitly requests them.

## Core rules

- Use one transaction for mutations that must succeed or roll back together.
- Acquire coordination locks before opening a database transaction or external call; release them in `finally`.
- Every writer of the same resource must participate in the same lock protocol.
- Prefer ownership-token/fenced distributed locks; never let an expired owner delete a newer owner’s lock.
- Make startup migrations idempotent for both fresh and existing databases.
- Invalidate every derived cache only after durable writes commit.
- Preserve stable machine-readable error codes and distinguish conflict, validation, provider, and server failures.
- Use read-only, narrowly scoped SQL for diagnosis; never expose credentials or unrelated user data.
- Tests must verify postconditions, rollback/release behavior, cache invalidation, and realistic races—not only that queries were called.

## Expected handoff

Summarize ownership, transaction boundaries, lock participants, cache effects, error behavior, migrations, the TypeScript check result, and any user-requested verification.
