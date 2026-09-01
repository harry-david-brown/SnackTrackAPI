# Account data lifecycle

This document is the authoritative inventory and behavioral contract for clearing receipts,
resetting onboarding/import state, and permanently deleting an account.

## Owned data inventory

| Data or side effect                                                              | Ownership and deletion mechanism                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users` identity, password hash, verification state, timezone, Gmail credentials | Root account row. Deleted only by account deletion; onboarding reset clears Gmail credentials but preserves identity.                                                                                   |
| `receipts`                                                                       | User-owned through `user_id ON DELETE CASCADE`. Explicitly removed by receipt clear and onboarding reset.                                                                                               |
| `oauth_accounts`                                                                 | User-owned through `user_id ON DELETE CASCADE`; removed with the account.                                                                                                                               |
| `user_import_preferences`                                                        | User-owned through `user_id ON DELETE CASCADE`. Receipt clear preserves consent but resets derived/import activity. Onboarding reset recreates fresh defaults.                                          |
| `user_export_provider_preferences`                                               | User-owned through `user_id ON DELETE CASCADE`. Receipt clear resets provider lifecycle; onboarding reset removes it.                                                                                   |
| `user_import_preference_events`                                                  | User-owned through `user_id ON DELETE CASCADE`. Preserved by receipt clear, removed by onboarding reset and account deletion.                                                                           |
| `gmail_sync_runs`                                                                | User-owned through `user_id ON DELETE CASCADE`. Removed by receipt clear, onboarding reset, and account deletion.                                                                                       |
| `verification_codes`                                                             | Keyed by email rather than `user_id`; account deletion removes them explicitly before deleting the user.                                                                                                |
| Redis/user projection caches                                                     | Invalidated after relational commit. Account-deletion cleanup is best effort because a committed deletion must still return success; user existence is checked before cached projections can be served. |
| Gmail connection-health memory                                                   | Invalidated after commit/reset or credential disconnection.                                                                                                                                             |
| Presented refresh token                                                          | Revoked after account-deletion commit when supplied. Revocation is idempotent/best effort and never changes the committed deletion result.                                                              |

Future user-owned tables must either reference `users(id) ON DELETE CASCADE` or be added to the
explicit account-deletion transaction and this inventory.

## Receipt clear

- Preserves the authenticated account, Gmail connection, and consent decisions.
- Deletes receipts and sync runs in one writer-locked transaction.
- Resets Gmail/export coverage, provider lifecycle, activity, and tracking status.
- A granted tracking consent cannot silently recreate data because scheduling additionally requires
  a completed Gmail or provider-export baseline; clear removes both baselines.
- A user may explicitly import or upload the source again.
- Cache invalidation is required before success. The operation is idempotent, so a cleanup failure can
  be retried without restoring deleted relational data.

## Onboarding reset

- Preserves account identity, password/OAuth login links, verification state, and timezone.
- Clears Gmail credentials, receipts, sync runs, import events, provider lifecycles, and preferences in
  one writer-locked transaction, then recreates fresh import-preference defaults.
- Invalidates connection health and all user projections after commit.
- Device onboarding, export handoff, pending-operation, receipt, analytics, Gmail, and preference state
  is removed by the app only after server success.
- The operation is idempotent and safe to retry when post-commit cache cleanup fails.

## Account deletion

- Is the only permanent deletion operation and is used by both self-service and administrator routes.
- Acquires the same user-scoped writer lock as every receipt writer.
- Deletes email-keyed verification codes and the root user row in one transaction; foreign keys cascade
  through every user-owned relational table.
- A repeated request after commit returns the same `{ "deleted": true }` result. This covers lost client
  responses and post-commit cleanup retries without treating an already-absent account as failure.
- Connection-health invalidation, cache invalidation, and refresh-token revocation are observable
  best-effort effects after commit. Failures are logged without turning a committed deletion into a
  misleading API failure.

## Concurrency and failure invariants

- Gmail import, ongoing tracking, CSV import, receipt clear, onboarding reset, account deletion, and
  administrator deletion share the user-scoped receipt-writer lock.
- Every acquisition has an ownership token; release is compare-and-delete and cannot release a newer
  owner's lease.
- Long writes renew and assert their lease before commit/batches. Lease loss rolls back transactional
  mutations.
- Bounded waits and cancellation return the documented busy/null result without releasing the current
  owner's lock.
- Relational failures roll back completely. Post-commit effects never run after a rollback.

## Receipt writer inventory

| Writer                                          | Canonical operation                                                               | Lock and stale-writer defense                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Historical Gmail import and ongoing tracking    | `ReceiptRepository.upsertEmailReceipts` through `ReceiptImportPersistenceService` | One user-scoped lock for the complete import; ownership asserted before each batch                  |
| Uber Eats and DoorDash exports                  | `ReceiptRepository.replaceProviderExport` through `CsvImportUseCase`              | One user-scoped lock for parsing, lifecycle transition, replacement transaction, and cache boundary |
| Receipt clear                                   | `ReceiptClearService.clearReceipts`                                               | Bounded lock acquisition and ownership assertion inside the transaction                             |
| Onboarding reset                                | `AccountResetService.resetForOnboarding`                                          | Bounded lock acquisition and ownership assertion before commit                                      |
| Self-service and administrator account deletion | `AccountDeletionService.deleteAccount`                                            | Both routes delegate to the same bounded, ownership-bearing operation                               |

There is no unlocked single-receipt or bulk-save repository method. A future manual receipt
mutation must be introduced as an application operation that acquires the same user-scoped lock and
uses a transaction-aware `ReceiptRepository` writer. The architecture check rejects receipt mutation
SQL anywhere except the canonical repository, the two documented destructive lifecycle adapters, and
versioned migrations.
