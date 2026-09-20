# Reliable email/export reconciliation — policy 2

## Behavior

All mailbox and direct/staged export writes now use the same whole-evidence reconciler. Provider identity wins; conflicting IDs block fallback matching. A unique restaurant/local-day email/export pair does not require similar times or totals. Repeated purchases require mutually unique basket/subtotal evidence or the specified two-hour interval and one-hour separation rule. Matching never removes other candidates merely because an earlier pair matched.

Original observations remain immutable. Re-parsed copies and identifiable revisions are grouped before counting candidates. Prior inferred associations are reconsidered on every affected import, including already combined orders. Unsupported associations can split. Existing canonical references are preserved where possible, with merge/split lineage recorded.

Financial resolution remains separate: email receipt totals and itemized financial evidence take priority; export items, customizations and event times survive. Source amounts and signed discrepancies remain available. Missing evidence is not fabricated.

Restaurant normalization handles Unicode, accents, punctuation, spacing and known boilerplate without unrestricted fuzzy matching. Parenthesized branch names remain distinct; branchless fallback requires uniqueness across all branches that day. Export event timezone wins over account timezone. Date-only and receipt-received timestamps cannot use the precise-time fallback.

## Coverage and provenance

Migration 026 adds immutable import batches, declared/observed coverage, parsing-rejection counts, observation batch provenance, association lineage and repair manifests. The current CSV formats do not declare complete coverage, so their ranges are recorded as **observed**, not exhaustive. Declared interval columns are reserved for explicit provider metadata; separate intervals are never joined by the reconciler.

Legacy exports without batch provenance establish observed ranges only. Unknown historical parsing loss is not proof of complete exports. Unmatched emails remain visible and counted, with explicit ambiguous/no-candidate/identity/currency/incomplete-export reasons. Legacy canonical records without original observations retain their available values; repair does not fetch new mailbox or archive data.

History, dashboard, Summary, Wrapped/share output, import results and admin source summaries expose combined-source or unresolved status as appropriate. Cache invalidation occurs after commit. The existing operation watcher refreshes receipt-derived mobile queries after successful import/repair operations.

## Reviewed account repair

The serving local Docker database was verified against the reported 1,298-order account. The unrelated host database was not used for this repair.

| Measure | Before | After |
| --- | ---: | ---: |
| Canonical orders | 1,298 | 1,142 |
| CAD orders | 1,284 | 1,132 |
| CAD total | 36,289.11 | 31,472.20 |
| USD orders | 14 | 10 |
| USD total | 531.17 | 366.55 |
| Retained source observations | 1,313 | 1,313 |

The policy established 170 same-day associations and split 14 unsupported previous combinations, giving a net reduction of 156 canonical orders. There are 152 unresolved emails: 114 ambiguous and 38 without an export candidate in observed coverage. These remain counted, not silently discarded.

The July 5 Grimaldi's pair is one USD 61.39 order with export item details. December 10 Metro and McDonald's are combined. Pizza Pizza still has two export orders and four unidentified emails; the old email observations lack reliable timestamp precision and provider IDs. That day remains eight counted records totaling CAD 198.97, explicitly subject to the unresolved warning. More source evidence would be needed to safely reduce that count.

Publication succeeded through durable job `25ae3539-a8c5-4e4e-a1f2-e210007b4c8c`, using reviewed manifest `51cc7c36-d887-4b25-ad0d-1c6540be36a6`. The manifest retains original and proposed projections plus evidence membership. The actual Summary and Wrapped calculation services both report 1,142 orders. No unrelated accounts were repaired and no remote deployment was performed.

## Operator workflow

1. Build and apply migrations in the intended serving environment.
2. Run `node dist/scripts/receipt-reconciliation-audit.js USER_UUID --details` for a read-only audit of source counts, candidates, reasons, membership and currency-separated totals.
3. Enqueue `node dist/scripts/receipt-rebuild.js prepare USER_UUID IDEMPOTENCY_KEY`.
4. Review the completed job's manifest and its before/after projections.
5. Enqueue `node dist/scripts/receipt-rebuild.js publish USER_UUID IDEMPOTENCY_KEY MANIFEST_UUID`.
6. Verify serving totals and source retention. Rollback uses the same command with `rollback` and the published manifest UUID.

Publish/rollback require the shared writer lock, matching account generation, policy version and unchanged input fingerprint. Stale manifests are rejected. Job retries after commit are idempotent; cache invalidation can safely retry. Intervening imports require a fresh reviewed plan rather than overwriting newer evidence. Account clear/reset deletes repair snapshots and provenance under the existing reset transaction.

## Verification

- API build, mobile TypeScript and admin TypeScript checks passed.
- Focused API domain/persistence/import/metric tests passed (64 tests).
- Focused real-PostgreSQL reconciliation and account-lifecycle tests passed (4 tests); schemas were isolated from serving data. Includes publish/rollback retries, stale manifests, import-order independence, later splits, retention, and transactional rollback.
- Focused mobile receipt decoding, analytics decoding and history-view suites passed (15 tests; Watchman disabled).
- No full-suite or device/emulator verification is claimed. Refresh the app and check History, the Grimaldi's order, the recap warning, and a subsequent import.
