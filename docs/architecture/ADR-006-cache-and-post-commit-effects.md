# ADR 006: Cache and post-commit side effects

**Status:** Accepted

Effects are classified before implementation:

1. **Required before success:** provider token exchange/validation needed to establish a connection,
   lock ownership checks, and relational writes. Failure prevents success and, where applicable,
   rolls back the transaction.
2. **Post-commit effects:** user projection invalidation, connection-health invalidation, presented
   refresh-token revocation after account deletion, and observability. These run only after commit.
   Cache invalidation is awaited by ordinary mutations; account-deletion cleanup is best effort so a
   committed deletion is never reported as undone. Failures are structured and observable.
3. **Durable asynchronous effects:** none are currently required. A future effect that must eventually
   happen despite process loss must use a transactional outbox or durable job table with an idempotency
   key, attempt count, next-attempt time, terminal state, and operator visibility. An in-memory promise
   is not acceptable.

Retry and idempotency rules:

- Mailbox reads may be retried after provider retryable/throttling failures; stable source identity and
  upsert semantics make rereads safe. Rejected credentials transition to reconnect-required instead.
- Background tracking is single-user locked. A repeated run rereads a bounded cursor window and
  classifies records as new, updated, or unchanged.
- Provider export replacement is transactional and provider-scoped; a retry replaces the same source
  slice rather than appending duplicates.
- Receipt clear and onboarding reset are idempotent. Account deletion treats an already-absent account
  as committed success for lost-response retries.
- Cache invalidation and token revocation are idempotent. Logs include the operation, outcome, user,
  provider when relevant, and stable error code.

Tests assert commit-before-effect ordering, rollback suppression, lock release, duplicate-safe Gmail
upserts, provider-scoped export replacement, lifecycle failure transitions, and best-effort deletion
cleanup.
