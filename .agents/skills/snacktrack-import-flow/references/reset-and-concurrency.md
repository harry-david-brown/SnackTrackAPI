# Reset and concurrency

Load `snacktrack-account-data-lifecycle` for the preserve/delete matrix and `snacktrack-backend-engineering` for transaction and distributed-lock mechanics.

## Required writer inventory

- manual Gmail and Outlook historical import;
- dashboard/app-triggered ongoing check;
- in-process or external scheduled tracking batch;
- Uber/DoorDash CSV or ZIP upload;
- receipt clearing;
- onboarding/fresh-account reset;
- account deletion and repair/backfill jobs.
- durable import jobs, outbox dispatch, and workers that may resume after an outage.

All paths that can write receipts or import lifecycle state must coordinate on the same per-user lock and generation checks. A reset that only disconnects a mailbox does not stop a sync that already fetched mail or a queued worker that resumes later.

## Fresh import-state reset

After the shared lock is acquired, one server transaction should:

1. clear Gmail and Outlook mailbox credentials, scopes, provider identity, and connection mode;
2. advance the user's import generation and supersede all active durable operations;
3. delete every receipt source;
4. delete provider sync runs and import preference events when brand-new semantics require it;
5. restore import/export, monitoring, and tracking preferences to schema defaults;
6. commit before cache invalidation.

Then invalidate Gmail health and all server analytics caches. The app removes analytics, wrapped, receipts, import-preference, Gmail-status, export handoff/notification, and upsell caches while preserving authentication storage.

## Timeline diagnosis

Compare reset request time, sync start/completion, receipt `created_at`/`first_seen_at`, lifecycle timestamps, and cache logs. A sync that starts before deletion but inserts afterward proves a missing shared-lock boundary.
