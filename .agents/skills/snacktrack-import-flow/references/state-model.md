# Import state model

Do not collapse these axes. Similar-looking UI states often have different recovery actions.

## Independent state axes

| Axis | Meaning | Examples |
| --- | --- | --- |
| Mailbox identity | Which Gmail and/or Outlook accounts the user connected | absent, known email per provider |
| Credential health | Whether current tokens can access each mailbox | healthy, unavailable, reconnect required |
| Gmail baseline | Whether an explicit one-time/catch-up scan has ever succeeded | never completed, completed at timestamp |
| Latest Gmail attempt | The most recent explicit scan, independent of the baseline | never started, importing, completed, failed |
| Outlook baseline and latest attempt | The same historical-import distinction for Outlook | never completed/completed; never started/importing/completed/failed |
| Durable operation | Accepted asynchronous work and its delivery/execution state | awaiting upload, pending dispatch, queued, running, retrying, succeeded, failed, expired, superseded, cancelled |
| Provider export lifecycle | Independent Uber Eats/DoorDash request and upload progress | not started, requested, ready, processing, completed, failed |
| Receipt source coverage | What data actually exists | Gmail-only, export-only, both, neither |
| Export-alert consent | Permission to inspect mail for Uber’s ready message | not offered, declined, granted, revoked |
| Ongoing tracking consent | Permission to monitor future receipt emails | not offered, declined, granted, revoked |
| Tracking baseline | Which durable history makes incremental monitoring safe | none, Gmail baseline, provider export |
| Tracking runtime | Current operational monitoring state | inactive, setting up, active, paused, reconnect required, error |

`connected`, `hasImported`, `hasExportData`, and `canTrack` are not interchangeable.

## App enums

Verify current declarations in `SnackTrackApp/features/import-flow/contracts.ts` and API lifecycle constants in `SnackTrackAPI/src/services/import/ImportLifecycleTypes.ts`. The established model includes:

- monitoring consent: `not_offered`, `declined`, `granted`, `revoked`;
- effective monitoring: `not_offered`, `declined`, `enabled`, `disabled`, `reconnect_required`;
- provider export lifecycle: `not_started`, `requested`, `file_ready`, `import_processing`, `completed`, `failed`;
- Gmail baseline: sticky `hasCompleted` plus `completedAt`;
- latest Gmail attempt: `never_started`, `importing`, `completed`, `failed`;
- Outlook baseline and latest attempt use the corresponding fields in the canonical import-preferences contract;
- durable operation status: `awaiting_upload`, `pending_dispatch`, `queued`, `running`, `retrying`, `succeeded`, `failed`, `expired`, `superseded`, `cancelled`;
- effective ongoing tracking: `not_offered`, `declined`, `setting_up`, `active`, `paused`, `reconnect_required`, `error`.

If the source has evolved, update this reference in the same change.

## Truth hierarchy

Use persisted lifecycle fields to retain user progress, but reconcile them with operational truth:

1. Actual receipt sources establish whether Gmail or export data exists.
2. Per-provider credential health establishes which mailbox actions can run now.
3. Explicit consent establishes whether background email access is permitted.
4. Each provider's lifecycle status establishes which request/upload step is in progress.
5. Runtime tracking status establishes whether ongoing monitoring is operating.

For example, Uber Eats CSV receipts make Uber Eats complete even if its preference row says `not_started`, without completing DoorDash. Conversely, an account email or background tracking receipt must not make the explicit Gmail history import complete.

## Canonical action boundaries

1. Connecting Gmail or Outlook stores and validates access for that mailbox only.
2. The user explicitly starts the provider-specific history import.
3. Uber Eats and DoorDash exports can be requested or uploaded independently in any order.
4. Uber export-ready alerts authorize only the Uber data-ready email check while the app is active.
5. Ongoing tracking requires a safe baseline, healthy durable access to at least one supported mailbox, and explicit tracking consent.
6. Export-backed tracking setup starts from each provider's latest exported order without completing either provider's explicit history lifecycle.
7. Starting an import creates a durable operation. Lifecycle/source coverage changes only when the worker reaches the corresponding durable write; queued state alone is not imported data.

## Fresh-account reset state

When product intent says “as if this login were a brand-new account,” the post-reset import state is:

- Gmail and Outlook identities absent; credentials/scopes absent; connection mode `none`;
- Gmail and Outlook imports `never_started` with zero imported/source receipts;
- export `not_started` with zero export receipts;
- monitoring and ongoing tracking `not_offered`;
- tracking runtime `inactive` with no activity/error timestamps;
- no sync history, import audit history, summary readiness, or cached analytics/import completion;
- pre-reset durable operations are superseded and cannot commit after the account's import generation advances;
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
