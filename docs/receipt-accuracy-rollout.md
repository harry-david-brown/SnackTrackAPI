# Receipt accuracy implementation and rollout

Initial checkpoint: 2026-09-11. This document describes the code, not a completed production rollout. Matching, outcomes and verification below describe that earlier checkpoint; see [current implementation status](order-events-v3-implementation-status.md) for the policy-3 December/refund work and remaining activation gates.

## Ownership and behavior

- `OrderReconstruction` reconstructs Uber logical lines. Matching signatures are candidates, never sufficient proof. Complementary customization groups preserve their multiplicity: two complete repeated sets remain two meals. Identical or conflicting selections remain separate. An explicit matched subtotal evaluates up to 64 combined/separate hypotheses; final charges alone do not force a merge. Ties prefer fewer unsupported merges.
- `ReceiptResolutionService` merges observations field by field. User and delivery-provider identity scope all matching. A fallback requires compatible merchant, minute, and basket/subtotal evidence. Multiple matching receipts are left separate. Known currencies outrank unknown currencies. No highest-total or export-always-wins rule remains.
- `ReceiptRepository` owns transactional observation persistence for email, direct exports, and staged jobs. Historical email evidence is no longer deleted by export replacement. Observation content keys ignore input ordering without dropping repeated occurrences. Existing receipt IDs survive recognized updates.
- Relevant original export rows, configured prices, source message identity, parser version, import generation, adjustments, and reconciliation residuals survive persistence. Addresses, payment details, and special instructions are not copied into export observations.
- The serving receipt DTO adds optional currency, amount basis, evidence summary, resolution version, configured line total, and inference indication. Existing fields remain compatible.
- Shared calculations distinguish order appearances, purchased quantities, and explicit meal components. They use configured baskets, contextual food classification, branch-specific delivery comparisons, overnight ranking, completed zero-cost activity, and monetary currency buckets. Dashboard, history, and Wrapped disclose exported amounts and avoid silently formatting unknown currency as dollars.
- New candidates cover spending concentration, median versus 90th-percentile delivery time, and an arithmetic decomposition of spending changes. Current-month comparisons use matched calendar days. Missing-history gaps and zero median absolute deviation no longer imply abstinence or identical delivery times.

## Local diagnostic

After the API TypeScript build:

```sh
node scripts/receipt-accuracy-replay.js uber_eats /path/to/archive.zip America/Toronto > /private/tmp/receipt-audit.json
node scripts/receipt-accuracy-replay.js doordash /path/to/archive.zip America/Toronto > /private/tmp/doordash-audit.json
```

CSV inputs are also supported. An optional fourth argument supplies an earlier JSON report. Output contains source rows, canonical quantities and prices, inferred/ambiguous line counts, currency totals, Wrapped calculations, and dashboard candidates. The command has no database or mailbox dependency; temporary extracted files are removed. Output contains private order history and belongs outside committed fixtures.

Observed replay results for the supplied archives:

| Archive | Orders | Completed source rows | Resolved purchased lines | Export amounts |
|---|---:|---:|---:|---|
| Nnamdi Uber | 886 | 2,422 | 1,894 | CAD 23,615.72; USD 0 |
| Naz Uber | 1,150 | 3,062 | 2,440 | CAD 27,077.21 |
| DoorDash | 64 | 124 | 124 | CAD 880.05 (inferred from Canadian postal codes; currency column absent) |

The three original-receipt examples produce the confirmed quantities and subtotals: burgers 40.97, breakfast 22.66, upgraded fries/chicken 15.47. Agreement with exported totals is not verification of final charges. The private replays are diagnostic evidence, not proof that every inferred historical item is correct.

DoorDash replay under both UTC and America/Toronto hosts produces 64 orders, 33 late-night orders, and the same resolved timestamps. The account-timezone fallback remains an inference about source semantics.

## Deployment and historical rebuild

For authorized retained CSV/ZIP sources that were never stored or need re-parsing, use the [retained-export acquisition workflow](receipt-repair-acquisition.md) first. It previews/stages immutable evidence without changing History, and does not bypass the coordinated policy-3 activation gate. Retained-email acquisition is separate.

1. Apply the registered ordered migrations before using their writers. Migration 024 introduced evidence storage; later registered migrations add immutable repair manifests, source staging and order events. Do not edit previously applied migrations. Follow the current implementation status for coordinated activation; policy 3 is not yet serving.
2. Deploy API, worker, and app contracts together. Existing rows remain readable as legacy evidence. New imports immediately retain observations. No rebuild runs at startup.
3. Explicitly enqueue a per-user preparation job:

```sh
node dist/scripts/receipt-rebuild.js prepare USER_UUID IDEMPOTENCY_KEY
```

4. Obtain the prepared `manifestId` from the durable job result and inspect its saved evidence and proposed outcomes:

```sh
node dist/scripts/receipt-reconciliation-audit.js USER_UUID --manifest MANIFEST_UUID --details
```

This is an account-scoped, read-only inspection, not a new reconciliation. It reports original/proposed records, source membership, refunds, cancellation costs, currency totals and current validation issues. `--policy` and `--staged-batches` cannot override saved manifest inputs. A fresh `--policy 3` preview remains a separate diagnostic and cannot be published directly. Legacy evidence limitations and missing retained sources remain explicit; acquiring additional sources is a separate authorized step.
5. Publish only after inspecting differences:

```sh
node dist/scripts/receipt-rebuild.js publish USER_UUID NEW_IDEMPOTENCY_KEY MANIFEST_UUID
```

6. To restore the prepared prior projection:

```sh
node dist/scripts/receipt-rebuild.js rollback USER_UUID ANOTHER_IDEMPOTENCY_KEY MANIFEST_UUID
```

These commands enqueue through PostgreSQL jobs/outbox. The worker uses the shared per-user receipt lock, rechecks the job generation, validates snapshots, and switches a user's serving projection in one transaction. Preparation does not invalidate serving caches; publish/rollback invalidates after commit. A retry after commit is idempotent. Intervening receipt imports invalidate affected snapshots, so a stale candidate cannot overwrite newer evidence.

Receipt/account deletion cascades to observations and projection revisions. Clearing history also removes staged receipt payloads and advances the existing import generation. Prepared snapshots cannot resurrect deleted receipts. Maintenance jobs do not claim newly imported orders or send ordinary new-order notifications.

## Verification and release gates

API `npm run build` and app `npm run type-check` passed. All three private archives were replayed through the real parser and analytics. Diff whitespace checks passed. No production import, migration, rebuild, or emulator session was run.

Added regression cases cover the three manually verified receipts, real repeated meals, explicit quantities, conflicting sides, subtotal-driven alternatives, source permutations, scoped identity, contextual classification, exact total labels, discounts, zero-cost activity, item appearances, and rebuild cache boundaries. Existing expectations for highest-total deduplication, destructive export replacement, cutoff suppression, message/order identity, and partial-month comparison were updated.

Repository guidance requires an explicit request before executing test suites. They have not been executed. Before release, run the focused API/app regressions and exercise migration plus persistence behavior against a disposable PostgreSQL database, including rollback, clear during import/rebuild, unchanged reimports, and stale snapshots. The user handles device verification of history amounts, inferred quantities, Wrapped, and dashboard labels.

## Known data limits

- Export-only final charges and historical unit-versus-line conventions remain best-effort. V1 records its line-price assumption instead of inventing exact missing tips or fees.
- Mailbox receipts without a provider order ID, compatible time, or sufficient basket/subtotal detail may remain unmatched. Preserving two observations as separate orders is preferable to silently deleting a real order; this limitation needs additional matched examples.
- Headline savings are not another ledger deduction. Refunds and credits remain explicit signed observations; no undocumented refund is inferred from a zero total.
- Currency totals remain native. DoorDash currency can be inferred from a Canadian postal pattern or an explicit country in the delivery address; the inference basis is retained without retaining the address. The scalar summary selects the most represented known currency, with all buckets returned separately; no exchange-rate conversion is performed.
- Reviewed private examples establish specific conventions. The remaining inferred lines are not independently verified ground truth.
