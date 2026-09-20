import type { Receipt, ReceiptWriteCommand } from '../../models/Receipt';
import { moneySum } from '../../models/ReceiptResolution';
import { getLocalDateKey } from '../../utils/timezone';
import {
  orderMetricCurrency,
  orderMetricEligibility,
  summarizeOrderMetrics,
  usesOrderEventMetrics,
} from '../analytics/shared/orderMetrics';
import { spendingByCurrency } from '../analytics/shared/receiptMetrics';
import { evidenceFingerprint, receiptDocumentKey } from './ReceiptEvidenceFingerprint';
import type { ExportCoverage, SourceObservation } from './ReceiptGroupReconciler';
import type { RepairSourceProvenance } from './ReceiptRepairSources';
import { currentSourceInterpretations } from './ReceiptSourceInterpretations';
import {
  activeReceiptReviews,
  receiptReviewTips,
  type ReceiptReview,
} from './ReceiptReviewDecisions';

interface AuditSnapshot {
  reviews?: readonly ReceiptReview[];
  receipts: readonly Receipt[];
  observations: readonly SourceObservation[];
  coverage: readonly ExportCoverage[];
  timezone: string;
}
interface AuditSourceBatch {
  id: string;
  parserVersion: number;
  provenance: RepairSourceProvenance;
  observations: readonly SourceObservation[];
  coverage: readonly ExportCoverage[];
}

function localDay(receipt: ReceiptWriteCommand, timezone: string): string | null {
  const stamp = receipt.resolution?.timestamp;
  if (receipt.dataSource === 'email' && receipt.resolution?.orderEvidence?.orderHeaderDay)
    return receipt.resolution.orderEvidence.orderHeaderDay;
  if (stamp?.precision === 'day') return stamp.raw.slice(0, 10);
  return receipt.orderDate ? getLocalDateKey(receipt.orderDate, stamp?.timezone ?? timezone) : null;
}

function observationStates(snapshot: AuditSnapshot) {
  const enabled = snapshot.observations.filter((o) => o.associationEnabled !== false);
  const current = new Set(currentSourceInterpretations(enabled).map((o) => o.id));
  return new Map(
    snapshot.observations.map(
      (o) =>
        [
          o.id,
          o.associationEnabled === false
            ? 'disabled'
            : current.has(o.id)
              ? 'current'
              : 'superseded',
        ] as const,
    ),
  );
}

function itemPriceResolutionSummary(snapshot: AuditSnapshot) {
  const byState: Record<string, number> = {};
  const byYear: Record<string, Record<string, number>> = {};
  let suppressedItemPriceObservations = 0;
  let observations = 0;
  for (const receipt of snapshot.receipts) {
    const year = receipt.orderDate?.getUTCFullYear()?.toString() ?? 'unknown';
    for (const item of receipt.items) {
      const state = item.evidence?.priceResolution?.status;
      if (!state) continue;
      observations++;
      byState[state] = (byState[state] ?? 0) + 1;
      const yearStates = byYear[year] ?? {};
      yearStates[state] = (yearStates[state] ?? 0) + 1;
      byYear[year] = yearStates;
      if (state === 'ambiguous') suppressedItemPriceObservations++;
    }
  }
  return {
    byState,
    byYear,
    observations,
    ambiguousRate: observations ? suppressedItemPriceObservations / observations : 0,
    affectedInsights: { itemFoodflationSuppressedObservations: suppressedItemPriceObservations },
  };
}

function snapshotSummary(snapshot: AuditSnapshot) {
  const states = observationStates(snapshot);
  const sources = new Map<
    string,
    {
      provider: string;
      source: string;
      observations: number;
      current: number;
      superseded: number;
      disabled: number;
    }
  >();
  for (const observation of snapshot.observations) {
    const { receipt } = observation;
    const key = `${receipt.receiptType}:${receipt.dataSource}`;
    const source = sources.get(key) ?? {
      provider: receipt.receiptType,
      source: receipt.dataSource,
      observations: 0,
      current: 0,
      superseded: 0,
      disabled: 0,
    };
    source.observations++;
    source[states.get(observation.id)!]++;
    sources.set(key, source);
  }
  const methods: Record<string, number> = {};
  const unresolvedReasons: Record<string, number> = {};
  for (const receipt of snapshot.receipts) {
    const reconciliation = receipt.resolution?.reconciliation;
    const method = reconciliation?.method ?? 'unclassified';
    methods[method] = (methods[method] ?? 0) + 1;
    if (reconciliation?.status === 'unresolved') {
      const reason = reconciliation.reason ?? 'unspecified';
      unresolvedReasons[reason] = (unresolvedReasons[reason] ?? 0) + 1;
    }
  }
  return {
    projectionRecords: snapshot.receipts.length,
    sourceObservations: snapshot.observations.length,
    projectionsWithoutSourceObservations: snapshot.receipts.filter(
      (r) => !snapshot.observations.some((o) => o.receiptId === r.id),
    ).length,
    // Never count documents as purchases or sum export and email source totals.
    orderMetrics: summarizeOrderMetrics(snapshot.receipts),
    // Allows comparison with the old History header without calling its raw row sums net cost.
    ...(!usesOrderEventMetrics(snapshot.receipts)
      ? {
          legacyProjectionTotals: {
            receiptRecords: snapshot.receipts.length,
            amountsByCurrency: spendingByCurrency(snapshot.receipts).buckets,
          },
        }
      : {}),
    sources: [...sources.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.source.localeCompare(b.source),
    ),
    methods,
    unresolvedReasons,
    itemPriceResolution: itemPriceResolutionSummary(snapshot),
    coverage: snapshot.coverage,
    ...(snapshot.reviews?.length
      ? {
          reviewDecisions: {
            history: snapshot.reviews.length,
            active: activeReceiptReviews(snapshot.reviews).length,
            invalid: new Set(
              snapshot.receipts.flatMap(
                (receipt) => receipt.resolution?.reconciliation?.invalidReviewIds ?? [],
              ),
            ).size,
          },
        }
      : {}),
  };
}

/** Pure review projection over complete evidence. No acquiring, reassociating or publishing here. */
export function buildReceiptReconciliationAudit(
  before: AuditSnapshot,
  after: AuditSnapshot,
  stagedBatches: readonly AuditSourceBatch[] = [],
  includeDetails = false,
  mode: 'preview' | 'manifest' = 'preview',
) {
  const beforeSummary = snapshotSummary(before);
  const afterSummary = snapshotSummary(after);
  const previousSources = new Map(before.observations.map((o) => [o.id, o]));
  const previousReceipts = new Map(before.receipts.map((r) => [r.id!, r]));
  const legacyByDocument = new Map(
    before.receipts
      .filter((r) => !before.observations.some((o) => o.receiptId === r.id))
      .map((r) => [receiptDocumentKey(r), r.id!]),
  );
  const stagedDocuments = new Map<string, string[]>();
  for (const batch of stagedBatches)
    for (const source of batch.observations) {
      const key = receiptDocumentKey(source.receipt);
      stagedDocuments.set(key, [...(stagedDocuments.get(key) ?? []), batch.id]);
    }
  const states = observationStates(after);
  const previousId = (source: SourceObservation) =>
    previousSources.get(source.id)?.receiptId ??
    legacyByDocument.get(receiptDocumentKey(source.receipt));
  const successors = new Map<string, Set<string>>();
  for (const source of after.observations) {
    const predecessor = previousId(source);
    if (!predecessor || !source.receiptId || source.associationEnabled === false) continue;
    const ids = successors.get(predecessor) ?? new Set<string>();
    ids.add(source.receiptId);
    successors.set(predecessor, ids);
  }
  const orders = after.receipts
    .map((receipt) => {
      const sources = after.observations.filter((o) => o.receiptId === receipt.id);
      const previousReceiptIds = [
        ...new Set(sources.map(previousId).filter((id): id is string => !!id)),
      ].sort();
      const outcome = receipt.resolution?.orderOutcome;
      const eligibility = orderMetricEligibility(receipt);
      const existing = previousReceipts.get(receipt.id!);
      return {
        receiptId: receipt.id,
        provider: receipt.receiptType,
        restaurant: receipt.restaurantName,
        localDay: localDay(receipt, after.timezone),
        orderDate: receipt.orderDate,
        deliveryTime: receipt.deliveryTime,
        currency: orderMetricCurrency(receipt),
        netAmount: eligibility.netAmount,
        eligibility,
        outcome,
        reconciliation: receipt.resolution?.reconciliation,
        financialDetails: {
          amountBasis: receipt.resolution?.amountBasis,
          exportTotal: receipt.resolution?.exportedTotal,
          emailTotal: receipt.resolution?.receiptTotal,
          checkoutDifference: receipt.resolution?.checkoutDifference,
          issues: receipt.resolution?.issues ?? [],
        },
        previousReceiptIds,
        mergesPreviousRecords: previousReceiptIds.length > 1,
        splitsPreviousRecord: previousReceiptIds.some((id) => (successors.get(id)?.size ?? 0) > 1),
        changed: !existing || evidenceFingerprint(existing) !== evidenceFingerprint(receipt),
        reviewRequired:
          eligibility.unlinkedAdjustment ||
          receipt.resolution?.reconciliation?.status === 'unresolved' ||
          outcome?.financialConfidence === 'conflicted' ||
          outcome?.refundStatus === 'conflicted' ||
          outcome?.fulfillmentConfidence === 'conflicted' ||
          eligibility.netAmount === null,
        sourceObservationIds: sources.map((o) => o.id).sort(),
        ...(includeDetails
          ? {
              items: receipt.items,
              evidence: sources
                .map((source) => ({
                  id: source.id,
                  previousReceiptId: previousId(source),
                  lastReceiptId: previousSources.get(source.id)?.lastReceiptId,
                  origin: previousSources.has(source.id)
                    ? 'stored'
                    : stagedDocuments.has(receiptDocumentKey(source.receipt))
                      ? 'staged'
                      : mode === 'manifest' &&
                          (source.receipt.resolution?.orderEvidence?.parserVersion ?? 0) >= 3
                        ? 'manifest_source'
                        : 'legacy_projection',
                  stagedBatchIds: stagedDocuments.get(receiptDocumentKey(source.receipt)) ?? [],
                  interpretation: states.get(source.id),
                  provider: source.receipt.receiptType,
                  source: source.receipt.dataSource,
                  restaurant: source.receipt.restaurantName,
                  providerOrderId: source.receipt.externalId,
                  messageId: source.receipt.resolution?.sourceMessageId,
                  localDay: localDay(source.receipt, after.timezone),
                  timestamp: source.receipt.resolution?.timestamp,
                  documentKind: source.receipt.resolution?.orderEvidence?.documentKind ?? 'unknown',
                  fulfillment: source.receipt.resolution?.orderEvidence?.fulfillment ?? 'unknown',
                  parserVersion: source.receipt.resolution?.orderEvidence?.parserVersion ?? 2,
                  // Source values are evidence, not additional canonical spend.
                  recordedAmount: source.receipt.resolution?.orderEvidence
                    ? source.receipt.resolution.orderEvidence.recordedTotal
                    : source.receipt.amountSpent,
                  currency: orderMetricCurrency(source.receipt),
                  amountBasis: source.receipt.resolution?.amountBasis,
                  subtotal: source.receipt.monetaryDetails?.subtotal,
                  previousTotal: source.receipt.resolution?.orderEvidence?.previousTotal,
                  refundAmount: source.receipt.resolution?.orderEvidence?.refundAmount,
                  refundConfirmed: source.receipt.resolution?.orderEvidence?.refundConfirmed,
                  refundScope: source.receipt.resolution?.orderEvidence?.refundScope,
                  refundReference: source.receipt.resolution?.orderEvidence?.refundReference,
                  payments: source.receipt.resolution?.orderEvidence?.payments ?? [],
                  timestamps: source.receipt.resolution?.orderEvidence?.timestamps ?? [],
                  issues: [
                    ...new Set([
                      ...(source.receipt.resolution?.issues ?? []),
                      ...(source.receipt.resolution?.orderEvidence?.issues ?? []),
                    ]),
                  ],
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.localDay ?? '').localeCompare(b.localDay ?? '') ||
        (a.restaurant ?? '').localeCompare(b.restaurant ?? '') ||
        (a.receiptId ?? '').localeCompare(b.receiptId ?? ''),
    );
  const currencies = [
    ...new Set([
      ...beforeSummary.orderMetrics.currencies.map((c) => c.currencyCode),
      ...afterSummary.orderMetrics.currencies.map((c) => c.currencyCode),
    ]),
  ].sort();
  return {
    before: beforeSummary,
    after: afterSummary,
    delta: {
      projectionRecords: after.receipts.length - before.receipts.length,
      changedReceipts: orders.filter((order) => order.changed).length,
      attempts: afterSummary.orderMetrics.attempts - beforeSummary.orderMetrics.attempts,
      deliveries: afterSummary.orderMetrics.deliveries - beforeSummary.orderMetrics.deliveries,
      currencies: currencies.map((currencyCode) => {
        const previous = beforeSummary.orderMetrics.currencies.find(
          (c) => c.currencyCode === currencyCode,
        );
        const proposed = afterSummary.orderMetrics.currencies.find(
          (c) => c.currencyCode === currencyCode,
        );
        return {
          currencyCode,
          knownNetSpend: moneySum([proposed?.netSpend ?? 0, -(previous?.netSpend ?? 0)]),
          unknownPriceOrders:
            (proposed?.unknownPriceOrders ?? 0) - (previous?.unknownPriceOrders ?? 0),
          possibleAdditionalSpend: moneySum([
            proposed?.possibleAdditionalSpend ?? 0,
            -(previous?.possibleAdditionalSpend ?? 0),
          ]),
        };
      }),
    },
    limitations: [
      mode === 'manifest'
        ? 'Saved immutable before/proposed snapshots, not a new reconciliation or the current History. Canonical IDs are fixed. Inspection does not authorize publication; current inputs must be revalidated under the writer lock.'
        : 'Preview only; nothing has been published. New IDs remain provisional until manifest preparation.',
      'Source and projection counts are not purchase counts. Payment tenders are breakdowns, not extra spend.',
      'Possible additional orders and unlinked adjustments are reported separately from established attempts.',
      'Order metrics use policy-3 semantics for both snapshots; legacy projection totals reproduce the old record-based calculation where applicable.',
      'Observed export date ranges are not proof of complete coverage.',
      ...(beforeSummary.orderMetrics.legacyOrders || afterSummary.orderMetrics.legacyOrders
        ? [
            'Legacy outcomes are unknown; before/after delivery and refund counts may reflect newly available evidence, not added purchases.',
          ]
        : []),
    ],
    stagedBatches: stagedBatches.map((batch) => ({
      id: batch.id,
      parserVersion: batch.parserVersion,
      provenance: batch.provenance,
      observationIds: batch.observations.map((o) => o.id).sort(),
      proposedObservationIds: after.observations
        .filter((o) => stagedDocuments.get(receiptDocumentKey(o.receipt))?.includes(batch.id))
        .map((o) => o.id)
        .sort(),
      coverage: batch.coverage,
    })),
    lineage: before.receipts.map((r) => ({
      previousReceiptId: r.id,
      proposedReceiptIds: [...(successors.get(r.id!) ?? [])].sort(),
    })),
    examples: orders.filter(
      (r) =>
        r.localDay === '2023-12-10' ||
        (r.localDay === '2026-07-05' && r.restaurant?.toLowerCase().includes('grimaldi')),
    ),
    ...(includeDetails
      ? {
          orders,
          ...(after.reviews?.length
            ? {
                reviewHistory: after.reviews.map((review) => ({
                  ...review,
                  includedInOriginalSnapshot: Boolean(
                    before.reviews?.some((prior) => prior.id === review.id),
                  ),
                  tipInProposedSnapshot: receiptReviewTips(after.reviews ?? []).some(
                    (tip) => tip.id === review.id,
                  ),
                  invalid: after.receipts.some((receipt) =>
                    receipt.resolution?.reconciliation?.invalidReviewIds?.includes(review.id),
                  ),
                })),
              }
            : {}),
          ...(mode === 'manifest'
            ? {
                originalOrders: before.receipts.map((receipt) => ({
                  receiptId: receipt.id,
                  provider: receipt.receiptType,
                  restaurant: receipt.restaurantName,
                  localDay: localDay(receipt, before.timezone),
                  currency: orderMetricCurrency(receipt),
                  // A legacy display amount is not evidence of settled net cost.
                  recordedProjectionAmount: receipt.amountSpent,
                  eligibility: orderMetricEligibility(receipt),
                  outcome: receipt.resolution?.orderOutcome,
                  reconciliation: receipt.resolution?.reconciliation,
                  items: receipt.items,
                  sourceObservationIds: before.observations
                    .filter((o) => o.receiptId === receipt.id)
                    .map((o) => o.id)
                    .sort(),
                })),
              }
            : {}),
        }
      : {
          reviewCandidates: orders.filter((r) => r.reviewRequired),
        }),
  };
}
