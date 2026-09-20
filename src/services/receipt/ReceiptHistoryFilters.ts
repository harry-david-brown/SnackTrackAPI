import type { OrderMetricReceipt } from '../analytics/shared/orderMetrics';
import { orderMetricEligibility } from '../analytics/shared/orderMetrics';

export const RECEIPT_OUTCOME_FILTERS = [
  'delivered',
  'canceled',
  'refunded',
  'possible_refund',
  'failed',
  'unfulfilled',
  'needs_review',
  'unknown_cost',
] as const;
export type ReceiptOutcomeFilter = (typeof RECEIPT_OUTCOME_FILTERS)[number];

/** Canonical filter policy; the paginated SQL adapter is parity-tested against this owner. */
export function matchesReceiptOutcome(
  receipt: OrderMetricReceipt,
  filter: ReceiptOutcomeFilter,
): boolean {
  const eligible = orderMetricEligibility(receipt);
  const outcome = receipt.resolution?.orderOutcome;
  switch (filter) {
    case 'delivered':
      return eligible.delivered;
    case 'canceled':
      return eligible.establishedAttempt && eligible.fulfillment === 'canceled';
    case 'failed':
      return eligible.establishedAttempt && eligible.fulfillment === 'failed';
    case 'unfulfilled':
      return eligible.establishedAttempt && eligible.fulfillment === 'unfulfilled';
    case 'refunded':
      return eligible.establishedAttempt && outcome?.refundConfidence === 'confirmed';
    case 'possible_refund':
      return eligible.establishedAttempt && outcome?.refundStatus === 'probable_full';
    case 'unknown_cost':
      return !eligible.unlinkedAdjustment && eligible.netAmount === null;
    case 'needs_review':
      return (
        eligible.unlinkedAdjustment ||
        receipt.resolution?.reconciliation?.status === 'unresolved' ||
        outcome?.financialConfidence === 'conflicted' ||
        outcome?.fulfillmentConfidence === 'conflicted' ||
        outcome?.refundStatus === 'conflicted'
      );
  }
}
