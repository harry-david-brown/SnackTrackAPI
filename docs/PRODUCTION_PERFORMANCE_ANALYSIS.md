# SnackTrack Production Performance and Resilience Analysis

**Date:** 2026-09-02  
**Scope:** `SnackTrackAPI` and the production-relevant request patterns in `SnackTrackApp`  
**Method:** Static code and schema review, supported by successful API compilation and app type checking. No production telemetry, database `EXPLAIN` plans, mailbox-provider load tests, or end-to-end stress tests were available, so capacity numbers must be validated in a production-like environment.

## Implementation update — async imports

The import risks described in F-01, F-02, F-07, F-14, and F-16 now have a first production implementation. PostgreSQL owns durable operation and outbox state; Redis/BullMQ absorbs dispatch bursts; Railway can run the API, bounded workers, and hourly scheduler as separate services; direct CSV/ZIP uploads bypass API memory; resets supersede stale work with an account generation; and the app polls durable progress and can register for Expo completion notifications. Local development mirrors this with PostgreSQL, Redis, MinIO, API, worker, migrations, and an opt-in scheduler profile. See [ASYNC_IMPORT_OPERATIONS.md](./ASYNC_IMPORT_OPERATIONS.md).

The implementation deliberately caps mailbox history (20,000 messages, 1,000 provider pages, a 15-minute acquisition budget, and decoded-byte budgets), upload size (10 MiB CSV/50 MiB ZIP), selected ZIP output (25 MiB), declared archive expansion (250 MiB), CSV rows (100,000), CSV orders (25,000), worker concurrency, per-user starts, and global active work. Mailbox processing is page-streamed and cursor-checkpointed after durable writes. ZIP entries and CSV bytes remain file-streamed, and CSV parsing retains compact per-order aggregates instead of whole buffers or raw-row arrays. Provider-bound uploads, object ETag/length pinning, mailbox sender/DMARC checks, and content sanitization are described in [IMPORT_INPUT_SECURITY.md](./IMPORT_INPUT_SECURITY.md). Export parsing intentionally restarts from its durable object after a crash; its database replacement remains staged and atomic. The analytics, authentication CPU, cache/readiness, query-shape, and observability findings below remain separate work unless explicitly marked complete.

The detailed findings below describe the reviewed baseline and should be read together with this update; line references can move as implementation continues.

## Executive summary

SnackTrack has several sound foundations: database queries are parameterized, connection release is consistently protected, most user data is scoped by `user_id`, Redis-backed import locks prevent same-user overlap, receipt writes use transactions and deduplication constraints, list rendering is virtualized, and both server and client have basic caching and timeouts.

The largest production risk is nevertheless concentrated in a few paths that combine unbounded work with a single Node.js API process:

1. Gmail and Outlook historical imports run inside HTTP requests, retrieve and retain entire mailbox result sets, parse message bodies in-process, and can remain active for up to ten minutes.
2. CSV and ZIP imports repeatedly copy large buffers and retain all parsed rows, while the upload limiter permits up to 100 concurrent operations per API process.
3. Dashboard, summary, and Wrapped analytics repeatedly load a user's complete receipt history—including JSON item payloads—and aggregate it in application memory. Some screens request more than one of these expensive projections at once.
4. The production PostgreSQL pool is fixed at 20 connections, while individual endpoints issue several queries concurrently. A small number of requests can consume the whole pool and make unrelated endpoints, including health checks, wait.
5. Redis is simultaneously a performance dependency and a correctness dependency. If it is unavailable during startup, cache recovery is not retried, read traffic falls through to PostgreSQL, and production import locks fail closed.
6. Authentication performs expensive pure-JavaScript password hashing without an appropriately strict, distributed login limit, creating a straightforward event-loop exhaustion vector.
7. Ongoing tracking is an in-process, sequential scheduler. Every API replica selects the same oldest users, process-local coordination cannot prevent overlap, and capacity is effectively capped well below the needs of a growing user base.
8. Database migrations and data backfills execute during API startup under a blocking advisory lock. A slow migration can prevent every new replica from becoming ready during a deployment.

These are not isolated concerns. They can form a cascade: a cold or unavailable Redis instance causes cache misses; simultaneous app launches invoke multiple full-history analytics requests; the 20-connection database pool saturates; health queries wait; orchestration restarts instances; and startup migrations or Redis initialization delay recovery further.

The highest-value response is to move imports and maintenance into durable bounded workers, stream and cap imported data, replace full-history application aggregation with database-side or incrementally maintained projections, apply end-to-end admission control, and make dependency degradation explicit in readiness and telemetry.

## Severity and confidence

| Level | Meaning |
|---|---|
| Critical | A realistic request pattern, dependency failure, or modest malicious load could exhaust a shared resource or create a broad outage. Address before meaningful production scale. |
| High | Likely to cause severe latency, partial outage, or rapidly rising cost as traffic or user history grows. |
| Medium | Material degradation, operational fragility, or a hotspot that becomes high severity at larger scale. |
| Low | Efficiency or observability weakness with limited direct outage potential. |

“Confirmed” means the behavior is directly visible in code. “Expected” means the performance consequence follows from the implementation but should be quantified with telemetry or load tests.

## Architecture-level risk map

| Resource | Main consumers | Failure mode |
|---|---|---|
| Node.js event loop and heap | Mail parsing, CSV parsing, analytics loops, `bcryptjs`, large JSON serialization | Slow or failed health checks, request timeouts, process OOM/restart |
| PostgreSQL pool (20 connections in production) | Receipt lists, preferences, analytics, admin analytics, imports, health probes | Pool wait queue, cross-endpoint head-of-line blocking, readiness failures |
| PostgreSQL storage/WAL | Large transactional imports, analytics events, unbounded history tables, maintenance deletes | Write latency, replication lag, bloat, storage exhaustion |
| Redis | Response caches and distributed import locks | Cache stampede plus import/reset/delete unavailability |
| Gmail and Microsoft Graph | Historical imports, connection health, export-ready checks, ongoing tracking | Rate limits, long requests, retry amplification, provider-induced latency |
| API sockets and worker capacity | Synchronous ten-minute imports and delayed rate-limited requests | Connection exhaustion, deploy drain failures, load-balancer timeouts |
| Mobile client query cache | Search variants and retained infinite-query pages | Increasing client memory and redundant API traffic |

## Detailed findings

### F-01 — Historical mailbox imports are unbounded and fully materialized

**Severity:** Critical  
**Confidence:** Confirmed

Gmail history is paginated until `nextPageToken` is absent, with no overall message, page, byte, or duration limit. Message details and bodies are accumulated into a single `emailList`, then returned as one array (`src/integrations/gmail/GmailClient.ts:187-348`). The extractor creates a promise for every message and awaits the complete result array (`src/services/import/ReceiptEmailBatchExtractor.ts:31-45`). Its concurrency limiter bounds active parsing, but not the queued promises, retained message bodies, result objects, or final receipt arrays.

Microsoft Graph starts historical retrieval at 2009, accumulates all unique messages, and sorts the entire collection (`src/integrations/microsoft/MicrosoftGraphMailboxClient.ts:99-120`). Dense date windows are first completely fetched and then recursively split; both halves are fetched concurrently (`MicrosoftGraphMailboxClient.ts:153-205`). This can repeat provider work already performed for the parent window and create expanding parallelism without a global request budget.

The import result also includes the receipt collection (`src/services/import/GmailImportService.ts:228-254`), adding response serialization and client parsing to the retained server-side data.

**Production effect**

- A large or adversarial mailbox can consume hundreds of megabytes or more through raw bodies, parsed DOM/string data, arrays, deduplication maps, receipt objects, and JSON serialization.
- CPU-bound parsing runs on the same event loop that serves health and normal API traffic.
- Provider throttling and retries extend the period during which memory and sockets remain occupied.
- Multiple users importing at once multiply the cost; the per-user lock does not impose a process-wide or provider-wide ceiling.

**Recommendation**

- Convert import acquisition to a page/chunk pipeline: fetch a bounded page, parse it, persist idempotently, checkpoint the provider cursor, and release memory before the next page.
- Enforce explicit per-job limits for messages, compressed and uncompressed bytes, elapsed time, provider calls, and parsed receipts. Define a continuation state when a limit is reached.
- Add a shared concurrency budget per provider and per worker, plus a global memory-pressure circuit breaker.
- Return counts and an operation identifier, not the imported receipt payload.
- For Outlook, avoid fetching a complete parent window before deciding to split it, and put recursive work behind one global semaphore.

### F-02 — Long imports execute synchronously inside HTTP requests

**Severity:** Critical  
**Confidence:** Confirmed

The Gmail and Outlook routes increase the request socket timeout to 600 seconds and await the full import (`src/routes/gmailImport.ts:66-88`, `src/routes/outlook.ts:120-143`). This binds provider I/O, CPU parsing, database work, an HTTP socket, and process lifecycle together.

The Gmail app client times out after 300 seconds (`SnackTrackApp/services/gmailApi.ts:112-115`), while the server can continue for another five minutes. A client can therefore report failure and retry while the original server operation still consumes resources or owns the import lock. Server shutdown allows only ten seconds before forced termination (`src/index.ts`, shutdown path), far shorter than the maximum import duration.

**Production effect**

- Load balancers or mobile networks may terminate requests before the server does; disconnects do not cancel provider calls or database work.
- Deployments interrupt active imports and can leave confusing lifecycle records that need recovery.
- Client retries amplify load and produce lock conflicts without improving completion probability.
- Long-lived requests raise socket, proxy, and memory requirements and make autoscaling react too late.

**Recommendation**

Accept the request quickly with `202 Accepted` and a durable operation ID. A queue-backed worker should acquire a renewable lease, process bounded work, record progress, and support retry. Clients should poll or subscribe to a small status endpoint. Account reset/clear supersedes work through a generation fence; the approved first release has no user cancellation endpoint. Shutdown should stop accepting work, let workers checkpoint, and allow leases to be reclaimed safely.

### F-03 — CSV/ZIP ingestion can exhaust memory and event-loop capacity

**Severity:** Critical  
**Confidence:** Confirmed

CSV uploads allow files up to 50 MB on disk (`src/routes/csv.ts:15-50`). ZIP extraction permits 100 MB uncompressed content and collects chunks before `Buffer.concat`, temporarily retaining both the chunks and combined buffer (`src/services/import/ZipExtractor.ts:230-251`). The route then retains the extracted buffer (`src/routes/csv.ts:136-150`).

CSV processing repeatedly calls `toString()`, splits content during detection/validation, creates another stream from the string, and retains every parsed row before mapping and grouping (`src/services/import/CsvImportService.ts:101-104`, `159-250`, `621-632`). This multiplies peak memory beyond the nominal upload limit.

The upload concurrency middleware permits 100 simultaneous imports per process and maintains an unbounded FIFO wait queue (`src/middleware/concurrencyLimiter.ts`). A theoretical 100 × 100 MB uncompressed working set is already unsafe before string copies, parsed objects, receipt structures, or Node overhead are counted.

The global production request-size middleware is configured for 10 MB and relies on `Content-Length` (`src/middleware/security.ts:274-288`), while multipart handling advertises 50 MB. This creates inconsistent behavior: ordinary uploads declaring more than 10 MB may be rejected before the upload handler, while transfer modes without that header can reach the larger multer limit.

**Recommendation**

- Stream ZIP entry data directly into a streaming CSV parser; never construct the whole uncompressed file or all parsed rows in memory.
- Reduce import concurrency to a capacity-tested number, commonly low single digits per worker, and impose a small bounded queue with `429`/`503` plus `Retry-After` when full.
- Put parsing in dedicated workers or worker threads if it remains CPU-heavy.
- Reconcile edge, Express, and upload size limits and validate both compressed and uncompressed sizes.
- Monitor process RSS, heap, event-loop lag, queue depth, active parsers, decompression ratio, and rejection counts.

### F-04 — Redis failure can trigger a database surge and disable mutations

**Severity:** Critical  
**Confidence:** Confirmed

Redis defaults to enabled in production (`src/config/AppConfig.ts:256-260`). Initialization catches connection failure, disconnects, and clears the singleton client (`src/config/redis.ts:39-99`). No persistent application-level initialization retry is visible after a startup failure, so the process may operate without caching until restarted.

Read caches treat Redis failure as a miss and fall through to expensive PostgreSQL/application calculations. Distributed import locking deliberately fails closed in production when Redis is configured but unavailable (`src/services/import/ImportLockService.ts:49-69`). That protects correctness, but it means mailbox imports and lock-dependent reset/clear/delete operations become unavailable at the same time that read load increases.

**Production effect**

A transient Redis outage or bad startup ordering can create a persistent degraded process: analytics cache hit rate drops to zero, PostgreSQL and Node CPU rise, and important mutations return failures. If health checks do not explicitly reflect this state, traffic continues to be routed to the degraded instance.

**Recommendation**

- Continuously retry Redis initialization with bounded exponential backoff and expose cache/lock readiness separately.
- Consider separate Redis deployments or failure domains for correctness locks and expendable response caches.
- Decide explicitly which operations fail closed and expose a clear `503 dependency_unavailable` contract.
- Add a circuit breaker and single-flight protection so Redis recovery or loss cannot create a cache stampede.
- Alert on connection state, reconnect count, command errors, cache hit ratio, lock acquisition latency, and fall-through database volume.

### F-05 — Full-history analytics scale linearly with each user’s data

**Severity:** High  
**Confidence:** Confirmed

User summary fetches every receipt through a `SELECT *` repository method, including the `items` JSONB payload, and aggregates the collection in JavaScript (`src/services/analytics/GetUserSummaryService.ts:33-115`, `src/repositories/ReceiptRepository.ts:76-81`).

Wrapped analytics can load the same user's complete history a second time after summary has already loaded it (`GetUserSummaryService.ts:117-125`, `src/repositories/analytics/WrappedAnalyticsQueryRepository.ts:46-73`). Its calculator launches many promise-returning calculations (`src/services/analytics/WrappedAnalyticsService.ts:58-107`), but synchronous array scans still execute on one Node event loop. The percentile calculation aggregates and ranks all eligible users for an individual request (`WrappedAnalyticsQueryRepository.ts:76-100`).

Dashboard insights also load all receipts and evaluate a large catalogue of candidates through repeated filters, reductions, and sorts (`src/services/dashboard/GetDashboardInsightsService.ts:29-56`, `src/services/dashboard/edition.ts:79-113`, `src/services/dashboard/candidates.ts`).

Five-minute summary caching and daily dashboard caching reduce steady-state work, but there is no visible single-flight mechanism. Concurrent cold misses compute the same result independently.

**Production effect**

- Latency, heap, network transfer from PostgreSQL, and event-loop time grow with lifetime receipt count rather than the amount displayed.
- A popular launch, cache flush, Redis outage, or simultaneous expiry creates a thundering herd.
- Global percentile work becomes more expensive as both users and receipts grow.

**Recommendation**

- Project only required columns and move simple aggregates to SQL immediately.
- Maintain per-user daily/monthly rollups as receipts change; compute dashboards and Wrapped from rollups rather than raw lifetime rows.
- Precompute population percentiles on a schedule or maintain bucketed distributions.
- Pass one bounded receipt projection through calculations when raw data is genuinely required.
- Add request coalescing, stale-while-revalidate behavior, randomized TTL jitter, and versioned cache keys.

### F-06 — A small number of requests can saturate the PostgreSQL pool

**Severity:** High  
**Confidence:** Confirmed

The service container fixes the pool at 20 connections in production and 10 otherwise (`src/core/ServiceContainer.ts`, PostgreSQL construction). Pool connection and statement/query timeouts are 30 seconds (`src/services/data/PostgresService.ts`). The value is not deployment-configurable, and total database demand multiplies by the number of replicas.

Several endpoints deliberately fan out database work:

- Import preferences/status performs six operations in parallel before another weekly-count query (`src/services/import/ImportStatusService.ts:288-310`).
- Wrapped analytics launches multiple repository queries (`src/services/analytics/WrappedAnalyticsService.ts:904-910`).
- Receipt listing performs the page query and an exact count in parallel (`src/repositories/ReceiptRepository.ts:50-65`).
- Admin overview launches six analytics queries in parallel (`src/services/admin/AdminAnalyticsService.ts:152-181`).

Parallelism can reduce one request’s latency when spare capacity exists, but it allows a handful of requests to occupy all connections. Other requests then wait up to the connection timeout, causing head-of-line blocking. The client’s normal ten-second timeout is shorter than the database's 30-second budget, so abandoned requests can continue consuming database capacity.

**Recommendation**

- Make pool size configurable and budget it across replicas against the database's actual connection limit; use PgBouncer where appropriate.
- Put a concurrency/admission budget around expensive endpoints rather than allowing every request to fan out freely.
- Combine related queries, use conditional counts, and run low-priority/admin work on a replica or separate pool.
- Align client, edge, server, and database deadlines and propagate request cancellation to database/provider work.
- Alert on pool `waitingCount`, checkout latency, utilization, query timeouts, and per-route query count—not only query execution latency.

### F-07 — Authentication can be used to starve the Node.js event loop

**Severity:** High  
**Confidence:** Confirmed

Password hashing uses `bcryptjs` at cost 12 (`src/config/auth.ts:43-45`), and login compares passwords in the request path (`src/services/auth/CredentialAuthService.ts:52-57`). `bcryptjs` is CPU-intensive JavaScript. The login route has no dedicated strict limiter (`src/routes/auth.ts:79-85`). The general rate limit is 10,000 requests per five minutes per IP, registration permits 1,000 per five minutes, and the limit stores are process-local (`src/middleware/security.ts:60-74`).

OTP consumption performs a bcrypt comparison while holding a database transaction and row lock (`src/services/auth/OtpService.ts:194-275`), extending both connection and lock occupancy under load.

**Production effect**

A botnet, proxy rotation, or even a small number of clients can keep the single event loop busy with password checks. Because limits are per process, adding replicas increases the allowed aggregate attack rate. Normal requests and health probes become slow even before CPU is fully utilized.

**Recommendation**

- Add low, endpoint-specific distributed limits keyed by IP plus normalized account identifier, with progressive account-level backoff and safe enumeration-resistant responses.
- Bound concurrent password/OTP hashes and shed excess work before hashing.
- Prefer a native asynchronous password implementation or isolate hashing in worker threads after benchmarking.
- Minimize transaction duration around OTP verification while preserving one-time atomic consumption.
- Track hash queue time, event-loop lag, authentication rejection rate, and per-principal attempt velocity.

### F-08 — General rate limiting and backpressure are not production-distributed

**Severity:** High  
**Confidence:** Confirmed

The Express rate limiters use their default in-memory store; limits reset on restart and are enforced independently by every replica (`src/middleware/security.ts`). The general ceiling is permissive, and the defined email-operation limiter is not applied to the Gmail or Outlook import routes. Import locks prevent overlap for one user, but do not cap work across many accounts.

Progressive slowdown is also process-local and keeps delayed requests and timers alive. The CSV limiter has an unbounded wait queue. There is no general global admission control for mailbox operations, full-history analytics, authentication CPU, or database fan-out.

`trust proxy` is fixed to one hop in the server configuration. If the deployed proxy topology differs, address attribution—and therefore rate limiting—may be incorrect.

**Recommendation**

Use a Redis- or gateway-backed distributed limiter and explicitly configure trusted proxy networks/hop count for each environment. Define resource-class limits: cheap reads, authentication hashes, analytics, uploads, provider calls, and background work should have separate budgets. Prefer immediate bounded rejection over unbounded queuing or long delays.

### F-09 — Ongoing tracking does not scale safely across replicas

**Severity:** High  
**Confidence:** Confirmed

Each API process starts its own interval scheduler, normally hourly, and requests a batch of 100 users (`src/index.ts:379-404`, `src/config/AppConfig.ts:215-219`). The scheduler’s `batchRunning` flag is process-local, and selected users are processed sequentially (`src/services/import/OngoingTrackingService.ts:115-164`).

The repository selects eligible users but does not claim them atomically (`src/repositories/import/ImportPreferencesQueryRepository.ts:212-256`). Multiple replicas can choose the same oldest users and then contend on per-user distributed locks. This wastes a large part of every batch and can repeatedly starve later users. No purpose-built partial index for consent state plus last-attempt ordering is visible.

**Production effect**

- Theoretical capacity is at most 100 users per process per interval, and less if a sequential batch overruns the interval.
- More API replicas can create more duplicate selection rather than proportional throughput.
- Provider latency for one user delays everyone behind that user.
- Scheduler work competes with interactive requests for the same process, pool, Redis, and provider quotas.

**Recommendation**

Move tracking to a durable job system. Atomically claim eligible rows using leases or `FOR UPDATE SKIP LOCKED`, process with a small global/provider-specific concurrency limit, checkpoint progress, and retry with jitter. Add an index matching the eligibility predicate and ordering after validating with `EXPLAIN`. Monitor oldest eligible age, claim rate, completion rate, failure class, lock contention, and provider quota consumption.

### F-10 — Import status is too expensive for a frequently rendered preference endpoint

**Severity:** High  
**Confidence:** Confirmed

`getPreferences` concurrently resolves several pieces of state, including provider connection health, and then performs another weekly-count query (`src/services/import/ImportStatusService.ts:288-310`). Connection-health cache misses can call Gmail or Microsoft remotely. The app treats preferences as one-minute-stale state and mounts consumers globally.

Export-ready checking first reads provider/preferences state, later calls the full preference projection, may scan mailbox data, and then calls the full projection again (`src/services/import/ImportPreferencesService.ts:169-213`). Outlook readiness retrieves all matching emails since the requested date just to test whether any qualifies (`src/integrations/microsoft/MicrosoftGraphMailboxClient.ts:122-139`). The app’s notifier checks on a 15-minute cadence while active, and many clients can synchronize around launch/resume (`SnackTrackApp/components/ExportReadyNotifier.tsx:133-204`).

Additionally, the status service updates the user's timezone whenever the header is present, without first checking whether it changed (`ImportStatusService.ts:288-293`). The app sends `X-Timezone` on every API request (`SnackTrackApp/services/api/client.ts:162-167`), turning a read into a row update with WAL and lock cost.

**Recommendation**

- Make the interactive status endpoint a fast read of persisted state. Refresh remote provider health asynchronously and expose its age.
- Split stable preferences, recent import summary, and provider health so screens request only what they use.
- Make export-ready checks provider-side bounded existence queries and store the result; add randomized client jitter.
- Update timezone only when the value actually changes and avoid writes in read services.

### F-11 — Receipt pagination and search degrade with large histories

**Severity:** High  
**Confidence:** Confirmed

Receipt history uses offset pagination plus an exact `COUNT(*)` on every page (`src/repositories/ReceiptRepository.ts:50-65`). Deep offsets require PostgreSQL to find and discard preceding rows, while the count repeats work unrelated to rendering the next page. The allowed page size reaches 1,000 (`src/utils/pagination.ts:25-39`). List queries select complete receipt records, including item details that collapsed list rows do not need.

Restaurant search uses leading-wildcard `ILIKE '%term%'` (`ReceiptRepository.ts:321-335`), which an ordinary B-tree cannot accelerate. No trigram search index is visible.

On the app, search uses `useDeferredValue`, which changes render priority but is not a network debounce. Keystrokes can still generate separate queries (`SnackTrackApp/app/receipt-history.tsx` / `ReceiptHistoryScreen.tsx:43-54`). Infinite-query pages and filter variants remain in the TanStack Query cache for 30 minutes, and all loaded pages are flattened and regrouped for rendering (`ReceiptHistoryScreen.tsx:57-67`, `SnackTrackApp/services/queryClient.ts:15-20`).

**Recommendation**

- Use cursor/keyset pagination on `(receipt_date, id)` and return `hasMore`; calculate exact totals only when explicitly needed.
- Create a narrow list projection and fetch items for the detail view.
- Add a 250–400 ms search debounce and ensure superseded requests are cancelled.
- Validate a `pg_trgm` GIN/GiST index for restaurant substring search with realistic data and `EXPLAIN (ANALYZE, BUFFERS)`.
- Reduce maximum page size and bound retained pages/filter variants on the client.

### F-12 — Dashboard launch generates a concentrated burst of expensive work

**Severity:** High  
**Confidence:** Confirmed

The main dashboard mounts analytics summary, dashboard insights, and import-preferences queries together (`SnackTrackApp/app/(tabs)/index.tsx:38-58`). On cold server caches, summary and dashboard each load complete receipt history independently, while import preferences can fan out across database and mailbox-provider health checks.

App foregrounding also lets the background import controller start ongoing work when state is stale (`SnackTrackApp/components/ImportBackgroundController.tsx:39-50`). Query retry behavior retries most non-auth failures once (`SnackTrackApp/services/queryClient.ts:14-21`). A morning traffic peak, push-notification campaign, deploy, or Redis flush can therefore combine foreground reads, provider checks, and mailbox sync work.

**Recommendation**

Provide one lightweight dashboard bootstrap projection backed by rollups, prioritize visible data, defer non-visible health/import work, jitter background refreshes, and suppress retries for overload/timeout responses. Prewarm or stale-serve high-value caches during deploys.

### F-13 — Cache invalidation scans the Redis keyspace and caches can stampede

**Severity:** Medium–High  
**Confidence:** Confirmed

User cache invalidation performs several sequential pattern scans (`src/services/cache/CacheService.ts:84-102`, `src/config/redis.ts:252-266`). Although keys are user-specific, `SCAN` still walks the global keyspace. Receipt mutations can therefore create Redis work proportional to total cache size. Deletion uses regular `DEL`, which may block Redis briefly for large values.

Cache consumers do not visibly coalesce concurrent misses. Five-minute summary expirations can align, and daily dashboard keys can cluster around midnight. There are no reliable cache hit/miss counters in the exposed cache statistics.

**Recommendation**

Use per-user cache version tokens or maintain explicit key sets so invalidation is O(number of that user's entries), use non-blocking `UNLINK` where appropriate, add TTL jitter, and implement single-flight/stale-while-revalidate. Measure hit/miss/error rates and compute avoided backend work, not just key counts.

### F-14 — Provider health caches leak entries and do not coordinate replicas

**Severity:** Medium  
**Confidence:** Confirmed

Gmail and Microsoft connection-health services store per-user entries in process-local `Map` objects (`src/services/import/GmailConnectionHealthService.ts:14-45`, `src/services/import/MicrosoftMailboxConnectionHealthService.ts:22-65`). Expired entries are not proactively evicted; they remain until that exact user is checked or invalidated. A process that encounters many distinct users can retain the keys indefinitely.

Every replica has a different cache, so cold starts and horizontal scaling multiply provider validation calls and can expose inconsistent health results.

**Recommendation**

Use an LRU cache with maximum entries and expiry eviction, or a shared short-lived cache with single-flight validation. Track validation latency, provider errors, cache size, and hit rate.

### F-15 — Analytics event ingestion performs one database round trip per event

**Severity:** Medium–High  
**Confidence:** Confirmed

The API accepts up to 50 analytics events but loops and awaits an insert for every event (`src/services/admin/AdminAnalyticsService.ts:68-97`). The route returns `202` only after those writes finish (`src/routes/analyticsEvents.ts:13-19`). Since the database abstraction checks out a connection for each query, one mobile flush can create 50 sequential pool acquisitions and round trips.

The app flushes on authentication, foreground, and connectivity recovery. Fleet-wide reconnects can create a synchronized write burst.

**Recommendation**

Validate the batch once and write it with one multi-row insert, `unnest`, or `COPY` transaction. Cap payload bytes as well as event count, apply queue/backpressure semantics, and decouple analytics loss or delay from user-facing APIs.

### F-16 — Admin analytics can monopolize database capacity

**Severity:** Medium–High  
**Confidence:** Confirmed

Admin overview launches six queries concurrently (`src/services/admin/AdminAnalyticsService.ts:152-181`). Retention analysis scans session events broadly and uses repeated correlated existence checks for cohort users (`AdminAnalyticsService.ts:240-255`). These endpoints do not show an application cache and share the interactive database pool.

The schema includes rollup tables, but important queries still read raw event history. As the event table grows, one admin refresh can consume several connections and significant I/O, affecting customer endpoints.

**Recommendation**

Serve admin reporting from scheduled rollups and cache results. Use a read replica or separately capped pool, restrict query ranges, and limit admin concurrency. Confirm every query with production-scale plans and buffer statistics.

### F-17 — Startup migrations can block an entire deployment

**Severity:** High  
**Confidence:** Confirmed

The API runs migrations before it begins listening (`src/index.ts`, server startup). The migration runner takes a blocking PostgreSQL advisory lock with no visible lock timeout; every starting replica can wait behind the migration holder (`src/database/MigrationRunner.ts:82-137`). Each migration runs in a single transaction (`MigrationRunner.ts:139-163`).

Existing migrations include table updates, deduplication, type changes, index/trigger creation, and analytics backfills (`src/database/migrations/004_add_gmail_import_enhancements.sql`, `011_analytics_events_and_admin_extensions.sql`). On a large production dataset these operations can be slow, lock-heavy, or exceed statement timeouts.

**Production effect**

A rolling deploy with an unapplied migration can leave new replicas unready. If old replicas are terminated too early, this becomes a full outage. A failed large transactional migration can also repeat work on the next start.

**Recommendation**

Run migrations as a separate, observable release job before shifting application traffic. Use expand/backfill/contract releases, chunk large backfills, create indexes concurrently where valid, set lock timeouts, and make destructive/type-changing steps independently reversible. Application startup should verify schema compatibility rather than perform unbounded migration work.

### F-18 — Retention and maintenance work can create lock, WAL, and bloat spikes

**Severity:** Medium–High  
**Confidence:** Confirmed

Analytics maintenance runs immediately and periodically in API processes. An advisory transaction lock prevents duplicate execution, but the winner performs several delete/rebuild operations in one transaction (`src/services/admin/AnalyticsMaintenanceService.ts:10-51`). Large unbatched deletes retain dead tuples until vacuum, generate WAL, hold a pool connection, and can increase replica lag. Timer errors are swallowed at the caller, reducing operational visibility.

Several append-oriented tables do not appear in the cleanup policy, including Gmail/mailbox synchronization histories and preference events. Expired verification-code cleanup exists but no periodic invocation was found. These tables can grow indefinitely and increase index, vacuum, backup, and storage costs.

**Recommendation**

Move maintenance to one external scheduled worker, delete in small indexed batches, consider time partitioning, and monitor rows deleted, runtime, WAL, replication lag, dead tuples, and failures. Define explicit retention for sync runs, preference events, verification codes, audit data, and raw analytics.

### F-19 — Large imports hold long database transactions

**Severity:** Medium–High  
**Confidence:** Confirmed

Receipt replacement and upsert operations process batches inside encompassing transactions (`src/repositories/ReceiptRepository.ts:93-101`, `166-215`, `239-276`). This preserves atomicity, but a very large import holds a connection and transaction snapshot through many sequential statements. Delete-and-reinsert replacement can generate substantial WAL and transient index work.

**Recommendation**

Benchmark maximum transaction duration and WAL volume. For large imports, load into a staging table using bulk insertion, validate, and merge/swap with a short final transaction. Preserve idempotency and user isolation, and cap batch/job size.

### F-20 — External identity and email dependencies can hold auth requests open

**Severity:** Medium  
**Confidence:** Confirmed for synchronous dependency; timeout behavior requires runtime validation

SendGrid/SMTP delivery is awaited in registration, verification, and password-reset flows (`src/services/email/EmailSender.ts:106-157`). No explicit application deadline, circuit breaker, or bulkhead is visible in that service. Provider slowness can therefore consume request and connection capacity and turn an email outage into an authentication outage.

Microsoft JWKS uses a bounded fetch timeout, but concurrent cache misses or key rotations can initiate redundant fetches because no single-flight coordination is visible (`src/services/auth/MicrosoftJwksClient.ts:56-85`). Google/mailbox client calls need an explicit whole-operation deadline even where individual SDK calls may provide defaults.

**Recommendation**

Queue transactional email with an outbox and return after durable enqueue. Apply strict per-call and whole-operation deadlines, limited retries with jitter, circuit breakers, and dependency-specific concurrency pools. Coalesce JWKS refreshes and serve cached valid keys through transient failures.

### F-21 — Timeout budgets are inconsistent and cancellation is not propagated

**Severity:** Medium–High  
**Confidence:** Confirmed

Normal app requests time out around ten seconds, Gmail import at five minutes, mailbox routes at ten minutes, and database queries/connections at 30 seconds. The server-side mailbox socket timeout is ten minutes. There is no visible end-to-end cancellation path from an aborted mobile request through Express to PostgreSQL and provider clients.

**Production effect**

The client can retry while the original server and database work continues. Under overload this creates “retry storms”: visible failures rise while backend utilization continues to increase.

**Recommendation**

Establish route-class latency budgets, make upstream timeouts longer than downstream budgets by a small margin, propagate `AbortSignal`/cancellation, stop retries on overload responses, and return `Retry-After`. Long work belongs in jobs rather than enlarged HTTP timeouts.

### F-22 — Health checks and observability can miss the leading indicators of outage

**Severity:** Medium  
**Confidence:** Confirmed

The dependency health endpoint performs a database query, while the root endpoint is cheap. If infrastructure uses the database-dependent endpoint as liveness, a saturated pool can trigger restarts and worsen the incident. Each replica's alerting loop also queries the database every 30 seconds.

Metrics are process-local and keep only a bounded latency sample. Important leading indicators are absent or not wired consistently: event-loop delay, RSS/heap, pool checkout wait, Redis hit ratio, external-provider latency, active/queued import work, oldest tracking job, request cancellations, per-route saturation, and database latency recording. Alert evaluation can repeatedly emit the same condition without an obvious cooldown.

**Recommendation**

- Use a cheap process-only endpoint for liveness and a dependency-aware endpoint for readiness.
- Export cumulative metrics to an external system with route labels and histograms.
- Add event-loop lag, heap/RSS, GC pause, pool waiters/checkout time, queue depth, cache result, provider status/latency, import bytes/messages/duration, and scheduler lag.
- Add alert deduplication and include saturation/error-budget signals, not only average latency and current errors.

### F-23 — Query/index gaps will grow into database hotspots

**Severity:** Medium–High  
**Confidence:** Expected from query shapes; verify with production-scale plans

Likely gaps include:

- Ongoing tracking selection by consent state and oldest `last_check_attempt_at` lacks an index shaped to its eligibility predicate and ordering.
- Leading-wildcard restaurant search lacks trigram support.
- Retention/cohort analytics need composite indexes aligned with `event_name`, `user_id`, and `occurred_at`, or preferably rollups/partitions that avoid raw scans.
- Migration backfill checks JSON properties such as `properties->>'runId'` without a visible supporting expression index.

Indexes are not free: each one increases import/write cost and storage. Add only after capturing `EXPLAIN (ANALYZE, BUFFERS)` on production-like distributions. Candidate directions include a partial tracking eligibility index and a `pg_trgm` restaurant-name index.

### F-24 — Response sizes and serialization are larger than necessary

**Severity:** Medium  
**Confidence:** Confirmed

Receipt list and analytics queries select full rows with item JSON when many consumers need only summaries. Mailbox import responses can include imported receipts. Maximum list pages reach 1,000 records. Large response objects increase PostgreSQL transfer, Node heap, JSON serialization time, bandwidth, mobile parsing time, and query-cache memory.

No application compression middleware was identified; compression may exist at the reverse proxy and must be verified rather than assumed.

**Recommendation**

Define narrow response DTOs, cap list sizes, remove imported receipt bodies from job results, and measure serialized bytes by route. Confirm Brotli/gzip at the edge for suitable JSON while avoiding compression of already-compressed uploads.

### F-25 — Frontend query retention and search behavior can increase device cost

**Severity:** Medium  
**Confidence:** Confirmed

The query client retains inactive data for 30 minutes. Receipt search creates a distinct key per filter and infinite queries retain all fetched pages. Flattening and date-section grouping rebuild derived arrays as pages or filters change. This is acceptable for modest histories but can increase memory, JavaScript work, and API traffic for power users.

The client-side API limiter is useful for accidental bursts but is device-local and cannot protect the backend from fleet traffic or malicious callers.

**Recommendation**

Debounce server search, cap stored infinite pages, use narrow list rows, profile low-memory devices with large histories, and keep all authoritative throttling on the server/gateway.

### F-26 — Background work competes directly with customer traffic

**Severity:** High  
**Confidence:** Confirmed

Mailbox tracking, analytics maintenance, health polling, and interactive API handling run in the same application processes and share the same database pool. Work is not assigned priorities. A slow provider batch or maintenance delete can consume capacity needed by login, receipt history, or health checks.

**Recommendation**

Separate API, import worker, scheduler, and maintenance roles. Give each its own concurrency and database pool budget. Autoscale on queue age and saturation rather than only request CPU. Ensure low-priority work pauses when database or provider health crosses a threshold.

### F-27 — Process-local coordination becomes inaccurate under horizontal scaling

**Severity:** Medium–High  
**Confidence:** Confirmed

Several mechanisms are local to one Node process: general rate limits, progressive slowdown, provider-health caches, monitoring samples, scheduler `batchRunning`, and certain retry/cache states. Behavior therefore changes with replica count and restarts. Some limits become more permissive, provider calls multiply, and dashboards show only a fragment of fleet state.

**Recommendation**

Classify coordination by required scope. Keep only harmless micro-caches process-local; move abuse limits, job claims, distributed state, and operational metrics to shared/durable systems. Include replica identity in telemetry.

## Most credible production incident scenarios

### 1. Large-mailbox memory and latency collapse

Several users start historical imports. Each process retains thousands of complete HTML bodies, parsing promises, extracted results, and final receipt arrays. Event-loop lag rises, health probes time out, and orchestration restarts the process after only a ten-second drain. Clients have already timed out and retry against other replicas, repeating the work.

**Controls needed:** asynchronous jobs, paging/checkpoints, global provider concurrency, memory limits, generation-based supersession, queue admission, event-loop/RSS alerts.

### 2. Redis outage becomes a database outage

Redis is unavailable during a deploy. New processes never restore cache service, while import locks fail closed. Dashboard requests miss all caches and each starts multiple full-history calculations. PostgreSQL's 20 connections fill, the database health endpoint waits, readiness falls, and capacity shrinks just as load rises.

**Controls needed:** Redis recovery/readiness, stale cache strategy, single-flight, database admission control, cheap liveness, precomputed analytics.

### 3. Authentication CPU denial of service

An attacker distributes login attempts across addresses. Each accepted attempt performs cost-12 JavaScript bcrypt work. Per-process in-memory limits allow the aggregate rate to rise with replicas. The event loop becomes unavailable to all routes even though database and Redis utilization initially appear normal.

**Controls needed:** distributed account/IP limits, hash concurrency queue, native/worker hashing, event-loop alerts, gateway protection.

### 4. Large CSV upload fan-out

Many legitimate or malicious uploads pass admission at once. ZIP content expands to 100 MB, buffers are copied to strings and arrays, and as many as 100 operations are active per process. Heap/RSS exceeds container limits or GC pauses dominate. Repeated restarts lose in-flight work and trigger retries.

**Controls needed:** streaming pipeline, low concurrency, bounded queue, decompression budget, isolated workers, upload-edge enforcement.

### 5. Deployment blocked by schema work

New replicas start together with a pending migration. One performs a long backfill or index operation while all others block on the advisory lock and never listen. Old replicas are drained by the platform. The release becomes an outage, and rollback cannot help if both versions expect incompatible schemas.

**Controls needed:** release-phase migrations, expand/contract compatibility, lock timeout, chunked backfill, readiness/deploy gates.

### 6. Tracking backlog and provider throttling

As the user base grows, hourly sequential batches cannot keep up. Multiple replicas repeatedly select the same oldest users and contend on locks. Provider calls retry and consume quotas while later users are never reached. App foreground controllers add more sync requests during peak usage.

**Controls needed:** durable claims, fair queue, bounded parallelism, quota-aware scheduling, jitter, backlog-age SLO.

## Prioritized remediation plan

### Phase 0 — Measure and install safety rails

Complete before optimizing algorithms, because these controls make failures visible and bounded.

1. Add dashboards and alerts for event-loop lag, RSS/heap, GC, pool waiters and checkout time, Redis state/hits, request cancellations, provider latency/rate limits, import queue depth, import size/duration, and oldest tracking age.
2. Separate liveness from readiness and verify the deployment uses them correctly.
3. Add distributed endpoint-class rate limits and bounded concurrency. Start especially low for authentication, mailbox imports, CSV parsing, admin analytics, and Wrapped analytics.
4. Align deadlines and return overload responses with `Retry-After`; disable automatic retries for overload and non-idempotent operations.
5. Reconcile upload limits at CDN/load balancer, Express, multer, ZIP, and parser layers.

### Phase 1 — Remove the immediate exhaustion paths

1. Move Gmail, Outlook, CSV, and ongoing-tracking work into durable workers with operation records, leases, progress, idempotency, retry, and reset/clear supersession.
2. Stream mailbox pages and upload contents through bounded parse/persist batches. Do not retain whole histories.
3. Reduce CSV and provider concurrency to capacity-tested values and reject when bounded queues fill.
4. Add strict distributed login/registration/OTP limits and isolate password hashing.
5. Make Redis reconnect reliably; expose lock-service readiness and protect cold cache misses with single-flight/stale results.
6. Move migrations out of API startup.

### Phase 2 — Make read cost independent of lifetime history

1. Add per-user/time-bucket receipt rollups and calculate summary/dashboard/Wrapped data from them.
2. Precompute population percentiles and cache/version outputs.
3. Replace receipt offset pagination with keyset pagination; add narrow projections and indexed search.
4. Make import preferences a persisted-state read and refresh provider health asynchronously.
5. Bulk-insert analytics events and shift admin reporting to rollups/read-replica capacity.

### Phase 3 — Operational hardening

1. Externalize maintenance, use chunked retention/partitioning, and define retention for every append-only table.
2. Split database pool budgets by API, imports, maintenance, and reporting.
3. Add dependency circuit breakers, provider quota management, queue-age autoscaling, and graceful worker drain.
4. Regularly run production-scale load, soak, failure, and migration tests as part of release qualification.

## Recommended performance test plan

Static analysis identifies risk but cannot establish safe capacity. The following tests should run against production-like data volumes and container limits.

### Workload fixtures

- Users with 100, 10,000, and 100,000 receipts, including large `items` arrays.
- Gmail/Outlook mailboxes with small history, 10k+ candidate messages, dense yearly windows, large HTML bodies, throttling, and intermittent 429/5xx responses.
- CSV files at common size, maximum compressed size, maximum expanded size, malformed input, and high row count.
- Analytics event tables spanning realistic retention with large cohorts.
- Enough Redis keys to expose keyspace-scan cost.

### Load tests

1. **Dashboard cold-cache burst:** synchronized app launches requesting summary, insights, and preferences. Repeat with Redis disabled.
2. **Mixed traffic:** receipt browsing and authentication while imports and maintenance run.
3. **Import concurrency:** increase Gmail, Outlook, and CSV work separately until p95 latency, event-loop lag, pool wait, or memory reaches its limit.
4. **Auth abuse:** invalid password and OTP attempts at controlled rates while measuring event-loop availability.
5. **Deep receipt history:** cursor/offset comparisons, substring search, and exact counts with `EXPLAIN (ANALYZE, BUFFERS)`.
6. **Tracking soak:** more eligible users than one interval can process, multiple worker replicas, provider throttling, and lock contention.
7. **Dependency failure:** Redis outage/recovery, PostgreSQL latency, provider timeouts, email-provider failure, and client disconnects.
8. **Deployment/migration:** large pending migration during a rolling deployment, rollback compatibility, worker drain, and stuck-job reclamation.

### Suggested pass criteria

Set exact targets from product SLOs and infrastructure limits. At minimum, tests should demonstrate:

- No unbounded queue or monotonic memory growth.
- Stable event-loop delay and no container OOM at the declared concurrency limit.
- Database pool waiting remains near zero for ordinary traffic and recovers quickly after bursts.
- Expensive work is rejected or queued before it degrades cheap interactive endpoints.
- Client cancellation stops downstream work within a bounded interval.
- Redis loss causes a defined degraded mode rather than uncontrolled database amplification.
- Tracking backlog age converges after a surge.
- Deploys and dependency recovery do not require manual process restarts.

## Database validation checklist

Before adding indexes or changing queries, collect normalized query statistics and plans on representative data.

- Enable and review `pg_stat_statements` for total time, calls, mean/p95 approximation, rows, and temporary I/O.
- Capture pool checkout time separately from query execution time.
- Inspect full-history receipt reads, receipt list/count/search, tracking eligibility, percentile, retention, and migration backfill queries.
- Measure WAL, replication lag, dead tuples, autovacuum duration, and table/index growth during imports and maintenance.
- Verify transaction age and lock waits during bulk replacement.
- Budget `pool_size × replica_count + workers + maintenance + admin` below the database connection limit with operational reserve.
- Add candidate indexes only after confirming selectivity and write-cost tradeoffs.

## Positive controls already present

The following implementation choices reduce risk and should be preserved while refactoring:

- PostgreSQL clients are generally released in `finally` blocks, and statement/query timeouts exist.
- Receipt mutations use transactions and database uniqueness for deduplication.
- Import locks fail closed in production, prioritizing correctness over availability.
- Gmail detail retrieval and email extraction have local concurrency limits, even though total work remains unbounded.
- Microsoft Graph calls have per-call timeout/retry handling.
- ZIP extraction checks entry count, type, path traversal, encryption, and expanded size.
- Receipt list UI uses virtualization and server-driven pagination.
- TanStack Query deduplicates identical concurrent keys and centralizes retry policy.
- Shutdown coordination exists, providing a foundation for proper drain behavior.
- Admin analytics has rollup infrastructure that can be expanded to replace raw scans.

## Recommended ownership and acceptance criteria

| Workstream | Primary owner | Done when |
|---|---|---|
| Import execution | Backend/platform | Implemented for quick operation acceptance, bounded workers, page-streamed/checkpointed mailboxes, file-streamed CSV/ZIP parsing, caps, staging, durable retry, and stale-job recovery. Production-scale recovery/load qualification remains. |
| Admission control | Backend/platform/security | Limits are distributed, resource-class-specific, measured, and excess work is rejected before expensive computation. |
| Analytics projections | Backend/data | Dashboard, summary, and Wrapped cost is bounded by requested period/rollups, not lifetime receipt rows. |
| Database capacity | Backend/DBA | Pool budget is configurable, query plans are validated, and pool wait has an alert/SLO. |
| Redis resilience | Platform/backend | Startup outage recovers without restart; cache and lock health are distinct; stampedes are prevented. |
| Tracking scheduler | Backend/platform | Implemented as an hourly durable enqueue pass with per-user exclusion. Provider-wide quota shaping, backlog-age autoscaling, and soak validation remain. |
| Client traffic shaping | Mobile | Dashboard requests are staged, search is debounced/cancelled, retries respect overload, and cache memory is bounded. |
| Deployments/maintenance | Platform/DBA | Migrations and maintenance are external jobs with timeouts, chunking, telemetry, and rollback-compatible releases. |

## Final assessment

The application is likely to perform adequately for small datasets and low concurrency, which can conceal the nonlinear risks. The dominant problems are not micro-optimizations; they are missing bounds and shared-resource isolation. Historical imports, CSV parsing, lifetime analytics, and background jobs can each consume the same Node process and PostgreSQL pool without fleet-wide admission control. Redis and deployment behavior can then turn a localized slowdown into a broad outage.

The most important design rule for the next production stage should be: **every expensive operation must have a bounded input, bounded concurrency, explicit deadline, durable progress, and an observable failure mode**. Applying that rule to imports first, then analytics and background work, will remove the largest outage paths and make subsequent capacity tuning evidence-driven.
