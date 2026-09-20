# Receipt reconciliation verification — September 11, 2026

This records the earlier implementation. See [policy 2 and the reviewed account repair](receipt-reconciliation-v2.md) for the current matching policy and latest verification.

## Result

Receipt reconciliation passed its automated checks. The complete API suite is green. The complete mobile app suite is not green.

| Check | Result |
| --- | --- |
| API build and full tests with disposable PostgreSQL | 342 passed, 0 failed, 0 skipped |
| App TypeScript check | Passed |
| App Jest, Watchman disabled, supported NetInfo mock | 663 passed, 35 failed; 81 passing suites, 13 failing suites |
| API and app whitespace/diff checks | Passed |

## What was verified

The eight receipt-backed cases cover reconstructed quantities/subtotals and signed checkout differences. API tests cover source ordering, ambiguous matching, retained evidence, repeated imports, lower revised totals, zero/negative/unavailable differences, currency boundaries, JSON decoding and the public receipt DTO. A new real-PostgreSQL test also exercises both import orders, stable IDs, observation retention, idempotency, transaction rollback after writes, later matching, and combined-source email coverage. Fresh and legacy migrations and account lifecycle integration tests passed.

The test server used a new PostgreSQL 17 cluster under `/private/tmp/snacktrack-verification-pg`, port 55439. Tests created and removed temporary schemas. The server was stopped after testing. No application or production database was used; nothing was deployed.

## Repairs made during verification

- Fixed Canadian bare-dollar receipt inference: unknown currency can be inferred from strong Canadian evidence; explicitly recognized currencies are preserved.
- Preserved milliseconds when the import-delay repository receives PostgreSQL Date objects.
- Updated stale API contract expectations to include receipt provenance and current import/analytics metadata. Omitted absent optional receipt fields from mapper objects.
- Added the NetInfo package's supported Jest mock to prevent native-network bridge errors in Node.

## Remaining app failures

A separate snapshot of committed app HEAD, with the same supported NetInfo test mock and installed dependencies, reproduced **34 of the 35 failing test names**. It also had two other failures (one caused by missing untracked native files in the archive). This is evidence that those 34 are not introduced by the receipt reconciliation changes; it is not evidence that the underlying app flows are correct.

The other failure is the working-tree test `retries the automatic result handoff when another transition is still settling` in `ImportRecovery.test.tsx`. It expects one navigation replacement but observes zero, followed by a cleanup timeout. This test belongs to separate uncommitted navigation work; it was not changed in this verification pass.

Failures include outdated import-response fixtures (missing Outlook capability/durable operation fields), changed import UI/navigation expectations, AsyncStorage mocks, and dynamic imports unsupported by the current Jest invocation. These need a separate import-flow/test-harness repair pass before claiming the full mobile suite passes.

Failing suites:

- `__tests__/components/ExportImportTaskSection.test.tsx`
- `__tests__/components/ExportReadyNotifier.test.tsx`
- `__tests__/components/GuidedImportQuestion.test.tsx`
- `__tests__/components/ImportNotifications.test.ts`
- `__tests__/components/ImportRecovery.test.tsx`
- `__tests__/components/UberDataTutorial.test.tsx`
- `__tests__/components/UberDataUpload.test.tsx`
- `__tests__/features/importFlowResolver.test.ts`
- `__tests__/hooks/useGmailImport.test.ts`
- `__tests__/hooks/useImportPreferences.test.ts`
- `__tests__/services/adminAnalytics.test.ts`
- `__tests__/services/gmailApi.test.ts`
- `__tests__/utils/exportDownloadHandoff.test.ts`

## Evidence limits

The paired-email inputs are controlled fixtures based on supplied receipt screenshots, not a live Gmail/Outlook mailbox replay. Papa John's still has a known 7.80 CAD export-versus-receipt subtotal discrepancy and remains estimated. Automated checks validate the chosen behavior; they cannot establish missing export amounts as observed facts.

Detailed logs are in `/private/tmp/snacktrack-api-final.log`, `/private/tmp/snacktrack-app-tests-fixed.log`, `/private/tmp/snacktrack-app-head-tests.log` and `/private/tmp/snacktrack-receipt-db-tests.log`.
