---
name: snacktrack-import-flow
description: Understand and change SnackTrack's mailbox receipt import, Gmail connection flow, Uber/DoorDash email and export coverage, export-ready alerts, consent, connection health, ongoing tracking, and dashboard/upload state machines. Use for import UX, preference endpoints, mailbox OAuth completion, provider adapters, invalid_grant handling, deduplication/replacement, background-sync races, or any bug where connection/import/export truth disagrees across the app and API. Also load snacktrack-mailbox-integrations for Gmail/Outlook/Graph adapter work and snacktrack-account-data-lifecycle for clear/reset/delete behavior.
---

# SnackTrack Import Flow

Use this skill to preserve the distinctions between connection, import, export, consent, and live-tracking states across SnackTrack’s app and API.

## Required workflow

1. Read [references/state-model.md](references/state-model.md) before changing a state, badge, CTA, or preference field.
2. Read the relevant workflow in [references/workflows.md](references/workflows.md).
3. Read [references/data-and-error-rules.md](references/data-and-error-rules.md) before editing Gmail OAuth, imports, upload replacement, resets, or error handling.
4. Read [references/reset-and-concurrency.md](references/reset-and-concurrency.md) for clearing, reset, provider disconnect, or import race work, and load `snacktrack-account-data-lifecycle`.
5. Trace the state end to end:
   - persisted preferences and actual receipt sources;
   - API health checks and response construction;
   - app response normalization and hooks;
   - dashboard/upload/post-summary resolver precedence;
   - user-visible action and recovery path.
6. Add regression coverage at the canonical transition or resolver. Run only the relevant TypeScript check unless the user explicitly requests tests or other verification.

## Canonical files

### App

- `SnackTrackApp/features/import-flow/contracts.ts`: normalized import-flow domain contracts.
- `SnackTrackApp/services/gmailApi.ts` and `services/normalizers/gmailNormalizers.ts`: transport actions and runtime response normalization.
- `SnackTrackApp/hooks/useImportPreferences.ts`: server preference state and mutations.
- `SnackTrackApp/hooks/useGmailImport.ts`: connect, reconnect, import, and error handling.
- `SnackTrackApp/hooks/useImportFlowController.ts`: multi-step import-flow orchestration and OAuth resume outcomes.
- `SnackTrackApp/app/(tabs)/upload.tsx`: three-step import checklist and export upload UX.
- `SnackTrackApp/components/dashboard/dashboardTrackingState.ts`: dashboard next-step/tracking precedence.
- `SnackTrackApp/components/wrapped/postWrappedState.ts`: post-summary proposition precedence.

### API

- `SnackTrackAPI/src/services/ports/MailboxPorts.ts`, `ImportPorts.ts`, and `ReceiptPorts.ts`: provider-neutral mailbox, lifecycle, persistence, cache, and lock capabilities.
- `SnackTrackAPI/src/services/data/ImportLifecycleRepository.ts`, `ImportPreferencesQueryRepository.ts`, `GmailSyncRunRepository.ts`, and `ImportSourceCoverageRepository.ts`: split lifecycle commands, projections, sync history, and receipt-backed coverage.
- `SnackTrackAPI/src/routes/gmail.ts` plus `gmailOAuth.ts`, `gmailPreferences.ts`, `gmailTracking.ts`, and `gmailImport.ts`: composition and focused Gmail HTTP contracts.
- `SnackTrackAPI/src/services/email/GmailConnectionHealthService.ts`: credential validation and health caching.
- `SnackTrackAPI/src/services/email/GmailOAuthProvider.ts`, `GmailProviderDecoder.ts`, and `GmailClient.ts`: Google-specific OAuth, payload decoding, validation, and mailbox requests.
- `SnackTrackAPI/src/services/import/GmailConnectionService.ts` and `ImportStatusService.ts`: connection commands and the canonical preference/health projection.
- `SnackTrackAPI/src/services/import/GmailImportAcquisitionService.ts`, `ReceiptEmailBatchExtractor.ts`, `ReceiptDeduplicator.ts`, `ReceiptImportPersistenceService.ts`, `GmailImportLifecycleService.ts`, and `GmailImportService.ts`: acquisition-to-lifecycle pipeline.
- `SnackTrackAPI/src/services/import/OngoingTrackingService.ts`: ongoing/scheduled receipt checks.
- `SnackTrackAPI/src/services/import/CsvImportService.ts` and `CsvImportUseCase.ts`: pure export parsing plus lock/lifecycle/write orchestration.
- `SnackTrackAPI/src/services/data/ReceiptRepository.ts`: canonical receipt reads, email upserts, and provider-export replacement.

Confirm paths with `rg --files` before editing; use `snacktrack-codebase-navigation` for a broader architecture trace.

## Invariants

- Never treat Gmail identity, token health, historical Gmail import, export completion, monitoring consent, and ongoing tracking as one boolean.
- Never report an OAuth failure as a successful zero-result import.
- Never let a Gmail sync or export upload commit behind a destructive reset; all conflicting writers must share the same per-user lock protocol.
- Never read ongoing email without the user’s explicit monitoring/tracking permission.
- Detecting Uber’s data-ready email means the download is ready; it does not mean SnackTrack can download the archive.
- Derive export completion from actual imported export receipts when persisted lifecycle state may be stale.
- Preserve newer Gmail receipts when an export replaces historical overlapping data.
- A completed one-time Gmail import does not imply credentials remain healthy or ongoing monitoring is enabled.
- Make dashboard, upload, and post-summary surfaces resolve the same server truth with intentionally different copy—not separate truth models.

## Verification focus

Cover at least:

- disconnected, connected-unimported, importing, completed, and failed Gmail states;
- healthy, temporarily unavailable, and reconnect-required credentials;
- export not started, requested, ready, processing, completed, and failed;
- explicit consent not offered, declined, granted, and revoked;
- export data present even when preference metadata is stale;
- all methods complete with automatic ongoing monitoring;
- clearing receipts/reset behavior;
- duplicate, overlapping, and newer receipt preservation;
- cache invalidation and refetch after every mutation.
- reset during active Gmail sync or export upload, including lock timeout and post-reset scheduler eligibility.
