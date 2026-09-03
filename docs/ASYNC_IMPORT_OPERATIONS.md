# Async import operations

SnackTrack imports are durable operations. The API records intent in PostgreSQL and returns immediately; a BullMQ worker reads the durable outbox, performs mailbox or export work at bounded concurrency, and records progress and the terminal result. Redis absorbs bursts but PostgreSQL remains the source of truth.

## Local development

From `SnackTrackAPI`:

```sh
cp .env.example .env
docker compose up --build
```

This starts PostgreSQL, Redis, MinIO, a one-shot migration service, the API, and the import worker. MinIO is available at `http://localhost:9001`; its bucket is private and is created automatically. The app receives upload URLs using `http://localhost:9000`.

For Android emulators, forward both services:

```sh
adb reverse tcp:3000 tcp:3000
adb reverse tcp:9000 tcp:9000
```

For a physical device, set `OBJECT_STORAGE_PUBLIC_ENDPOINT` to the computer's LAN URL before starting Compose. Provider APIs use mock mode by default and push delivery is logged. Real push notifications require an Expo development build plus APNs/FCM credentials.

Run one scheduler pass locally with `docker compose --profile tools run --rm scheduler`.

## Railway services

Deploy the same image as three services:

- API: use `railway.json` (`npm start`, health check `/health`, and `npm run migrate` before deploy).
- Worker: set the service config path to `railway.worker.json`; scale this service according to queue depth.
- Scheduler: set the service config path to `railway.scheduler.json` and configure it as an hourly Railway cron.

The shared Docker image intentionally has no image-level HTTP health check because worker and scheduler processes do not expose an HTTP port. Railway applies `/health` only to the API service.

Provision PostgreSQL, Redis, and an S3-compatible private bucket. Set `QUEUE_REDIS_URL` separately when queue traffic should be isolated from cache traffic. Use the bucket's internal endpoint for `OBJECT_STORAGE_ENDPOINT` and its device-reachable HTTPS endpoint for `OBJECT_STORAGE_PUBLIC_ENDPOINT`.

All three services need the same `DATABASE_URL`, `REDIS_URL`/`QUEUE_REDIS_URL`, object-storage bucket/region/credentials, JWT and mailbox secrets, and provider configuration. Production startup rejects missing database, Redis, storage endpoint, public HTTPS storage endpoint, bucket, or storage credentials instead of falling back to localhost. Set `PUSH_DELIVERY_MODE=expo` after Expo push credentials are configured (`log` is only the local-development behavior).

Workers delete successfully processed or terminally failed objects. Configure a bucket lifecycle rule to delete any `imports/` object after 24 hours as a backstop for abandoned upload intents or interrupted cleanup.

The scheduler also re-dispatches operations whose queue/worker heartbeat has been stale for 45 minutes. This covers a lost Redis queue record or a worker disappearing after it claimed work; generation checks and the user receipt-writer lock keep recovery from committing stale or overlapping data.

Keep Redis eviction disabled for the queue instance. Set database pool sizes so the sum of `DATABASE_POOL_MAX × replicas` stays below the PostgreSQL connection allowance. Start with mailbox concurrency 2 and export concurrency 1 per worker replica.

## Operation contract

- `POST /gmail/import`, `POST /outlook/import`, and `POST /gmail/tracking/check` return `202` with `{ operation }`.
- `GET /imports/active`, `GET /imports/:id`, and `GET /imports/recent` expose durable state.
- Export files use the provider-specific `POST /imports/exports/uber-eats/upload-intent` or `POST /imports/exports/doordash/upload-intent`, direct `PUT` to the signed URL, then `POST /imports/:id/submit`.
- `PUT /notifications/device` registers an Expo installation; deleting the same installation disables it.

Only one receipt-writing operation can be active per user. Idempotency keys return the original operation, resets supersede existing operations through `users.import_generation`, and no cancellation endpoint is exposed.
Starting a new export upload may replace an abandoned `awaiting_upload` intent, but it cannot supersede queued or running receipt work. Signed-URL retries refresh the existing intent in the app.

## Streaming and recovery

Mailbox workers fetch, extract, deduplicate, and persist one provider page at a time. After each page's receipt upsert commits, the worker stores the opaque Gmail or Microsoft cursor and cumulative counters in `import_jobs.checkpoint`. A retry starts at that cursor. A crash between the receipt commit and checkpoint update can replay one page; provider message identity and receipt upserts make that replay safe. Tracking jobs keep separate Gmail and Microsoft child checkpoints so a retry does not discard the provider that already completed.

CSV uploads remain files throughout processing. ZIP entries stream into a private temporary CSV file with path, symlink, entry-count, integrity, expanded-size, and compression-ratio checks. The CSV parser then reads that file as a stream and retains compact order aggregates rather than the entire byte buffer or every raw row. Limits of 25 MiB selected ZIP output, 250 MiB total declared archive expansion, 100,000 rows, and 25,000 orders bound worker memory and CPU. Export retries restart parsing from the ETag-pinned durable object because parsing has no database side effects; the final staged replacement remains atomic and generation-fenced. See [IMPORT_INPUT_SECURITY.md](./IMPORT_INPUT_SECURITY.md) for the complete input policy.

The `checkpoint` field is deliberately internal and is not returned by the import-operation API. Do not interpret provider cursors in routes or the app. Invalid or cross-provider checkpoints fail permanently with `IMPORT_CHECKPOINT_INVALID` instead of risking a corrupt resume.

On deploy, run migration 13 before starting workers that contain this code. During shutdown, allow workers to finish their current page; if the platform terminates them, stale-job recovery will redispatch the operation and resume from the last committed page.
