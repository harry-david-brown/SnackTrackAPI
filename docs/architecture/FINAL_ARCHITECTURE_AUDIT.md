# Final backend architecture audit

**Audited:** 2026-09-01  
**Scope:** SnackTrackAPI and every changed SnackTrackApp contract boundary  
**Reference:** `snacktrack-backend-architecture`, `snacktrack-backend-engineering`, `snacktrack-import-flow`, `snacktrack-account-data-lifecycle`, and the refactor plan's per-slice definition of done

## Result

The refactored API follows transport → application → domain/ports → adapters. Route factories receive narrow capabilities, application services do not import Express, PostgreSQL, Redis, provider SDKs, or concrete data adapters, and the composition root is the only process-wide object graph. CI enforces dependency direction, static cycle freedom, provider-neutral database ports, receipt-writer ownership, structured logging, build, lint, formatting, behavioral coverage, and tests.

All current HTTP inputs, JWT/provider payloads, cache values, CSV/extraction values, database rows, enum-like states, and database JSON read by the application are decoded at their boundary. Operational failures use one version-1 envelope with stable codes. The app validates changed responses once and maps those codes to retry, reconnect, re-authentication, busy, or terminal behavior without endpoint-message parsing.

Receipt mutations share the user-scoped ownership lock. Account deletion, onboarding reset, and receipt clearing have separate contracts and transaction policies. Cache invalidation and non-transactional effects occur only at documented post-commit boundaries. Gmail acquisition is now an adapter behind provider-neutral mailbox/message ports; extraction, deduplication, persistence, lifecycle state, and projections are independently replaceable.

## Evidence

- Route contracts and OpenAPI share canonical fixtures; matching frontend fixtures exercise valid and malformed responses.
- Application tests use deterministic clock, ID, cache, lock, and provider fakes and cover expected and unexpected failures.
- Repository and migration suites cover typed row decoding, JSON/state rejection, transaction behavior, schema creation, and representative legacy upgrades.
- Lifecycle suites cover lock ownership loss, rollback, account-data inventory, Gmail tracking/import states, and provider export replacement.
- `scripts/check-architecture.js` rejects dependency cycles, route SQL, application-to-data imports, application-to-cache-adapter imports, direct PostgreSQL driver leakage, duplicate process resources, and unauthorized receipt mutations.
- `scripts/check-core-coverage.js` requires named behavioral cases for every changed high-risk core module rather than treating a percentage as sufficient evidence.

## Intentional exceptions

1. `POST /csv/import`, multipart field `csvFile`, and the redundant multipart `userId` remain for released-client compatibility. Authenticated token identity is authoritative and ownership is checked. Removal is gated on a versioned provider-export endpoint rollout and the supported-client window recorded in `docs/API_CONTRACT_CATALOG.md`.
2. PostgreSQL integration tests require `MIGRATION_TEST_DATABASE_URL`. The final local gate ran all 177 API tests against isolated schemas with no skips. Environments without a configured database explicitly skip five integration scenarios rather than silently mocking them.
3. Live Gmail OAuth, Redis multi-process behavior, SMTP delivery, and physical-device navigation require deployment credentials or external systems. Automated contract, decoder, cache, lock, and failure-policy tests cover their local boundaries; the remaining live checks are listed in `docs/MANUAL_VERIFICATION.md`.

No other architecture exception or unexplained production `any` remains.
