---
name: snacktrack-account-data-lifecycle
description: Define and implement SnackTrack account-data retention, clearing, onboarding reset, fresh-account restoration, account deletion, privacy deletion, and source-data cleanup. Use when a request asks to reset onboarding or imported data, clear receipts or stats, disconnect providers as part of a reset, remove Gmail/Uber/DoorDash history, diagnose data that returned after deletion, or decide exactly what account identity and preferences must be preserved.
---

# SnackTrack Account Data Lifecycle

Treat destructive account-data operations as explicit product contracts, not collections of loosely related endpoint calls.

## Required workflow

1. Classify the requested operation using [references/reset-contracts.md](references/reset-contracts.md).
2. Build a preserve/delete matrix before editing. Resolve ambiguity with the user when it changes authentication, billing, or recoverability.
3. Read [references/atomic-reset-workflow.md](references/atomic-reset-workflow.md) before implementing a reset or deletion.
4. Read [references/diagnostics.md](references/diagnostics.md) when data survives, reappears, or UI state disagrees with PostgreSQL.
5. Load `snacktrack-import-flow` for Gmail, export, consent, tracking, or source-coverage semantics.
6. Load `snacktrack-backend-engineering` for API, PostgreSQL, locks, transactions, migrations, or cache invalidation.
7. Load `snacktrack-frontend-engineering` when the app initiates the operation or retains local/query state.
8. Add regression coverage for the durable transition, race behavior, and client cache cleanup.

## Core invariants

- “Reset onboarding,” “clear receipts,” “fresh account,” and “delete account” are different contracts until product intent explicitly makes them equivalent.
- A fresh-account reset normally preserves authentication identity and profile essentials while deleting all imported content and provider access.
- Disconnect credentials and revoke background permissions in the same server operation that clears imported data.
- Serialize the reset with every writer that could repopulate deleted data, including Gmail sync and export upload.
- Perform related database mutations in one transaction; invalidate API and app caches only after commit.
- Remove rather than merely invalidate client caches after destructive resets so stale data cannot remain renderable.
- Verify durable source rows, not only lifecycle booleans or success messages.
- Never claim a reset is complete if an in-flight writer can commit afterward.

## Expected handoff

Report the preserve/delete contract, authoritative server operation, concurrency protection, cache cleanup, verification performed, and any retained data that may surprise the user.
