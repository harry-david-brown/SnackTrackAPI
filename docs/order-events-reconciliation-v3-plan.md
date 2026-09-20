# Order reconciliation, refunds, cancellations and trustworthy recaps

Status: proposed implementation plan, September 12, 2026. This document does not authorize or perform a data repair. It supersedes policy 2's overly restrictive matching and its completed-order-only interpretation. Existing observations, locks, generations, manifests and canonical references remain the foundation.

## 1. Evidence and scope

The supplied Uber archive contains 903 distinct merchant/placement-time order groups, not 903 CSV rows. Repeated customization rows are parts of an order. Grouping was read-only; no app data or source files were changed.

| Export status | Distinct orders | Explicit zero totals | Positive totals |
| --- | ---: | ---: | ---: |
| completed | 886 | 17 | 869 |
| canceled | 12 | 11 | 1 |
| unfulfilled | 3 | 3 | 0 |
| failed | 2 | 1 | 1 |

No group had a blank total or conflicting repeated Order_Price values in this archive. The positive canceled amount is December 10's $43.26. A failed 2018 order has a positive $17.37 export amount; that is evidence of a recorded amount, not proof a card charge settled.

The screenshots establish one full refund: the $22.48 Pizza Pizza receipt was revised to $0 and refunded to Uber Cash. The corresponding completed export has a zero total. This demonstrates that a refunded completed order can appear as zero. It does not establish that all 17 completed zeros were refunds. Current CSV parsing also turns blank totals into zero; that behavior must be removed.

Known defects: CsvImportService drops every non-completed Uber order; ReceiptDataExtractor can combine a receipt-header date with a time found in the payment section; ReceiptEmailBatchExtractor labels that combined timestamp as placement; stored emails discard available extracted item details; general adjustment parsing misses refund layouts where the label follows the amount; reconciliation lacks receipt-update families without order IDs; analytics count receipt projections indiscriminately.

Scope includes Gmail, Outlook, direct/staged exports, historical reimports, existing-account repair, History, Summary, Home, Wrapped/share and affected admin reporting. Uber findings must not be assumed to apply to DoorDash subtotal exports or to other provider formats without fixtures.

## 2. Domain model: orders, evidence, events and amounts

Keep one canonical order per provider purchase/attempt. Model these independently:

- Fulfillment: completed, canceled, failed, unfulfilled, unknown. Preserve provider raw status. A refund does not turn a delivered order into a canceled order.
- Refund: none established, partial confirmed, full confirmed, probable full refund, zero balance unexplained, disputed evidence. Distinguish amount known from amount unknown; lack of refund evidence is not proof none occurred.
- Document kind: original receipt, updated receipt, refund notice, cancellation notice, export snapshot, unknown receipt.
- Financial events: charge, refund, later tip/charge adjustment, reversal where explicitly supported. An updated receipt is an account of events, not another charge.
- Payment allocation: card, Uber Cash/provider wallet, other, unknown. Retain only the minimal masked/reference evidence needed; no full card data or authorization URLs.
- Association confidence and financial confidence are separate. A clear order identity can coexist with uncertain settlement or pricing.

Persist versioned source observations and separately derived order-event associations. Add typed normalized fulfillment, refund, amount and provenance fields to the canonical read projection. Extend or add cohesive pure owners for receipt-family grouping, order matching, financial-event resolution and metric eligibility; keep SQL in repositories and wiring in ServiceContainer.

Each inferred result records method, policy version, evidence IDs and conflicts. Preserve explicit identity guards, source history and merge/split lineage. Review decisions should be durable evidence/overrides so a subsequent reimport cannot silently reverse them.

## 3. Extract meaningful evidence first

### Exports

- Accept completed, canceled, failed and unfulfilled orders; quarantine unsupported statuses with an explicit count instead of silently dropping them.
- Preserve raw status, item/modifier details, recorded total, currency and snapshot/import date.
- Interpret Uber's Request_Time_Local and Final_Delivery_Time_Local as the documented provider-local convention, not a UTC instant merely because the serialization ends in Z. Preserve raw text and event timezone. For a canceled/failed order the final timestamp is an ending timestamp, not proof of delivery.
- Keep explicit zero, blank, invalid and unavailable totals distinct. A blank must never become a zero/refund. Do not reconstruct a missing final charge from item prices.
- Count non-completed orders as successfully imported attempts, including a file containing only cancellations. Expose counts by status, parsing loss, declared coverage if supplied and observed intervals. Export presence does not prove every order/adjustment is present.

### Emails

- Extract header order date, explicit placed/delivered times, each payment timestamp, refund event time if explicit, and message received time separately. Store raw text, precision and semantic role. Never manufacture placement time from an unrelated payment row.
- Parse provider order IDs from supported order links and receipt identifiers without opening links or retaining their secret query parameters.
- Parse previous total, revised total, refund amount/destination, cancellation charge/reason, payment splits, courier where explicitly present, and available items. Courier and masked payment evidence are supporting facts, never identifiers alone.
- Recognize both refund label-before-amount and amount-before-label layouts. Distinguish a refund from a promotion, wallet payment and savings headline.
- Use explicit update relationships to determine receipt revision order. Received time is supporting chronology, not an unconditional latest-email-wins rule. An older receipt re-forwarded today must not undo a refund.
- Incremental acquisition follows new message events, not just purchase dates. A refund arriving today for last year's order must still update that original order. Audit provider search/classification for refund, cancellation and receipt-update subjects under existing consent.

## 4. Lenient but explainable matching policy

### First group documents about the same email order

Use exact scoped order identity where present. Otherwise link an explicit update to an original receipt when it has the same provider, restaurant and order-header day, the stated previous total matches, and the candidate is unique with supporting original-payment time, receipt reference, courier or basket evidence. A matching total alone cannot join independent original emails.

Refund/original/cancellation documents can arrive in any order. Hold an unlinked refund as an adjustment awaiting association, not as a new delivered purchase. Preserve competing revisions and conflicts. The $22.48 original and the explicit previous-$22.48/new-$0 refund must form one family before export candidates are counted.

### Then match complete restaurant/day groups

Evaluate all original candidates, existing associations and incoming export evidence together. Prefer these independent evidence tiers:

1. Explicit provider order identity. Conflicting known IDs prevent fallback association.
2. Identifiable receipt/update chain combined with a unique export lifecycle/amount match, such as a full-refund family and the sole completed zero-total export, or a cancellation notice matching a canceled export.
3. The unique restaurant/local-day pair, without requiring compatible amounts or nearby timestamps.
4. For multiple orders, a mutually unique exact non-zero final amount within that provider/restaurant/day and compatible lifecycle/currency is sufficient. Time is corroboration, not a veto. This directly resolves the $19.47 pair despite missing timestamp provenance. Comparisons use minor currency units with at most one minor unit of rounding tolerance.
5. Mutually unique baskets or genuinely comparable subtotals, including documented adjustments. DoorDash item subtotal must not be compared as though it were a paid final total. Do not invent a tip/discount to make amounts fit.
6. Broad temporal evidence when stronger evidence cannot decide: use the entire placement-to-ending interval. As initial defaults, precise order/delivery evidence may match up to one hour before placement through four hours after ending; payment/message timing may corroborate within six hours of the interval. Date-only evidence spans the whole event-local day. Unknown provenance lowers weight rather than disabling all matching.

Time-only association requires a mutually unique candidate within its admissible window; overlapping plausible windows remain unresolved. It does not require equal timestamps, second/minute precision, or the previous arbitrary one-hour runner-up gap. Strong non-time same-day evidence can match outside these windows. Defaults are provider-policy settings validated against fixtures, not universal claims about provider delivery behavior.

Preserve branch identity and known conflicting currencies. Branchless fallback still requires uniqueness across branches unless explicit order identity resolves the location. Unknown currency is not a veto but prevents unsupported monetary comparisons. For midnight/payment-date differences, use the receipt's order-header day; where that is missing, consider adjacent event-local days only with independent strong evidence. Explicit identity can associate updates many days later. Never apply a guessed blanket 11/12-hour timezone correction to make records match.

Both sides must independently support an association. No last-pair-by-elimination, unrestricted fuzzy merchant matching or forced perfect assignment. Missing email data is neutral, not a mismatch. Amount, status and revision evidence can differentiate records that time cannot. Re-run affected groups on later evidence and retain reversible lineage if a prior inference becomes unsupported.

## 5. Zero values, refunds and authoritative pricing

Use these rules in order:

- Explicit refund notice or an identifiable reduction from original to updated receipt total establishes a confirmed refund. Full/partial classification is based on the entire known order balance or an unambiguous completed order-level full/partial statement, not the word refund alone. A statement about one item/fee is not a full-order refund. Stated scope does not manufacture a missing refund amount or net balance; current quantified balances/reversals and identifiable revision order remain authoritative, with contradictory descriptions preserved for review.
- Completed export with zero final total and positive item value is a probable-refund signal unless an identified promotion/free order or other contrary evidence explains it. Surface 'Likely refunded — inferred from export' separately from confirmed refunds. If evidence cannot even support that inference, use 'Zero total — reason unknown.'
- Zero canceled/failed/unfulfilled orders indicate a zero recorded balance, not proof money was charged and refunded. Track their fulfillment outcome without inventing a refund.
- Zero item-subtotal data from other provider formats is not automatically a refund signal. Blank/invalid amounts remain unknown.
- Never infer refund dollars from item prices alone. If a unique original $22.48 email corroborates an export zero without the refund email, any inferred $22.48 refund remains explicitly estimated. Confirmed refund totals exclude it.

Replace unconditional email pricing priority with lifecycle-aware resolution: an explicit revised net total outranks an earlier original receipt. A later export snapshot of zero must not be overwritten blindly by an older full-price email. Preserve both and apply the documented inferred-zero policy when explicit refund evidence is absent. A cancellation receipt's final charge outranks an estimated export amount for the same order. Preserve conflicting sources and explain the selected amount.

Keep original charged amount, current net order cost, confirmed/estimated refunds, cancellation charge and tender allocations separately. With complete evidence, net order cost equals charge after discounts plus later charge adjustments minus refunds. Cancellation charges already present in the charge are not added a second time. Revised final totals and refund events must reconcile; do not subtract a refund again from a total that is already net.

Payment rows repeated in an updated receipt are not new payments. Deduplicate provider payment/refund identities where available and resolve snapshots rather than blindly summing rows. Partial refunds, multiple refund installments, fee/tip retention, payment reversals and currency conflicts require explicit cases. Wallet funding and gift-card purchase are not additional order spending.

Uber Cash counts as money spent on the receiving order. A refund to Uber Cash reduces the original order; later spending that balance counts on the new order. Wallet refunds are neither promotions nor additional savings. The app does not claim bank cash-flow/balance reconciliation without complete funding/settlement evidence.

## 6. Shared metrics and product presentation

Build one versioned metric policy consumed by History, Summary, Home, Wrapped, share output, percentiles and admin aggregates. Define:

- Orders placed: distinct canonical attempts of every known status.
- Delivered orders: completed/explicitly delivered orders, including later refunded deliveries.
- Canceled, failed and unfulfilled: distinct separate outcomes; never treated as deliveries or food eaten.
- Net spending: best-supported order costs including wallet payments and charged cancellations/failures, separated by currency and evidence quality. Export-only positive failed amounts are labeled recorded/estimated rather than verified settled charges.
- Refund stats: confirmed count/amount, full/partial, original-payment versus wallet destinations; probable cases shown separately. Do not mix unknown refund amounts into a dollar total.
- Cancellation stats: canceled attempts, zero-balance versus charged cancellations, known cancellation costs. Do not infer who canceled or blame from status alone.

Activity/behavior rankings use eligible delivered orders, not receipt documents or canceled baskets. Canceled items cannot affect favorite food, item quantity, meal count, streak or delivery-wait statistics. Completed refunded orders remain delivery activity; label item stats 'ordered' rather than claiming every item was eaten/correctly received. Restaurant categories such as Metro grocery should be visible; a 'food delivery' claim must not silently include grocery activity.

For 'Laziest day,' prefer the factual title 'Most deliveries in one day'; if the playful title stays, its count and spend must use the same delivered-order cohort. Show cancellation cost separately. Recompute the winning day after repair, never hardcode December 10. Consider a distinct cancellation/refund story when sufficiently supported, using neutral language rather than celebrating disputes or treating refunds as promotional savings.

Unresolved evidence remains inspectable. A known refund/update is an adjustment, never another purchase. An unresolved original-order candidate is labeled and exposed separately from established order counts. Provide a main established total and an explicitly labeled possible-additional amount/count where quantifiable; do not hide evidence or silently count every candidate as certain. Rankings need a provably stable winner across plausible assignments, or a neutral 'still matching orders' state. Excluding only the currently leading ambiguous day is not sufficient.

History shows one card per order with fulfillment/refund badges, original-to-net pricing, payment split and an expandable evidence/event timeline. Add filters for canceled, refunded, likely refunded and unmatched evidence. API/admin expose machine-readable states, confidence, coverage and unresolved counts with backward-compatible optional fields during rollout. Shared app decoders and query invalidation carry those states, not ad-hoc screen calculations. Use existing themed components, navigation and accessible status text; handle loading, empty, error and refreshing explicitly.

Report import results as new attempts, matched/enriched orders, adjustments attached, cancellations recovered and unresolved candidates. Raw message/CSV-row counts remain diagnostics, not unique orders or spending. Compute final job outcomes from distinct affected canonical memberships, not sums of per-page tentative matches.

## 7. December 10 acceptance fixture

Transcribe only the necessary, redacted screenshot evidence; preserve the supplied archive rows as fixture provenance. Screenshots confirm semantics but do not supply actual clickable order IDs or original HTML. Keep those limitations explicit.

| Canonical order | Required evidence membership | Outcome | Net CAD |
| --- | --- | --- | ---: |
| First medium pizza | Completed zero export + original $22.48 receipt + explicit $22.48 refund revision | Delivered, fully refunded to Uber Cash | 0.00 |
| Canceled medium pizza | Canceled $43.26 export + cancellation receipt | Canceled, charged | 43.26 |
| Small pizza | Completed $19.47 export + $19.47 email | Delivered, paid with Uber Cash | 19.47 |
| Metro | Completed export + email | Delivered | 48.46 |
| McDonald's | Completed export + split-payment email | Delivered; $6.22 Uber Cash and $39.61 Visa | 45.83 |

Expected: five attempts, four deliveries, one charged cancellation, one confirmed full refund for $22.48, gross charges $179.50, net total $157.02. Delivered-order net cost is $113.76; cancellation cost is $43.26. Gross tender allocations are $153.81 card and $25.69 Uber Cash, with a separate $22.48 Uber Cash refund. These are recorded order/payment facts, not a reconstruction of the entire wallet account.

No duplicate $22.48 or $19.47 charge; no lost cancellation; no exact-time requirement; no unknown 'eight deliveries' outcome. Evidence supports the archive order chronology; inconsistent email payment timestamps stay preserved as payment facts.

## 8. Implementation sequence and safe repair

1. Lock the above domain/metric contracts and fixtures. Audit every reader of amountSpent, items and receipt counts, including SQL cohorts and import notifications. Add structured diagnostic reasons before widening matches.
2. Add a new immutable migration after the applied migrations. Introduce normalized order outcomes, financial-event/association provenance, staged repair observations and indexed projection fields as needed. Preserve old observations and do not mutate migration 026.
3. Extend export/email extraction and runtime decoders; support every observed Uber status, refund/update layouts, wallet splits and timestamp roles. Verify DoorDash independently. Keep old representations readable during rollout.
4. Implement receipt-family/event resolution and policy-3 complete-group matching in pure domain modules. Reuse the existing store and shared ingestion routes, preserving idempotency, references, re-evaluation and source history.
5. Implement shared monetary and metric projection rules. Update API, mobile and admin together, including caches, notifications and status/quality warnings. Do not expose new outcomes through old unfiltered recap queries.
6. Run a read-only shadow replay of the supplied archive and approved email fixtures. Report matches/splits, confidence, new non-completed attempts, confirmed/probable refunds, unresolved candidates and currency-separated before/after metrics. Compare policy 2 and policy 3 and review unexpected changes.
7. Verify the currently serving environment and account afresh. The previously audited account ID was absent during the latest scoped local check; do not assume the old 1,142-row state still exists or target another account by guesswork.
8. Separate acquisition from repair: existing observations cannot recover canceled rows that were never stored or email fields previously discarded. Reprocess the supplied archive into a staged batch; re-extract retained original messages where allowed. If originals are absent, obtain targeted originals through existing consent/access rules or request them. Do not silently broaden retention or start a new mailbox sweep.
9. Prepare a reviewed manifest containing current evidence/projections, staged acquired evidence, proposed event associations/projections, policy/parser versions and account generation. Fingerprint current and staged inputs. Publication rejects any changed input; old policy-2 manifests cannot publish under policy 3.
10. Publish atomically under the shared writer lock/generation checks. Retain rollback and lineage; support retry after commit, invalidate all derived caches after commit and refetch mobile queries. Reset/delete must remove new events, staging and snapshot copies under the existing lifecycle contract. Rollback must not erase intervening imports or newly acquired immutable evidence.
11. Roll out provider policy and compatible consumers together. No automatic destructive startup backfill or unreviewed multi-account rewrite. Monitor ambiguous groups, inferred-zero cases, event duplication, excluded rankings and failures without logging sensitive receipt content.

## 9. Verification and definition of done

Add focused domain tests for the entire December 10 fixture; original/refund/cancellation arrival permutations; repeated import snapshots; forwarded old receipts; partial/multiple/reversed refunds; original versus wallet refund destinations; promotion-funded zero orders; blank/invalid amounts; positive failed amounts; no-item emails; known/conflicting identities; duplicate totals; repeated same-branch purchases; branchless restaurants; delayed/date-only/unknown-provenance emails; missing headers; midnight, travel and daylight-saving boundaries; currency conflicts; incomplete exports and coverage gaps.

Add real persistence tests for email-first/export-first, complete batch versus pages, staged inputs, concurrent writers, reference stability and lineage, later evidence invalidating matches, transaction rollback, reset generations, manifest staleness, publish/rollback retries, event/source retention and post-commit cache invalidation. Property tests verify input-order invariance, no event/amount double counting, one source event belonging to at most one order, and gross/refund/net reconciliation when evidence is complete.

Add API/mobile/admin contract and pure UI resolver coverage for normal, inferred, ambiguous and partial data. Test every affected analytics cohort and assert that unresolved candidates cannot generate an unjustified superlative. Refunds received in a later month adjust original-order net spend while separately appearing in refund-event reporting; they must not create an order in the refund month.

During implementation run API build and mobile/admin TypeScript checks. Request/include explicit authorization to execute the focused domain/database/mobile suites under repository guidance; do not treat merely adding tests as verification. No emulator/device control without a separate request; supply the user with History/refund/cancellation/recap/reimport manual checks.

Done means the scenario resolves automatically to five attempts and four deliveries with the exact amounts above; less precise emails no longer fail solely on timestamp provenance; source statuses/refunds remain visible; confirmed and inferred facts stay distinguishable; and every surface uses the same canonical orders, financial events and metric definitions.
