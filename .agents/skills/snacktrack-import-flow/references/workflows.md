# Import workflows

## Mailbox baseline and catch-up check

1. User connects or reconnects Gmail or Outlook through its mailbox OAuth flow.
2. The OAuth callback persists validated credentials before redirecting to the signed app URI.
3. The app refreshes the canonical import-preferences projection. A pre-OAuth query may already be in flight, so tolerate a bounded stale `disconnected` result before reporting that authorization failed.
4. API validates that provider's credentials before presenting/running an import action.
5. User explicitly starts the baseline or catch-up check.
6. API creates a PostgreSQL import job and transactional dispatch outbox record, returning the durable operation immediately.
7. The outbox publishes to BullMQ when queue Redis is available; the app polls the operation rather than treating acceptance as completion.
8. A worker acquires the per-user distributed lock, verifies durable status/import generation, and fetches messages through the provider adapter.
9. The shared receipt pipeline upserts using stable provider/source identity and reports new, updated, and unchanged counts.
10. The worker commits lifecycle/result state, invalidates projections, and publishes terminal notification state.
11. App terminal handling refetches preferences and receipt/summary data.

If OAuth returns `invalid_grant`, stop and return a reconnect-required error. Do not log “completed,” write a completed preference, or return HTTP success with zero receipts.

Do not treat the first stale/null connection projection after a successful callback as provider denial. Retry the authoritative read for a short bounded period; explicit callback errors and durable reconnect-required states remain terminal for that attempt.

## Export request and ready alert

1. User follows the in-app tutorial to request their data from Uber.
2. SnackTrack explicitly asks permission before inspecting mail for the data-ready message.
3. The lifecycle records whether the request is waiting with alerts enabled or disabled.
4. If consented and credentials are healthy, background checks look only for the identifying ready email.
5. Detection changes the lifecycle to `file_ready` and notifies the user.
6. User opens Gmail, finds “Your Uber data is ready for download” from “Uber - Download Your Data,” follows “GO TO DOWNLOAD PAGE,” signs in, and downloads within Uber’s stated availability window.
7. SnackTrack asks whether the file has already been downloaded. Route “not yet” to Gmail/help and “yes” directly to the native file picker.

The ready email links to Uber’s download page; it does not attach the archive. SnackTrack must not claim it downloaded or can automatically obtain the archive.

## Export upload

1. Native file picker returns the selected archive/file and the app requests a provider-specific upload intent with size/type metadata and an idempotency key.
2. The app uploads directly to the signed object-storage URL, then submits the durable operation once; do not proxy the file through the API or add a redundant second picker.
3. Submission verifies stored size, type, integrity metadata, and provider before creating dispatch work.
4. The worker streams/parses supported Uber/DoorDash export shapes and validates usable records.
5. Mark only the selected/detected provider's lifecycle `import_processing` while work is active.
6. Replace historical overlapping export/email receipts according to cutoff rules while preserving newer mailbox receipts.
7. Mark only that provider completed and the operation succeeded after durable receipt writes commit.
8. Clean up staged/object data according to terminal operation policy, invalidate API caches, and refetch app state.

## Queue outage and cancellation

- `pending_dispatch`/waiting-for-queue is a valid degraded state when PostgreSQL accepted work but BullMQ is unavailable.
- Queue recovery republishes unpublished outbox work. Do not ask the user to duplicate a still-active operation.
- A lock-backend outage delays worker execution without consuming the normal processing-attempt budget.
- `cancelled`, `superseded`, `expired`, `failed`, and `succeeded` are terminal. The app stops polling and uses the status/error code for the recovery message.
- Administrative cancellation is durable first and Redis cleanup is best effort; a recovered worker must no-op cancelled work.

## Ongoing tracking

1. A completed Gmail baseline or receipt-backed coverage from a provider export makes tracking eligible, but not automatically authorized.
2. Ask explicit permission for ongoing future receipt monitoring.
3. Validate supported mailbox health before enabling or invoking tracking.
4. For export-backed setup, enter `setting_up` and run the first consented check from the provider-specific export cutoffs without marking the Gmail baseline complete.
5. Scheduled/import-on-open work processes new receipts incrementally using the prior successful check with a bounded lookback.
6. A successful zero-result first check activates tracking; a failure preserves imported history and exposes retry/reconnect.
7. Dashboard shows active monitoring without asking the user to manually scan Gmail.
8. On provider invalid/revoked credentials, transition that provider to reconnect required and show the matching reconnect action.

Background tracking runs update tracking activity and runtime errors only. They must never start, complete, or fail a provider's one-time history lifecycle.

## Clearing receipts and onboarding

Classify the operation before implementation:

- disconnect Gmail preserves existing receipts unless product intent says otherwise;
- clear receipts removes source coverage and receipt-derived analytics;
- fresh-account/onboarding reset preserves login identity but removes all imported content, provider access, consent/runtime state, import/export lifecycle, sync/audit history, and affected caches;
- account deletion removes the account and dependent data.

Use one authoritative server mutation for a fresh reset. Serialize it with Gmail and export writers, mutate related tables transactionally, invalidate server caches after commit, remove app caches after success, and only then clear the local onboarding marker. See `snacktrack-account-data-lifecycle` for the complete preserve/delete contract.
