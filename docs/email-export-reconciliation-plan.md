# Email/export reconciliation implementation

## Scope

Preserve email and export observations under one canonical order, match when evidence supports an unambiguous association, and persist the signed checkout difference. Stats and UI presentation will be designed separately.

## Steps and acceptance evidence

1. Retain typed source membership, email revisions, discounts and reported totals. Validate the complete decoder/storage round trip; exports must not erase email evidence or remove unmatched history.
2. Extract matching into a pure policy with evidence reasons. Prefer scoped provider/message identities. Match export/email observations using branch, compatible timestamp roles and independent monetary/basket evidence. Reject competing candidates and distinct provider IDs. Batch matching must see all candidates before committing a fallback association.
3. Reconstruct customization prices with their quantity basis. Persist email total minus export-derived subtotal, including negative and zero results, native currency, inference basis, source references and reasons when unavailable. An email subtotal may validate the export reconstruction, but must not replace the export-derived input silently.
4. Keep source coverage accurate for combined orders. Persist the data in resolution JSON and expose an additive receipt API field for later consumers without creating stats.
5. Add regressions for source/import order permutations, repeated imports, true repeat orders, ambiguous matches, revisions, currencies, missing/zero inputs and signed differences. Run the repository-prescribed API build and app type check if its boundary changes. Inspect current code and run read-only diagnostics; test suites require a separate explicit user request under repository guidance.

## Invariants

- One canonical order can have multiple immutable source observations.
- Financial corrections do not alter real ordered quantities to force agreement.
- Checkout difference is not an independently observed fee or a guarantee of final settlement.
- Unknown currency or missing/invalid subtotal yields an unavailable difference, never fabricated zero.
- Revisions select by observed receipt chronology rather than maximum amount.
- Existing per-user locks, generations, transactions, cache invalidation and deletion cascades remain authoritative.

## Implementation and verification

Implemented locally on 2026-09-11.

| Requirement | Implementation evidence |
| --- | --- |
| Preserve email/export evidence | `ReceiptRepository` appends observations through the same transactional path for email, direct export and staged export. Unmatched history remains. Mutually unique previously unmatched email/export records can be joined after later evidence arrives; observations are reparented before removing the duplicate projection. |
| Match possible pairs | `ReceiptObservationMatching` scopes identities by user/provider, preserves branch specificity and conflicting IDs, and uses bounded placement/delivery time and basket/subtotal/total evidence. Repository matching examines competing batch candidates before association. |
| Retain source and revision truth | `ExtractionResultDecoder` retains adjustments/headline savings; email import records message identity and received chronology. Resolution selects revisions by chronology with a deterministic tie-break, preserving older observations. Source coverage queries count combined orders in both categories. |
| Store signed comparison | `CheckoutDifference` retains email total, export-derived subtotal, currency, source reference, signed result and inference basis. Unknown currency, conflicting currencies or unavailable subtotals have explicit unavailable states. An observed receipt subtotal and its discrepancy are retained separately. |
| Carry data to future consumers | `ReceiptResolution` runtime validation and JSON persistence preserve the comparison; receipt DTO and app runtime normalization carry optional `sources` and `checkoutDifference`. No new stats or display components were introduced. |

The provider-ID uniqueness index is now scoped by user/provider in migration 025. Apply migrations 024 and 025 before using these writers. No live database migration or deployment was performed.

Verification completed:

- API `npm run build` passed; app `npm run type-check` passed.
- All three archives replayed through the parser: 886 Nnamdi Uber orders, 1,150 Naz Uber orders, 64 DoorDash orders; no parse errors. Purchased-line counts remained 1,894 / 2,440 / 124.
- Eight independently transcribed receipt examples were resolved and passed through the persisted JSON decoder and receipt response mapper. Expected export-reconstruction subtotals matched all eight fixture expectations; seven also match the observed receipt subtotal. Papa John's remains estimated with a 7.80 subtotal discrepancy rather than silently substituting receipt pricing.
- The eight diagnostic comparisons retained five positive and three negative differences. These are diagnostic order comparisons, not new fee statistics. Total-only email matching and inferred subtotal calculations do not establish independently observed fees.
- Added API regressions in `email-export-reconciliation.test.js` and `receipt-observation-persistence.test.js`, including import-order permutations, idempotency, mutual ambiguity, later identifying evidence, original-observation retention, rollback, revisions, signed/zero/unavailable comparisons, currency scope and decoder preservation. Added app contract regression coverage in `receiptApiNormalization.test.ts`.
- Following the explicit test request, the complete API suite passed: **342 tests, zero failures, zero skips**, including tests against a disposable PostgreSQL 17 instance. Fresh/legacy migrations, account lifecycle, and the new `receipt-observation-integration.test.js` passed. The latter exercises real repository writes, both import orders, stable IDs, idempotency, revised totals, transaction rollback, later matching, and combined-source email coverage.
- API failures exposed a Canadian bare-dollar inference regression (fixed) and an existing import-delay timestamp precision bug (fixed). Contract assertions now reflect the expanded DTO and current analytics/import metadata.
- App type checking passed. The full app Jest run, using `--watchAll=false --runInBand --watchman=false`, passed **663 tests and failed 35 across 13 suites**. The receipt normalization, receipt money, receipt history/list, dashboard period summary and analytics normalization checks passed. Added the native NetInfo library's supported Jest mock to eliminate invalid native-network-state failures. A committed-HEAD comparison reproduced 34 of the 35 failing test names; the remaining test belongs to separate uncommitted navigation work. See [verification report](receipt-reconciliation-verification.md). The full app suite is **not green**; import UI/contract/mock failures remain separately identified in the verification report.
- No application database was touched. Integration tests ran in temporary schemas on an isolated local PostgreSQL instance; no deployment was performed.

### Remaining evidence limits

The eight screenshots are independent monetary examples, not original email HTML. Matching is deliberately conservative: total-only DoorDash emails cannot use an exported item subtotal as corroboration of a final charge, and delayed/date-only emails without enough independent evidence can remain unmatched. Possible-tip matching is an inferred, bounded association, never a recorded tip. Unknown source currencies remain unavailable for subtraction. The selected email total is an observed email amount, not a guarantee that no later revision will arrive.

Private diagnostic outputs: `/private/tmp/snacktrack-checkout-verified-diagnostic.json` and `/private/tmp/snacktrack-checkout-{nnamdi,naz,doordash}.json`.
