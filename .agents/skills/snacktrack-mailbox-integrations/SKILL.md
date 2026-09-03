---
name: snacktrack-mailbox-integrations
description: Design and implement SnackTrack mailbox-provider connections and adapters for Gmail, Microsoft Outlook/Graph, or future inbox providers. Use for mailbox OAuth scopes/state/callbacks, credential storage and health, provider payload decoders, message retrieval, provider-aware connection contracts, source identity, reconnect behavior, or plugging a provider into the shared receipt-import pipeline. Do not use this skill for Microsoft/Google login alone; load snacktrack-authentication for identity sign-in and snacktrack-import-flow for receipt lifecycle/UX.
---

# SnackTrack Mailbox Integrations

Add mailbox providers without leaking vendor models into receipt extraction or conflating inbox access with SnackTrack login.

## Required workflow

1. Use `snacktrack-codebase-navigation` to trace connection persistence → OAuth adapter → health validation → mailbox client → shared import pipeline → app preferences/controller.
2. State whether the task changes identity login, mailbox access, or both. Load `snacktrack-authentication` for identity login and keep its credentials/contracts separate.
3. Read [references/provider-boundaries.md](references/provider-boundaries.md) before adding or generalizing a provider, storage schema, source identity, or mail client.
4. Read [references/oauth-health-and-readiness.md](references/oauth-health-and-readiness.md) for OAuth callback, scopes, credential health, reconnect, or app resume behavior.
5. Load `snacktrack-import-flow` for import lifecycle, consent, tracking, source coverage, deduplication, or UI state changes; load backend architecture/engineering for API or persistence work.
6. Define runtime payload decoders, stable provider-neutral outputs, error classification, credential retention, and cache invalidation before implementation.
7. Add adapter contract coverage plus the relevant import-flow transition coverage.
8. Run only the relevant TypeScript check unless the user explicitly requests broader verification.

## Core invariants

- Login identity OAuth and mailbox OAuth are separate clients/scopes/grants. Never infer inbox permission from login or use mailbox tokens to establish a SnackTrack session.
- Vendor SDK responses enter only provider adapters/decoders. The shared pipeline consumes `MailboxMessage` through `MailboxClient` and must not branch on Gmail or Graph payload shapes.
- Keep OAuth state signed, purpose-bound, short-lived where supported, and restricted to allowlisted app redirect URIs. Never trust a client-supplied user ID in the callback.
- Persist credentials before redirecting success. Invalidate connection-health state after token changes.
- Treat revoked/invalid grants as reconnect-required; treat timeouts and provider outages as temporary unavailability without destroying otherwise usable credentials or prior receipts.
- One-time import access, export-alert monitoring, and ongoing tracking consent are distinct. Provider scopes do not replace SnackTrack's explicit server-side consent state.
- Source identity must include enough provider context to avoid cross-provider message-ID collisions and must remain stable across re-reads/updates.
- Do not log raw message bodies, addresses, subjects, OAuth codes, access/refresh tokens, or provider response dumps.
- Gmail and Outlook are both shipped mailbox providers. Preserve their shared provider-aware connection, sync, lifecycle, source-identity, and app contracts; do not add a third parallel state machine for shared behavior.

## Canonical ownership

- Provider-neutral API boundary: `SnackTrackAPI/src/services/ports/MailboxPorts.ts` and relevant capabilities in `ImportPorts.ts`.
- Gmail adapters: `services/email/GmailOAuthProvider.ts`, `GmailProviderDecoder.ts`, `GmailClient.ts`, and `GmailConnectionHealthService.ts`.
- Microsoft adapters: `services/mailbox/MicrosoftMailboxOAuthProvider.ts`, `MicrosoftMailboxTokenService.ts`, `MicrosoftGraphMailboxClient.ts`, and `MicrosoftMailboxConnectionHealthService.ts`.
- Provider-aware persistence: `MailboxConnectionRepository.ts`, `MailboxSyncRunRepository.ts`, and `MailboxSecurityPolicyRepository.ts`.
- Connection/import application layer: Gmail connection/import services, `MicrosoftMailboxConnectionService.ts`, `OutlookImportAcquisitionService.ts`, `OutlookImportService.ts`, `HistoricalOutlookImportService.ts`, and `ImportStatusService.ts`.
- Shared receipt pipeline: provider acquisition -> `ReceiptEmailBatchExtractor.ts` -> `ReceiptDeduplicator.ts` -> `ReceiptImportPersistenceService.ts` -> lifecycle/sync repositories.
- App owner: the canonical import-preferences query plus `services/gmailApi.ts`, `services/outlookApi.ts`, `useGmailImport.ts`, `useOutlookImport.ts`, and `useImportFlowController.ts`.

## Handoff

Report the login-versus-mailbox distinction, provider adapter/decoder boundary, scopes and stored credential shape, callback/readiness behavior, stable source identity, consent/lifecycle effects, regression seam, TypeScript result, and external provider-console/device checks.
