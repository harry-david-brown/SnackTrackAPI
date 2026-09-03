# Import streaming and checkpoint implementation plan

## Outcome

This work closes the remaining high-risk import gaps from the production performance review: mailbox histories no longer accumulate in a worker heap, uploaded ZIP/CSV bytes are no longer copied into large buffers, and mailbox retries continue from durable page checkpoints.

## Implemented sequence

1. **Durable checkpoint schema** — migration 13 adds a private JSONB checkpoint to `import_jobs`. Repository writes update checkpoint, phase, progress, heartbeat, and timestamp together while a job is running.
2. **Provider-neutral paging contract** — mailbox adapters expose asynchronous pages containing normalized messages, a matched count, and an opaque next cursor.
3. **Gmail page pipeline** — each page contains at most 20 candidates and is fetched with detail-request concurrency 5, extracted, cutoff-filtered, deduplicated, upserted, and checkpointed. Cumulative limits remain 1,000 pages, 20,000 matches, 15 minutes, and the decoded-byte budget.
4. **Outlook page pipeline** — Graph searches use fixed, cursor-encoded time windows and process one Graph page at a time. The cursor fixes the scan end so a retry has a stable range and validates any stored next-link host before use.
5. **Tracking composition** — ongoing jobs maintain independent Gmail and Microsoft child checkpoints. A provider failure now fails the queue attempt so BullMQ retry can use those checkpoints.
6. **File-streamed exports** — object storage downloads to a temporary file; ZIP entries stream to a second temporary CSV with traversal, symlink, encryption, file-count, ratio, and expanded-byte defenses; CSV parsing reads directly from disk.
7. **Bounded aggregation** — CSV parsing keeps only order/item aggregates, capped at 100,000 rows and 25,000 orders, before the existing staged atomic provider replacement.
8. **Recovery and contract coverage** — checkpoint resume and migration shape have regression coverage. Internal cursors remain excluded from public operation responses.

## Recovery model

The safe commit order is receipt write, then checkpoint write. If a process stops before the receipt commit, that page has no durable effect and is retried. If it stops after the receipt commit but before the checkpoint, one page can replay; stable source identity and receipt upserts make the replay idempotent. If it stops after the checkpoint, the next attempt begins at the following page.

CSV parsing has no incremental database effects. A failed attempt restarts from the durable object-storage file. The provider replacement occurs through job-scoped staging and an atomic, generation-fenced swap, which is safer than exposing partially imported CSV data.

## Local development and verification

From `SnackTrackAPI`, copy `.env.example` to `.env` once and start `docker compose up --build`. This provides PostgreSQL, Redis, MinIO, migrations, the API, and a worker with production-shaped service boundaries. Migration 13 is applied by the migration container. Mailbox providers remain mocked and push delivery is logged by default.

For a clean rebuild after dependency or image changes, stop the Compose project, then start it again with `--build`. Do not delete database or object-storage volumes during normal development; preserving them verifies real migration and retry behavior. Use a disposable Compose project or explicitly approved volume reset only when testing first-boot behavior.

Verification gates for this change are API TypeScript compilation, mobile-app type checking, migration integration coverage with a configured temporary PostgreSQL database, checkpoint retry coverage, and production-like load tests using maximum-size ZIP/CSV files and interrupted Gmail/Outlook pages. Automated tests should be run in CI; provider load tests must use non-production test mailboxes and quota-aware rates.

## Deployment order and rollback

1. Deploy migrations 13 and 14 before the new workers.
2. Deploy workers at mailbox concurrency 2 and export concurrency 1 per replica.
3. Deploy the API; no public contract migration is required.
4. Watch queue age, worker RSS, page duration, provider throttling, checkpoint-write failures, stale-job redispatch, and database pool wait.
5. Scale workers using queue age while keeping the fleet-wide PostgreSQL connection budget and provider quotas bounded.

The schema additions are backward-compatible at the database level, but the provider-specific upload endpoint is an intentional coordinated client/API cutover. Roll back application processes without dropping the checkpoint or security columns. Once a new worker has saved a checkpoint or a provider-bound upload, only current workers should claim that operation; pausing workers during rollback is safer than allowing an old worker to restart it under an older contract.

## Residual risks

- Receipt objects and their item arrays are retained until one export has been parsed because provider replacement is atomic; row and order ceilings make that memory finite. Very large supported exports should be qualified against the Railway worker memory limit.
- Provider cursors can expire or be invalidated externally. Such failures remain observable and either retry from the stored cursor or terminate with a stable reconnect/checkpoint error.
- Per-page receipt upserts can cause more database round trips than one giant write. This is intentional isolation; tune mailbox page size and worker concurrency from telemetry rather than increasing them blindly.
- Production confidence still requires interruption, throttling, maximum-file, and sustained-queue load tests. Static compilation alone cannot establish capacity.
