# Backend Architecture Refactor Plan

**Status:** In progress  
**Created:** 2026-08-31  
**Scope:** `SnackTrackAPI`  
**Reference:** `snacktrack-backend-architecture` and its companion backend, import-flow, and account-data-lifecycle guidance

## Purpose

Bring the API into compliance with the backend architecture rules without a high-risk, big-bang rewrite. The refactor should make feature ownership clear, deliberately improve API contracts where useful, coordinate all required frontend migrations, centralize dependency and resource lifecycles, make destructive operations and imports concurrency-safe, and create seams that support focused tests.

This plan is organized by risk and dependency order. A file move or smaller class is not considered progress by itself; each task must improve responsibility ownership, dependency direction, contract safety, or testability.

## Current baseline

- [x] Confirm TypeScript strict mode is enabled.
- [x] Confirm the current API compiles with `npm run build`.
- [x] Inventory the API structure and major dependency paths.
- [x] Audit high-risk import, reset, deletion, cache, transaction, and locking flows.
- [x] Inspect current tests and CI enforcement.
- [x] Record the principal compliance gaps below.

### Codebase snapshot

- 79 TypeScript modules and approximately 19,135 lines under `src`.
- The largest modules combine multiple responsibilities rather than merely containing a large amount of cohesive logic:
  - `src/routes/gmail.ts` — OAuth, import orchestration, preferences, consent, tracking, and response projection.
  - `src/services/analytics/WrappedAnalyticsService.ts` — queries, mapping, and analytics calculations.
  - `src/services/database/PostgresService.ts` — pool lifecycle, querying, schema creation, migrations, backfills, and health checks.
  - `src/routes/monitoring.ts` — HTTP handling, operational SQL, and query-plan parsing.
  - `src/services/import/CsvImportService.ts` and `GmailImportService.ts` — provider/parsing concerns, workflow orchestration, persistence, and lifecycle transitions.
- Four static dependency cycles are present:
  - `Email` ↔ `EmailFilterService`
  - `Email` ↔ `ReceiptParserService`
  - `EmailClient` ↔ `GmailClient`
  - `EmailClient` ↔ `OutlookClient`
- The automated Node test suite contains two large regression files. CI compiles the API but does not run `npm test`.

### Existing strengths to preserve

- Strict TypeScript compilation is already enabled.
- SQL is generally parameterized.
- Dashboard analytics contains several useful pure calculation modules.
- Import lifecycle states and user-facing import error codes already exist.
- Main Gmail and CSV entry points attempt to serialize receipt writes.
- Account reset already uses a transaction and `finally` cleanup.
- Central config, logging, repositories, and error middleware exist, although callers do not use them consistently.

## Compliance findings

### P0 — correctness and data-integrity risks

- `ImportLockService` releases locks with an unconditional delete. A process whose lock expired can delete a newer owner's lock. The lock has no ownership token, fencing value, or compare-and-delete release.
- Not every receipt writer uses the same user-scoped lock. Legacy refresh, clear/delete, account deletion, and administrator deletion paths can race with imports or tracking.
- `AuthService.deleteAccount` performs multi-table deletion without one transaction, does not clearly cover all user-owned records, and invalidates cache before deletion is guaranteed to commit.
- `/database/users/:id` implements a second, less complete account-deletion path with sequential route-owned deletes.
- `src/index.ts` and `ServiceContainer` create separate `PostgresService` instances. Shutdown therefore does not reliably own every pool created by the process.
- `CacheService` also has both container-managed and global instances, creating divergent resource and invalidation paths.

### P1 — boundary and ownership violations

- `ServiceContainer` is a global string-keyed service locator backed by `Map<string, any>`. Routes and middleware pull dependencies from it, and several modules bypass it by constructing their own dependency graphs.
- Application/domain services import error classes from HTTP middleware, reversing the intended dependency direction.
- Route modules contain business rules and direct SQL:
  - Gmail routes derive import state and source coverage and orchestrate multiple workflows.
  - User routes calculate summaries, persist timezone decisions, manage cache versions, and assemble dashboard insights.
  - Receipt routes build persistence filters and duplicate-count SQL; one catch block converts all failures to HTTP 500.
  - Database routes perform operational queries, N+1 user statistics, and destructive deletion.
  - Monitoring routes execute operational SQL and parse `EXPLAIN` results.
  - CSV routes own upload cleanup, locking, state transitions, writes, invalidation, and HTTP error construction.
- `GmailImportService` reaches through `ReceiptService` to its private database dependency using `as any`, exposing a missing repository/use-case boundary.
- `ReceiptService` duplicates repository behavior while also owning analytics and cross-domain destructive lifecycle work.
- `DatabaseService` contains a legacy clear-and-repopulate workflow. Its provider factory call uses `'gmail' as any` even though the factory contract expects title-cased provider names, indicating a hidden or dead broken path.
- `ImportPreferencesRepository` combines lifecycle commands, event/audit writes, sync-run persistence, row mapping, and read projections.
- `WrappedAnalyticsService` accepts a raw PostgreSQL pool and combines data access with extensive calculations.

### P1 — contract, error, and typing gaps

- `AppError` has an HTTP status but no stable machine-readable error code. Multiple routes return incompatible error envelopes.
- Route-level `try/catch` blocks frequently bypass the central error mapper.
- UUID validation is duplicated with different behavior.
- Request queries, JWT payloads, provider payloads, cached JSON, and database rows are often asserted rather than validated.
- `PostgresService.query(text, params?: any[]): Promise<any>` makes untyped database results the default.
- High-use modules contain concentrated `any` usage, particularly monitoring, receipts, database infrastructure, Gmail clients/imports, logging, and CSV imports.
- The `Receipt` model mutates a hidden identifier through `as any` and includes an HTTP response mapper, mixing persistence, domain, and transport concerns.
- List and count filtering in receipt pagination do not use exactly the same restaurant-name semantics, so reported totals can disagree with returned rows.
- `optionalAuthentication` silently treats token verification failures as anonymous access; this behavior is neither expressed as a policy nor observable.

### P2 — operations and maintainability gaps

- `PostgresService` contains pool management, query execution, health checks, schema bootstrapping, migrations, optimizations, and backfills in one class.
- Environment reads are scattered across bootstrap, auth, mail, Gmail, and other modules instead of passing through one validated configuration boundary.
- Console logging remains common in production paths and is mixed with structured logging.
- Debug email-file output is embedded in provider/import code instead of a config-gated, redacting debug adapter.
- Cache invalidation is often route-owned, cached JSON is not boundary-validated, and pattern deletion uses Redis `KEYS`, which can block Redis on a large keyspace.
- `OngoingTrackingService` uses only a per-process batch guard, creates an import service graph per user, and swallows a batch-level failure without sufficient structured context.
- Source-reading tests assert route implementation text, making internal cleanup fail tests even when behavior is unchanged.
- CI has no enforced lint command and does not run the automated test suite.

## Target architecture

Adopt these responsibilities incrementally in each feature slice. Do not reorganize the entire directory tree before extracting behavior.

```text
HTTP route/middleware
        ↓
application use case
        ↓
domain policy + dependency ports
        ↓
repository/provider/cache/queue adapters
```

- **Transport:** Parse and validate input, call one application operation, map its result or error to the documented HTTP contract.
- **Application:** Own workflow order, authorization decisions, transaction boundaries, lock acquisition, lifecycle transitions, and post-commit effects.
- **Domain:** Hold business vocabulary, invariants, state-transition rules, and pure calculations without Express, PostgreSQL, Redis, or provider SDK dependencies.
- **Ports:** Express the narrow capabilities a use case requires using typed interfaces owned beside the application/domain consumer.
- **Adapters:** Implement persistence, provider, cache, clock, ID, and telemetry ports. Validate untrusted data when it enters the system.
- **Composition root:** Construct one typed object graph at process startup and own startup/shutdown for every long-lived resource.

## Cross-stack contract migration policy

API and frontend changes are in scope. Existing contracts are evidence of current behavior, not a requirement to preserve awkward shapes indefinitely. Each changed contract must still be migrated deliberately so released app versions do not fail unpredictably.

- Prefer one normalized response envelope, stable machine-readable error codes, canonical enum/state casing, and explicit operation/result DTOs.
- Keep transport DTOs separate from frontend domain/view-state types. Normalize and runtime-validate responses in the app API service before exposing them to hooks or components.
- Change a contract by resource slice, not by scattered endpoints. Update the API schema, API implementation, app service/normalizer, state owner, UI recovery states, tests, and OpenAPI documentation as one tracked unit.
- Choose and document one rollout strategy for every breaking change:
  - deploy an additive API shape, migrate the app, then remove deprecated fields/endpoints after the supported-client window; or
  - release API and app atomically where deployment controls guarantee compatibility.
- Do not keep permanent dual behavior. Every compatibility field, adapter, endpoint, or state alias must have an owner and a removal checkbox.
- TanStack Query is the target frontend owner for ordinary server state. During migration, the selected resource has one authoritative cache; any compatibility adapter is one-way.
- Authentication identity remains owned by `UserContext`. Receipt, analytics, dashboard, Gmail status, and import preferences remain server state and should not be mirrored into context or AsyncStorage without a documented offline requirement.
- Destructive mutations must return an authoritative committed result. The app removes affected server and device caches only after success and retains the current state with a retry path on failure.

## Refactor execution plan

### Progress log

- 2026-08-31 — Completed the first data-integrity/foundation slice: transport-neutral coded errors, typed composition without string lookup, one PostgreSQL/cache owner, ownership-safe lock handles, transactional reset/clear/deletion use cases, coordinated frontend error-code parsing, and focused lifecycle regression coverage. API build and app type-check pass; test suites were not run per repository policy.
- 2026-08-31 — Added automatic lock renewal and ownership assertions before receipt batches and destructive transaction commits. Removed the unused uncoordinated refresh/repopulate endpoint and its writer. Added same-user, different-user, stale-owner, rollback, and lease-loss regression cases. API build and app type-check pass.
- 2026-08-31 — Migrated receipt listing to a typed application/repository slice with shared list/count predicates and token-owned identity; updated the app client/query hook. Consolidated Gmail receipt persistence into the canonical repository and removed private database reach-through. Removed the unused raw-email debug/lookup chain and all four known dependency cycles. Added CI architecture/test gates and focused receipt repository coverage. API build and app type-check pass.
- 2026-08-31 — Centralized all environment reads in typed `AppConfig` sections and migrated auth, provider, mail, Redis, security, logging, and bootstrap consumers. Added typed cache projection codecs that reject and evict invalid JSON, removed generic `any` cache results, replaced blocking Redis `KEYS` invalidation with cursor-based `SCAN`, and stopped logging cache keys. API build passes; regression tests were added but not run per repository policy.
- 2026-08-31 — Moved Gmail, receipt-extraction, identity-provider, repository, and import-service construction into the typed composition root. Long-lived application services now receive narrow dependencies and reuse the same process-scoped provider/repository instances; routes no longer instantiate providers or use cases. API build passes.
- 2026-08-31 — Extracted user-summary assembly into a typed application operation that owns timezone repair, monthly/top-restaurant calculations, wrapped fallback, and cache read/write/invalidation. The HTTP route now only maps input and response headers. Added focused aggregation/cache regression cases; API build passes and tests were not run per repository policy.
- 2026-08-31 — Extracted dashboard-edition and CSV-import application operations. Dashboard timezone/cache policy no longer lives in the route. CSV locking, lifecycle transitions, transactional write orchestration, failure state, and post-commit cache invalidation are now one operation, while multipart/temp-file handling stays at the transport boundary. Added focused operation tests; API build passes and tests were not run per repository policy.
- 2026-08-31 — Added recursive structured-log redaction before console, in-memory, and external transports, and removed credential/OTP/email-address logging from authentication, Gmail orchestration, and transactional email delivery paths. Added redaction coverage; API build passes and tests were not run per repository policy.
- 2026-08-31 — Added the versioned coded error-envelope builder and aligned OpenAPI, consolidated UUID/request validation at the HTTP boundary, and extracted wrapped-analytics SQL/row normalization behind a typed query repository. The calculation service no longer owns a raw PostgreSQL pool. API build passes.
- 2026-08-31 — Runtime-validated JWT claim shapes and credential failure modes, lowered expected operational failures to warning severity, and added per-user plus batch-level background tracking outcomes. Final checkpoint: API build, app type-check, and whitespace checks pass; test files were added but suites were not run per repository policy.
- 2026-08-31 — Recorded the current and target cross-stack contracts for every app-consumed endpoint in `docs/API_CONTRACT_CATALOG.md`, including authentication, request/success/error schemas, stable recovery codes, cache/state ownership, import/consent/tracking/export and destructive-operation semantics, rollout choices, and dated compatibility-removal gates.
- 2026-08-31 — Extracted Gmail connection/import-preference projection into a typed application service and moved receipt-backed source coverage behind a runtime-validating query adapter. Gmail routes now delegate status reads without raw SQL, DoorDash export coverage participates in the shared historical-baseline policy, and focused fake-port/adapter tests pass alongside the API build and architecture check.
- 2026-08-31 — Extracted monitoring consent, tracking consent, provider-export request/confirmation, and export-ready detection into a typed import-preferences application service. Preconditions now run before lifecycle writes, routes delegate to one operation, and focused tests cover missing baselines, provider unavailability, ordered success, ineligible checks, and detected export transitions.
- 2026-08-31 — Moved normalized Gmail/import contracts out of the transport client into the import-flow feature boundary and migrated all hooks, resolvers, UI, and tests off `gmailApi` type imports. Tightened the canonical preference normalizer, repaired stale transport fixtures, and fixed resolver precedence so receipt coverage outranks stale lifecycle state without hiding reconnect recovery. App type-check and 44 focused transport/hook/journey tests pass.
- 2026-08-31 — Completed the high-risk behavior characterization gate with onboarding-reset rollback/lock-release coverage and removed the remaining stale frontend journey fixtures. Full verification at this checkpoint: API 78 tests, build, architecture check, and whitespace check pass; app type-check, lint, whitespace check, and all 413 tests pass.
- 2026-08-31 — Extracted PostgreSQL `EXPLAIN (FORMAT JSON)` decoding from monitoring routes into a pure runtime-validating query-plan parser. All four diagnostics now share recursive index detection and typed timing/row fields; malformed plan coverage, API build, and architecture checks pass.
- 2026-08-31 — Completed the administrator/monitoring read-model slice: route-local SQL moved into runtime-validating query adapters and application operations, user statistics now use one paginated aggregate instead of per-user reads, all sensitive diagnostics require the API key, and administrator deletion continues through the authoritative account-deletion use case. Centralized shared query/UUID validation and removed the last route-SQL architecture exceptions. Full API verification passes with 88 tests, build, architecture, and whitespace checks.
- 2026-08-31 — Completed the PostgreSQL lifecycle/migration slice. `PostgresService` now owns only typed pool, query, scoped transaction, statistics, and idempotent close behavior; application modules depend on narrow database ports, while a dedicated health adapter owns readiness policy. Four immutable checksum-recorded migrations replace startup DDL/backfills under a PostgreSQL advisory lock, with a standalone release command and expand/backfill/contract guidance. Bootstrap owns migrations, Redis, monitoring timers, HTTP, PostgreSQL, Sentry, signals, and one-shot shutdown. Full combined verification passes with 105 API tests, including empty and representative legacy schemas on local PostgreSQL, plus build, architecture, and whitespace checks.
- 2026-08-31 — Split the combined import-preferences persistence adapter into lifecycle commands, append-only audit events, Gmail sync runs, and read-only query projections with one canonical lifecycle vocabulary. Preference reads no longer insert or self-heal database rows; receipt-backed completion is derived without mutation. Runtime row decoders now reject malformed import enums, timestamps, counts, provider values, and UUIDs. Full verification passes with 112 API tests, including DoorDash import and real PostgreSQL migration coverage, plus build, architecture, and whitespace checks.
- 2026-08-31 — Narrowed user-summary and dashboard application dependencies to only the user, receipt, analytics, and cache capabilities each operation consumes. Removed the unused pre-migration `DatabaseOptimizations` raw-pool class; versioned migrations and typed monitoring adapters remain the sole owners of its former schema and diagnostics responsibilities.
- 2026-08-31 — Extracted Gmail OAuth state, authorization URL, token exchange, scope validation, credential persistence, and disconnect lifecycle into a provider adapter plus application operation behind a focused route factory. Extracted historical Gmail preflight, writer locking, execution, failure mapping, structured outcomes, and unconditional lock release into its own use case. Focused tests cover invalid redirects/state/scopes, provider denial, durable credential persistence, consent reset, unavailable/busy imports, success, provider failure, and unexpected cleanup.
- 2026-08-31 — Made permanent account deletion retry-idempotent and made its post-commit cache, connection-health, and refresh-token cleanup explicitly best effort and observable, so a committed deletion cannot be reported as a failure. Added the complete relational/cache/provider inventory and distinct clear/reset/delete contracts in `docs/ACCOUNT_DATA_LIFECYCLE.md`, deterministic bounded-wait and cancellation ownership tests, and real PostgreSQL table-by-table tests for permanent deletion, source clear, and onboarding reset.
- 2026-08-31 — Added a narrow structured logger port and removed direct console output from Gmail acquisition/import and CSV parsing. Operational logs now use consistent user/operation/provider/outcome/count/duration/error-code fields without addresses, subjects, bodies, receipt samples, or provider identities. Replaced raw debug-email and rejected-receipt dumps with a disabled-by-default adapter that writes only recursively redacted operational summaries; architecture checks prevent console calls from returning.
- 2026-08-31 — Added strict ESLint and Prettier gates, documented exact temporary type-safety exceptions for the parallel provider-auth worktree, and made build, architecture, lint, format, tests, and the security audit blocking CI steps. Replaced remaining unsafe request/database boundary access outside that allowlist, made timezone detection framework-independent, and upgraded vulnerable direct/transitive dependencies until `npm audit --audit-level=moderate` reported zero findings. Full verification passes with all 130 API tests on local PostgreSQL (no skips), TypeScript build, lint, format, architecture, and whitespace checks.
- 2026-08-31 — Completed the version-1 operational-error transport boundary outside the parallel auth slice. The API now maps typed and unknown failures centrally, classifies database availability by stable driver codes rather than message text, and retains only the OAuth redirect recovery catch in routes. The app validates the complete envelope once, rejects malformed/status-mismatched or legacy payloads, and routes all secondary error helpers through the canonical parser. Added validated `X-Request-ID` correlation to response headers, envelopes, and structured request/error logs, plus explicit operation/import/provider/duration/outcome/error-code context fields and focused cross-stack tests.
- 2026-08-31 — Completed the CSV/export cross-stack slice. Unexpected parser/write failures now become the stable `EXPORT_IMPORT_FAILED` contract while validation failures retain their exact source-specific codes in lifecycle state. The app consumes one runtime-validated export result, uses one TanStack mutation as the pending authority, blocks duplicate submissions, waits for committed-success cache invalidation before presentation changes, and retains the selected file for visible retry. Removed the unsafe legacy AsyncStorage `File` retry queue and its stale pending banner. Full verification passes with all 135 API tests against local PostgreSQL (no skips), API build/architecture/lint/format gates, app type/lint/theme gates, and all 415 app tests.
- 2026-08-31 — Completed the receipt/dashboard cross-stack migration. `GET /receipts` now emits only canonical `items/pageInfo` from an HTTP mapper; token identity replaced the temporary query user, and snake-case, `_id`, `createdAt`, old pagination, and dashboard-barrel compatibility paths were removed. Receipt and wrapped-analytics database projections reject malformed JSON, enums, dates, amounts, aggregate counts, and percentile rows. Wrapped formulas now run in a pure calculator behind query orchestration. TanStack receipt keys include every filter, analytics/dashboard keys remain parameter-complete, and explicit loading/empty/refresh/error states retain committed data during background work. Full verification passes with 149 API tests against local PostgreSQL (no skips), all API architecture/build/lint/format gates, and all 424 app tests plus type/lint/theme gates.
- 2026-08-31 — Completed the Gmail/import cross-stack migration. The Gmail router is now a composition-only shell over OAuth, preference, tracking, and import route factories with injected HTTP policies. Historical acquisition, provider-neutral batch extraction, pure deduplication, lock-guarded persistence/cache invalidation, and durable lifecycle transitions are separate capabilities. Import preferences now include the canonical Gmail connection projection and are the app's sole query-cache authority for connection, consent, lifecycle, coverage, tracking baseline, and recovery state. Removed the aggregate export response, `gmailImport` aliases, the separate Gmail-status cache/query, optimistic import lifecycle overrides, duplicate import mutations, and fallback synthesis. Canonical import results are runtime-required at the frontend boundary. Full verification passes with 156 API tests against local PostgreSQL (no skips), API build/lint/architecture gates, and all 423 app tests plus type/lint gates.
- 2026-08-31 — Completed the authentication/account cross-stack slice. Removed the monolithic `AuthService` and global auth route/middleware service lookups in favor of injected credential, token/session, identity-provider, password-reset, and email-verification capabilities. JWT, provider, and request payloads are decoded at entry; refresh rotation and optional-auth policy expose stable absent/expired/malformed/revoked codes; verification-code consumption and its account mutation now share one transaction. The app normalizes one required session DTO, recognizes canonical auth/code failures without endpoint-message parsing, retains credentials during temporary refresh or failed deletion, and clears credentials, user-bound device state, and query state only after confirmed deletion. Focused API and app auth/session/account lifecycle tests pass with build, lint, type, and architecture gates.
- 2026-09-01 — Completed the hardening and final-audit milestone. Application services now depend on provider-neutral authentication, database, receipt, projection, import-lifecycle, mailbox, cache, and lock ports; CI rejects application-to-adapter imports and direct PostgreSQL-driver leakage. Removed the final legacy user endpoints and service-locator API, added shared API/OpenAPI and frontend contract fixtures, deterministic fakes, a behavioral core-coverage manifest, test responsibility mapping, and canonical OpenAPI schemas. The final audit and manual external-system checklist record the sole released-client CSV compatibility gate. Full verification passes with all 177 API tests against isolated local PostgreSQL schemas (no skips), API build/architecture/core-coverage/lint/format/security gates, and all 430 app tests plus theme/type/lint gates.

### Phase 0 — freeze behavior and establish safety rails

- [x] Create an API contract inventory for every frontend-consumed endpoint before changing implementations.
  - [x] Record method, path, authentication policy, request schema, success schema, error envelope, stable error codes, and relevant cache behavior.
  - [x] Explicitly record Gmail/import preference, consent, tracking, export-ready, reset, clear, and account-deletion semantics.
  - [x] Mark accidental inconsistencies that will require a versioned or coordinated frontend change instead of silently normalizing them.
- [x] Define the target contract catalog and migration decision for each affected resource.
  - [x] Select the canonical error envelope and stable codes consumed by the app API client.
  - [x] Select canonical pagination, mutation-result, import-lifecycle, connection-health, and destructive-operation DTOs.
  - [x] Map current frontend consumers in `services/api`, `gmailApi`, `authApi`, dashboard services, query hooks, contexts, feature resolvers, and device caches.
  - [x] Record whether each change is additive-first or an atomic API/app release.
  - [x] Add a dated removal task for every compatibility adapter or deprecated field.
- [x] Add behavior-level characterization tests around high-risk existing flows.
  - [x] Account reset success, rollback, and lock release.
  - [x] Account deletion success and rollback.
  - [x] Gmail and CSV import lifecycle transitions.
  - [x] Receipt list filters and matching pagination totals.
  - [x] User summary/dashboard response shape.
  - [x] Central error-envelope mapping.
- [x] Replace source-text assertions with route or use-case behavior assertions.
- [x] Add a lightweight dependency-cycle and forbidden-import check.
  - [x] Prevent application/domain modules from importing Express middleware.
  - [x] Prevent routes from importing database pools or executing SQL.
  - [x] Prevent new global service instances outside the composition root.
- [x] Update CI to run the real verification commands.
  - [x] Run `npm run build`.
  - [x] Run `npm test`.
  - [x] Add and enforce lint/format scripts once their initial configuration is committed.

**Phase gate:** Existing externally visible behavior is documented and protected well enough to refactor one slice at a time.

### Phase 1 — create shared architectural foundations

#### Errors and HTTP contracts

- [x] Move application error definitions out of `middleware/errorHandler.ts` into a transport-neutral core module.
  - [x] Define stable `code`, operational/public message, optional details, and `cause` fields.
  - [x] Keep HTTP status selection in an HTTP error mapper, not in domain policies where it is avoidable.
  - [x] Preserve existing stable import codes and frontend-recognized messages during migration.
- [x] Define one versioned error-envelope schema and route all operational errors through the central mapper.
- [x] Update the frontend API client to parse the canonical error envelope once.
  - [x] Preserve stable error codes through service normalizers and typed domain errors.
  - [x] Centralize session-expired handling while keeping validation, conflict/busy, reconnect-required, and retryable provider failures distinct.
  - [x] Remove endpoint-specific message parsing after all callers use error codes.
- [x] Replace broad route catches with typed propagation; retain local catches only for recovery, cleanup, enrichment, or expected fallbacks.
- [x] Consolidate UUID and common request validation into one boundary-validation layer.

#### Configuration and composition

- [x] Expand `AppConfig` into the only environment-reading boundary.
  - [x] Runtime-validate `NODE_ENV`, URLs, secrets, timeouts, feature flags, provider options, log levels, and tracking intervals.
  - [x] Pass narrow typed option objects to consumers instead of the entire config object.
- [x] Replace the string-keyed global service locator with a typed application dependency graph.
  - [x] Construct exactly one PostgreSQL pool owner.
  - [x] Construct exactly one Redis/cache resource owner per intended connection strategy.
  - [x] Construct repositories, providers, and use cases once unless a documented request scope is required.
  - [x] Inject route dependencies through route factories or a typed router context.
- [x] Make bootstrap the sole owner of resource startup, readiness, signal handling, and shutdown.
  - [x] Remove `process.exit` decisions from infrastructure adapters.
  - [x] Verify all pools, Redis connections, scheduled jobs, and monitoring resources close once.
- [x] Remove direct service construction from routes and from application services.

#### Logging and telemetry

- [x] Define a narrow structured logger port with typed context.
- [x] Standardize request ID, user ID, operation/import ID, provider, duration, outcome, and error-code fields.
- [x] Centralize redaction for tokens, cookies, email bodies, receipt payloads, and provider credentials.
- [x] Replace console calls in request, import, database, auth, email, and worker paths.
- [x] Make expected client failures lower severity than unexpected server failures.

**Phase gate:** New feature work can use typed dependencies, one error contract, validated config, and structured telemetry without importing transport or infrastructure details.

### Phase 2 — repair concurrency and account-data lifecycle ownership

Complete this phase before broad cleanup because later extractions must preserve these guarantees.

#### User-scoped writer lock

- [x] Replace boolean lock acquisition with an ownership-bearing lock handle.
  - [x] Generate a unique ownership token for every acquisition.
  - [x] Release with atomic compare-and-delete.
  - [x] Define lease duration, renewal/heartbeat behavior, bounded wait policy, and contention result.
  - [x] Add fencing or an equivalent stale-writer defense where a lease can expire during a database write.
  - [x] Make the single-process fallback explicit and impossible to mistake for cross-process safety.
- [x] Add deterministic concurrency tests.
  - [x] An expired owner cannot release a newer lock.
  - [x] Same-user writers serialize or return the documented busy result.
  - [x] Different-user writers can proceed concurrently.
  - [x] Exceptions and lease-loss paths release only the caller's lock.
  - [x] Cancellation and bounded-wait timeout paths release only the caller's lock.
- [x] Inventory and route every receipt writer through the same user-scoped policy.
  - [x] Gmail import and ongoing tracking.
  - [x] CSV/export import.
  - [x] Receipt clear/reset.
  - [x] Account deletion and administrator deletion.
  - [x] Remove the unused legacy refresh/repopulate workflow and endpoint.
  - [x] Future manual receipt mutations.

#### Account reset, clear, and deletion

- [x] Create one authoritative account-deletion use case.
  - [x] Maintain an explicit inventory of all user-owned tables, provider credentials, sync records, events, cached views, and external side effects.
  - [x] Acquire the user writer lock before destructive mutation.
  - [x] Execute relational deletion in one transaction in dependency-safe order.
  - [x] Roll back the entire relational operation on failure.
  - [x] Perform cache and connection-health invalidation only after commit.
  - [x] Define retry/idempotency behavior for external credential revocation or other non-transactional effects.
- [x] Make every deletion entry point delegate to the authoritative use case.
  - [x] Replace `AuthService.deleteAccount` orchestration.
  - [x] Replace or remove the duplicate `/database/users/:id` deletion implementation.
  - [x] Ensure administrator authorization remains a transport/application policy, not repository logic.
- [x] Separate and name the contracts for receipt clear, onboarding reset, and account deletion.
  - [x] Preserve account identity and intended preferences for reset/clear.
  - [x] Remove identity and all user-owned data for account deletion.
  - [x] Prevent previously cleared source data from silently reappearing unless the product contract permits it.
- [x] Update `AccountResetService` to use the new lock and post-commit effect policy.
- [x] Add table-by-table and source-by-source lifecycle regression tests.

**Phase gate:** Every destructive or additive receipt path has one concurrency policy, and reset/deletion is transactional, complete, and contract-tested.

### Phase 3 — establish typed persistence and migration boundaries

#### Database lifecycle and migrations

- [x] Split `PostgresService` responsibilities.
  - [x] A pool/transaction adapter owns connection lifecycle and typed query execution.
  - [x] A health adapter owns database readiness/health details.
  - [x] Versioned migration files own schema changes, indexes, constraints, and backfills.
  - [x] A migration runner records applied versions and fails safely.
- [x] Move startup schema mutation and optimization queries into ordered, reviewable migrations.
- [x] Define deployment and rollback guidance for expand/backfill/contract migrations.
- [x] Replace `Promise<any>` query results with typed row/result contracts.
- [x] Add migration tests for empty and representative existing schemas.

#### Repository ownership

- [x] Establish one canonical receipt persistence boundary.
  - [x] Merge overlapping `ReceiptRepository` and persistence portions of `ReceiptService`.
  - [x] Keep row mapping in the adapter and business calculations in pure domain/application modules.
  - [x] Remove database reach-through from `GmailImportService`.
  - [x] Make list and count queries share one filter object and identical predicates.
- [x] Replace hidden raw-pool dependencies with narrow repository/query ports.
  - [x] Wrapped analytics.
  - [x] User summaries and dashboard reads.
  - [x] Import source coverage and status reads.
  - [x] Monitoring and administrator diagnostics.
- [x] Split `ImportPreferencesRepository` by cohesive persistence responsibility while preserving one lifecycle vocabulary.
  - [x] Preference/lifecycle state commands.
  - [x] Import-event/audit persistence.
  - [x] Sync-run persistence.
  - [x] Read projection/query adapter.
- [x] Validate database JSON and enum-like values at the adapter boundary.
- [x] Define transaction-aware repository interfaces so a use case can pass one transaction context without exposing the raw pool.

**Phase gate:** Application code depends on typed persistence capabilities, migrations are explicit, and routes/services no longer reach into pools or another service's private database field.

### Phase 4 — extract application use cases feature by feature

Migrate one vertical slice at a time. For each slice, add/retain contract tests, introduce a use case and its ports, make the route thin, then remove superseded code.

#### Receipt and dashboard slice

- [x] Create a receipt-list use case with a validated filter/query contract and consistent list/count behavior.
- [x] Extract user summary, monthly breakdown, top-restaurant, and dashboard assembly from `routes/users.ts`.
- [x] Move timezone persistence decisions behind an explicit user-preference/application operation.
- [x] Move dashboard cache read/write/invalidation into the application operation or a decorator around it.
- [x] Keep analytics calculations pure and independent of Express and PostgreSQL.
- [x] Migrate the corresponding frontend resource boundaries.
  - [x] Update `services/api/receiptApi.ts`, `services/analyticsApi.ts`, `services/dashboardInsightsApi.ts`, and their transport validators for the target DTOs.
  - [x] Make `useReceiptsQuery` and analytics/dashboard query hooks the authoritative caches with complete parameterized query keys.
  - [x] Remove obsolete context, local cache, focus-refetch, or compatibility paths after all consumers move.
  - [x] Update loading, empty, background-refresh, error, and retry UI states and their behavior tests.

#### Gmail/import slice

- [x] Split Gmail HTTP concerns into focused route modules or handlers without changing endpoint contracts.
- [x] Extract cohesive use cases for:
  - [x] OAuth connect/callback/disconnect.
  - [x] Import-status and preference projection.
  - [x] Consent and tracking preference transitions.
  - [x] Historical Gmail import.
  - [x] Export-ready checking.
  - [x] Ongoing tracking batch execution.
- [x] Preserve one authoritative import state machine and stable frontend-recognized reason/error codes.
- [x] Make source coverage a typed query capability instead of route-owned SQL.
- [x] Split provider acquisition, message retrieval, parsing/extraction, deduplication, persistence, and lifecycle transition responsibilities.
- [x] Remove application-service construction from `GmailImportService`, `OngoingTrackingService`, and connection-health code.
- [x] Make batch-level and per-user tracking outcomes observable; do not swallow failures.
- [x] Migrate the frontend import-flow boundary with the API changes.
  - [x] Replace transport types imported directly from `gmailApi` throughout feature/UI code with normalized domain contracts exposed by the import-flow module.
  - [x] Update `gmailApi`, `gmailNormalizers`, `useImportPreferences`, `useGmailImport`, and `useImportFlowController` together.
  - [x] Make the import-preferences/status query the single server-state authority for lifecycle, consent, source coverage, and reconnect requirements.
  - [x] Update pure import-flow resolvers for loading, unconnected, consent-required, importing, partial, complete, reconnect-required, busy, retryable failure, and terminal failure states.
  - [x] Remove legacy state aliases, local success overrides, duplicated polling, and one-way compatibility adapters after rollout.
  - [x] Update import journey tests for Gmail connection, historical import, tracking, export-ready detection, and source disagreement during rollout.

#### CSV/export slice

- [x] Create a CSV import use case that owns lock, lifecycle transition, transaction/write orchestration, and post-commit invalidation.
- [x] Keep multipart parsing and temporary-file cleanup in transport/infrastructure adapters.
- [x] Keep CSV parsing/normalization pure where possible.
- [x] Standardize import failure mapping with Gmail while retaining source-specific details.
- [x] Update `services/api/csvApi.ts` and the export-upload controller/components to consume the canonical operation result and error codes.
- [x] Define one frontend pending operation state, prevent duplicate submissions for UX, and rely on the API lock/idempotency policy for correctness.
- [x] Update receipt, analytics, dashboard, import-preference, export handoff, and notification caches only after committed success.
- [x] Preserve selected-file/retry state after recoverable upload failures and remove deprecated upload response handling after rollout.

#### Authentication and account slice

- [x] Split `AuthService` into cohesive credential, token/session, provider-auth, and account-lifecycle capabilities.
- [x] Extract verification and password-reset workflows from route-level multi-service orchestration.
- [x] Runtime-validate JWT payloads and distinguish absent, expired, malformed, and revoked credentials.
- [x] Express optional-auth behavior as an explicit policy and log unexpected verification failures safely.
- [x] Migrate `authApi`, its normalizers, and `UserContext` to the target session/auth DTOs and canonical errors.
- [x] Keep authentication identity/token lifecycle in `UserContext`; do not move ordinary server resources into it during the refactor.
- [x] Update password-reset and verification controllers to use explicit pending, invalid/expired code, retry, and success states.
- [x] Update reset/clear/account-deletion frontend mutations as separate contracts.
  - [x] Reset/clear preserves the authenticated session, removes affected TanStack Query entries and user-bound device caches after server success, then returns to the fresh authenticated journey.
  - [x] Account deletion clears credentials and all user-bound local state only after the server confirms deletion, then returns to signed-out state.
  - [x] A failed or busy destructive operation retains current data and presents a retry path; it must not show partial success.
  - [x] Remove any client sequence of partial deletion calls in favor of one authoritative server operation.

#### Administrator and monitoring slice

- [x] Move database and monitoring SQL into typed administrator/operations query adapters.
- [x] Replace per-user N+1 administrator statistics with aggregate queries.
- [x] Extract a typed query-plan parser from the monitoring route.
- [x] Apply explicit administrator authorization to every sensitive operational endpoint.
- [x] Keep destructive administrator commands behind the same application lifecycle services as user-facing commands.

#### Analytics slice

- [x] Split `WrappedAnalyticsService` into a typed analytics query adapter and pure calculation/assembly services.
- [x] Reuse existing pure dashboard/shared analytics modules instead of duplicating formulas.
- [x] Add fixture-based formula tests at boundary dates, sparse data, mixed currencies/types, and timezone edges.

**Phase gate:** Routes validate and delegate to one application operation; use cases own workflows; adapters own I/O; domain calculations remain pure.

### Phase 5 — remove cycles and harden types at every boundary

- [x] Replace the `Email` static dependency graph with a provider-neutral data type and remove the unused legacy parsing chain.
- [x] Remove `EmailClient` ↔ provider-client cycles.
  - [x] Define the provider client interface in a provider-neutral module.
  - [x] Remove the unused provider factory; current provider adapters depend only on the neutral interface.
  - [x] Remove dynamic `require` and provider-name casts.
- [x] Redesign the receipt data model.
  - [x] Make persisted identifiers explicit and immutable.
  - [x] Separate database row, domain record, write command, and API response DTO types.
  - [x] Move `toApiResponse` behavior to a transport mapper.
- [x] Add runtime schemas for all untrusted boundaries.
  - [x] Route body, path, and query parameters.
  - [x] JWT claims.
  - [x] Provider payloads (Gmail is decoded now; a future Outlook adapter must implement the same mailbox/provider decoder contract).
  - [x] CSV rows and parsed receipt extraction results.
  - [x] Cached JSON.
  - [x] Database JSON columns and state values.
- [x] Remove `any`, unsafe assertions, and private-field reach-through from production code.
  - [x] Track remaining exceptions in a short allowlist with an owner and removal reason.
  - [x] Prefer `unknown` followed by validation at boundaries.
- [x] Make shared utilities framework-independent; pass header/timezone values rather than an Express request to timezone helpers.
- [x] Replace magic strings and provider/state casing variants with canonical domain types.
- [x] Re-run the dependency-cycle audit and remove all known cycles; CI now enforces the check.

**Phase gate:** No known static cycles remain, untrusted input is validated once at entry, and core application/domain code contains no unexplained `any` or framework/database types.

### Phase 6 — make cache and side effects explicit

- [x] Define typed cache interfaces for each cached projection instead of a generic `any` cache API.
- [x] Validate cached values before use and treat invalid entries as misses with safe telemetry.
- [x] Replace Redis `KEYS` deletion with versioned keys, a tracked key set, or cursor-based `SCAN` as appropriate.
- [x] Co-locate cache invalidation policy with the use case that commits the mutation.
- [x] Ensure cache writes and invalidations occur at documented transaction boundaries.
- [x] Remove the global `cacheService` export after all consumers use the composition root.
- [x] Move debug email capture behind a disabled-by-default, redacting debug adapter.
- [x] Classify non-transactional side effects.
  - [x] Synchronous effects required before success.
  - [x] Post-commit best-effort effects with observable retry.
  - [x] Durable asynchronous effects requiring an outbox/job mechanism.
- [x] Document and test retry/idempotency rules for provider calls and background operations.

**Phase gate:** Cache and external side effects are deliberate parts of application workflows, not incidental route or repository behavior.

### Phase 7 — complete verification and tooling coverage

- [x] Organize tests by responsibility rather than by large end-to-end fixture files.
  - [x] Pure domain/calculation unit tests.
  - [x] Application use-case tests with fake ports.
  - [x] Route contract tests.
  - [x] Repository integration tests against PostgreSQL.
  - [x] Migration tests.
  - [x] Lock/concurrency tests.
  - [x] Account lifecycle and import state-machine regression tests.
- [x] Add contract fixtures shared by route tests and Swagger/OpenAPI generation where practical.
- [x] Add matching frontend transport fixtures for every changed API resource.
  - [x] Verify valid responses normalize to frontend domain models.
  - [x] Verify malformed or unknown responses fail safely at the service boundary.
  - [x] Verify canonical error codes produce the intended retry, reconnect, re-authenticate, or terminal UI state.
- [x] Add cross-stack journey coverage for every breaking or additive-first contract migration.
- [x] Verify authorization-denied, validation, not-found, conflict/busy, provider failure, and unexpected failure paths.
- [x] Add deterministic clock, ID, lock, provider, and cache fakes.
- [x] Enforce coverage for new/changed core modules without using a percentage target as a substitute for behavioral cases.
- [x] Add ESLint rules for unsafe `any`, floating promises, unhandled async work, dependency direction, and forbidden console use.
- [x] Add formatting enforcement and remove warning-only CI steps.
- [x] Make `npm run build`, `npm test`, lint, and format checks required CI gates.

**Phase gate:** Every boundary and high-risk workflow has automated regression coverage, and CI prevents architectural backsliding.

### Phase 8 — remove superseded code and document the resulting design

- [x] Confirm callers, then remove the legacy `DatabaseService` refresh/repopulate path if it is unused; otherwise migrate it to the import use case and shared lock.
- [x] Remove duplicate repository/service methods and route-local SQL after their replacements ship.
- [x] Remove commented-out legacy implementations and obsolete compatibility casts.
- [x] Reduce `ServiceContainer` to the typed composition root, then remove the old service-locator API.
- [x] Update Swagger/OpenAPI schemas to match the protected request, response, and error contracts.
- [x] Remove deprecated API fields/endpoints and frontend compatibility normalizers whose rollout gates are satisfied; retain only the named released-client CSV gate.
- [x] Add concise architecture decision records for:
  - [x] Dependency direction and composition.
  - [x] Transaction and repository context.
  - [x] User-scoped receipt writer locking.
  - [x] Account reset/clear/deletion semantics.
  - [x] Import lifecycle ownership.
  - [x] Cache and post-commit side-effect policy.
- [x] Update API contributor guidance with a feature/change checklist and representative vertical slice.
- [x] Run a final architecture audit against the backend skill and record any intentional exceptions.

## Per-slice definition of done

Use this checklist for each migrated endpoint or workflow.

- [x] The route only authenticates/authorizes, validates, calls one application operation, and maps the result.
- [x] Business rules and workflow ordering are outside Express handlers.
- [x] Dependency direction is transport → application → domain/ports → adapters.
- [x] No application/domain import points to Express, middleware, PostgreSQL, Redis, or a provider SDK.
- [x] Database changes are transactional at the use-case boundary where atomicity is required.
- [x] Receipt writes use the shared user-scoped concurrency policy.
- [x] External input, database JSON, provider data, and cached data are runtime-validated.
- [x] Errors have stable codes and are mapped through the central HTTP envelope.
- [x] Logs are structured, correlated, and redacted.
- [x] Cache invalidation and external side effects occur at the documented commit boundary.
- [x] Public request/response behavior is preserved or changed through an explicit coordinated migration.
- [x] If the contract changed, the API DTO/OpenAPI schema and frontend service normalizer were updated together.
- [x] The frontend resource has one authoritative state owner and all affected query/device cache behavior is defined.
- [x] The frontend intentionally handles loading, empty, success, background refresh, failure, reconnect, busy, and retry states that apply to the slice.
- [x] Any temporary compatibility adapter has a named removal task and rollout gate.
- [x] Focused tests cover success, expected failure, unexpected failure, rollback/cleanup, and relevant concurrency behavior.
- [x] Build, tests, lint, and format checks pass.
- [x] Superseded code is removed in the same slice or tracked by a specific follow-up checkbox.

## Suggested milestone sequence

1. **Safety milestone:** Phase 0 plus the error/config/composition portions of Phase 1, including the target cross-stack contract catalog.
2. **Data-integrity milestone:** Phase 2 and the transaction/repository foundations needed from Phase 3.
3. **Import milestone:** Gmail, CSV, tracking, and import-preference portions of Phases 3–5, including the matching app services, hooks, resolvers, cache migration, and journey tests.
4. **Account milestone:** Auth, reset, clear, and deletion portions of Phases 2 and 4, including session, local-cache, and user-state transitions in the app.
5. **Read-model milestone:** Receipt lists, user dashboard, analytics, monitoring, and admin queries, including their frontend transport validators and query owners.
6. **Hardening milestone:** Phases 5–8, required CI gates, and removal of compatibility code.

Do not start multiple high-risk migrations at once. Complete a thin vertical slice—including tests and removal of the superseded path—before opening the next slice.
