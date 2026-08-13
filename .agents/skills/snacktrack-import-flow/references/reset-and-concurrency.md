# Reset and concurrency

Load `snacktrack-account-data-lifecycle` for the preserve/delete matrix and `snacktrack-backend-engineering` for transaction and distributed-lock mechanics.

## Required writer inventory

- manual Gmail historical import;
- dashboard/app-triggered ongoing check;
- in-process or external scheduled tracking batch;
- Uber/DoorDash CSV or ZIP upload;
- receipt clearing;
- onboarding/fresh-account reset;
- account deletion and repair/backfill jobs.

All paths that can write receipts or import lifecycle state must coordinate on the same per-user lock. A reset that only disconnects Gmail does not stop a sync that already fetched mail and is about to commit.

## Fresh import-state reset

After the shared lock is acquired, one server transaction should:

1. clear Gmail credentials, scopes, provider identity, and connection mode;
2. delete every receipt source;
3. delete sync runs and import preference events when brand-new semantics require it;
4. restore import/export, monitoring, and tracking preferences to schema defaults;
5. commit before cache invalidation.

Then invalidate Gmail health and all server analytics caches. The app removes analytics, wrapped, receipts, import-preference, Gmail-status, export handoff/notification, and upsell caches while preserving authentication storage.

## Timeline diagnosis

Compare reset request time, sync start/completion, receipt `created_at`/`first_seen_at`, lifecycle timestamps, and cache logs. A sync that starts before deletion but inserts afterward proves a missing shared-lock boundary.
