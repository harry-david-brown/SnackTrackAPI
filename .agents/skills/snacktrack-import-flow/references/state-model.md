# Import state model

Do not collapse these axes. Similar-looking UI states often have different recovery actions.

## Independent state axes

| Axis | Meaning | Examples |
| --- | --- | --- |
| Gmail identity | Which account the user connected | absent, known email |
| Credential health | Whether current tokens can access Gmail | healthy, unavailable, reconnect required |
| Historical Gmail import | One-time/backfill import progress | never started, importing, completed, failed |
| Export lifecycle | Uber/DoorDash request and upload progress | not started, waiting, ready, processing, completed, failed |
| Receipt source coverage | What data actually exists | Gmail-only, export-only, both, neither |
| Export-alert consent | Permission to inspect mail for Uber’s ready message | not offered, declined, granted, revoked |
| Ongoing tracking consent | Permission to monitor future receipt emails | not offered, declined, granted, revoked |
| Tracking runtime | Current operational monitoring state | inactive, active, paused, reconnect required, error |

`connected`, `hasImported`, `hasExportData`, and `canTrack` are not interchangeable.

## App enums

Verify current declarations in `SnackTrackApp/services/gmailApi.ts`. The established model includes:

- monitoring consent: `not_offered`, `declined`, `granted`, `revoked`;
- effective monitoring: `not_offered`, `declined`, `enabled`, `disabled`, `reconnect_required`;
- export lifecycle: `not_started`, `requested_monitoring_enabled`, `requested_monitoring_disabled`, `file_ready`, `import_processing`, `completed`, `failed`;
- Gmail import: `never_started`, `importing`, `completed`, `failed`;
- effective ongoing tracking: `not_offered`, `declined`, `active`, `paused`, `reconnect_required`, `error`.

If the source has evolved, update this reference in the same change.

## Truth hierarchy

Use persisted lifecycle fields to retain user progress, but reconcile them with operational truth:

1. Actual receipt sources establish whether Gmail or export data exists.
2. Credential health establishes whether Gmail actions can run now.
3. Explicit consent establishes whether background email access is permitted.
4. Lifecycle status establishes which request/upload step is in progress.
5. Runtime tracking status establishes whether ongoing monitoring is operating.

For example, CSV/export receipts should make the export step complete even if an older preference row still says `not_started`. Conversely, an account email alone must not make Gmail import complete.

## Fresh-account reset state

When product intent says “as if this login were a brand-new account,” the post-reset import state is:

- Gmail identity absent; credentials/scopes absent; connection mode `none`;
- Gmail import `never_started` with zero imported/source receipts;
- export `not_started` with zero export receipts;
- monitoring and ongoing tracking `not_offered`;
- tracking runtime `inactive` with no activity/error timestamps;
- no sync history, import audit history, summary readiness, or cached analytics/import completion;
- authentication identity and profile essentials preserved.

Do not derive a different state from pre-reset receipt rows: the authoritative reset must delete those rows while holding the shared writer lock.

## UI resolver principle

Resolve one actionable state using explicit precedence. Avoid rendering independent booleans that can produce contradictory cards.

Typical dashboard precedence:

1. Export file ready or import processing.
2. Actionable import/export failure.
3. Export requested and waiting.
4. Gmail reconnect required.
5. Gmail not connected or historical import not done.
6. Export upgrade available.
7. Ongoing tracking reconnect/error.
8. Tracking active.
9. Tracking paused/declined/not offered.

Re-check product intent before altering precedence. Add a table-driven resolver test for every new combination.
