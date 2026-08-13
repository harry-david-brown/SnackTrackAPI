# Import workflows

## Gmail historical import

1. User connects or reconnects Gmail through OAuth.
2. API validates credentials before presenting/running an import action.
3. User explicitly starts the historical receipt import.
4. API acquires the per-user import lock.
5. Gmail messages are fetched and parsed.
6. Receipts are upserted using stable source identity and reported as new, updated, or unchanged.
7. Preferences and user caches are updated/inactivated consistently.
8. App refetches preferences and receipt/summary state.

If OAuth returns `invalid_grant`, stop and return a reconnect-required error. Do not log “completed,” write a completed preference, or return HTTP success with zero receipts.

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

1. Native file picker returns the selected archive/file.
2. App uploads once; do not insert a redundant second “choose file” screen.
3. API parses supported Uber/DoorDash export shapes and validates usable records.
4. Mark lifecycle `import_processing` while work is active.
5. Replace historical overlapping CSV/email receipts according to cutoff rules while preserving newer Gmail receipts.
6. Mark completed only after durable receipt writes succeed.
7. Invalidate API caches and refetch app state.

## Ongoing tracking

1. Historical import completion and Gmail connection make tracking valuable, not automatically authorized.
2. Ask explicit permission for ongoing future receipt monitoring.
3. Validate Gmail health before enabling or invoking tracking.
4. Scheduled/import-on-open work processes new receipts incrementally.
5. Dashboard shows active monitoring without asking the user to manually scan Gmail.
6. On `invalid_grant`, transition to reconnect required and show a reconnect action.

## Clearing receipts and onboarding

Classify the operation before implementation:

- disconnect Gmail preserves existing receipts unless product intent says otherwise;
- clear receipts removes source coverage and receipt-derived analytics;
- fresh-account/onboarding reset preserves login identity but removes all imported content, provider access, consent/runtime state, import/export lifecycle, sync/audit history, and affected caches;
- account deletion removes the account and dependent data.

Use one authoritative server mutation for a fresh reset. Serialize it with Gmail and export writers, mutate related tables transactionally, invalidate server caches after commit, remove app caches after success, and only then clear the local onboarding marker. See `snacktrack-account-data-lifecycle` for the complete preserve/delete contract.
