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

- Self-service `DELETE /auth/delete-account` returns HTTP 202 with
  `{ "success": true, "status": "pending", "message": "..." }` only after a durable request commits.
  It does not wait for the import writer lock or claim the account has already been erased.
- `AccountDeletionRequestRepository` atomically marks the account as pending deletion, advances its
  import generation once, cancels active and queued import jobs (including upload intents), suppresses
  dispatch/notification outbox work, disables push devices, and removes outstanding mailbox authorizations.
  Repeated requests are idempotent. Import admission checks the account fence before idempotency lookup.
- Existing sessions and fresh sign-in/refresh attempts are rejected with `ACCOUNT_DELETION_PENDING`.
  Only the authenticated deletion retry route allows an otherwise-valid pending-deletion session.
- Mailbox workers check durable cancellation before acquisition, between batches, after extraction,
  and at checkpoint/finalization boundaries. Export workers check around download/extraction/parsing
  and before committing receipts. An in-flight call or write is allowed to unwind safely; cancellation
  never forcibly releases another worker's lock. Cancelled work is not retried or announced as complete.
- `AccountDeletionRequestService` is polled every five seconds by the worker and also by the scheduler.
  PostgreSQL owns the queue. Failed attempts remain pending with a ten-second retry delay and an error
  code, so API/worker restarts and Redis outages do not lose accepted requests. Finalization requires
  healthy lock infrastructure and a running worker or scheduler; there is no client timer or live-app dependency.
- The finalizer uses `AccountDeletionService` with a non-waiting lock attempt. Once the writer exits,
  it stops the Gmail watch and deletes verification codes and the user in one transaction. Foreign keys
  remove relational data and the pending request together. Existing object-deletion triggers retain
  staged object cleanup work after user deletion, including the signed-upload retention window.
- Administrator/debug deletion retains its synchronous contract and shares the same finalizer and lock.
- Connection-health and projection-cache invalidation remain best effort after commit. Refresh tokens
  cannot restore a pending or absent account; the durable request stores no token secrets.
- The app validates acceptance, cancels queries, clears account/device and authentication state, and
  signs out through the existing root route guard. It says deletion continues if the app closes.
  An uncertain network result is described as unconfirmed, not proof that deletion failed.

Deployment: apply migration 037 before deploying the API/worker, and deploy the updated worker with
its deletion poller. Pending requests are visible in `account_deletion_requests` (`requested_at`,
`next_attempt_at`, `attempts`, `last_error_code`); investigate growing age rather than clearing the fence.

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
| Self-service and administrator account deletion | `AccountDeletionRequestService` → `AccountDeletionService.deleteAccount` | Durable self-service cancellation; finalization and synchronous admin deletion share the writer lock |

There is no unlocked single-receipt or bulk-save repository method. A future manual receipt
mutation must be introduced as an application operation that acquires the same user-scoped lock and
uses a transaction-aware `ReceiptRepository` writer. The architecture check rejects receipt mutation
SQL anywhere except the canonical repository, the two documented destructive lifecycle adapters, and
versioned migrations.
