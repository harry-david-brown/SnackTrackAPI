import type { Receipt, ReceiptCurrencyCode } from '../../models/Receipt';
import type { OrderOutcome, OrderFinancialEvent } from '../../models/OrderEvidence';
import {
  orderMetricCurrency,
  orderMetricEligibility,
} from '../../services/analytics/shared/orderMetrics';
import { getLocalDateKey } from '../../utils/timezone';

/** Public history facts, not raw source documents or internal reconciliation identities. */
export interface ReceiptOrderOutcomeResponse extends Pick<
  OrderOutcome,
  | 'version'
  | 'fulfillment'
  | 'fulfillmentConfidence'
  | 'refundStatus'
  | 'refundConfidence'
  | 'originalCharge'
  | 'netAmount'
  | 'confirmedRefundAmount'
  | 'estimatedRefundAmount'
  | 'cancellationCharge'
  | 'financialConfidence'
> {
  readonly counting: 'established_order' | 'possible_additional_order' | 'unlinked_adjustment';
  /** Already-local order day. Receipt/payment arrival dates are not substituted. */
  readonly orderDay: string | null;
  readonly events: readonly (Pick<
    OrderFinancialEvent,
    'kind' | 'amount' | 'tender' | 'confidence'
  > & {
    readonly currencyCode: ReceiptCurrencyCode;
  })[];
}

export function mapReceiptOrderOutcome(receipt: Receipt, accountTimezone?: string): ReceiptOrderOutcomeResponse | undefined {
  const outcome = receipt.resolution?.orderOutcome;
  if (!outcome) return undefined;
  const eligibility = orderMetricEligibility(receipt);
  const timezone = receipt.resolution?.timestamp?.timezone ?? accountTimezone;
  return {
    version: outcome.version,
    counting: eligibility.unlinkedAdjustment
      ? 'unlinked_adjustment'
      : eligibility.possibleAdditionalOrder
        ? 'possible_additional_order'
        : 'established_order',
    orderDay:
      !eligibility.unlinkedAdjustment && timezone
        ? getLocalDateKey(receipt.orderDate ?? null, timezone)
        : null,
    fulfillment: outcome.fulfillment,
    fulfillmentConfidence: outcome.fulfillmentConfidence,
    refundStatus: outcome.refundStatus,
    refundConfidence: outcome.refundConfidence,
    originalCharge: outcome.originalCharge,
    netAmount: eligibility.netAmount,
    confirmedRefundAmount: outcome.confirmedRefundAmount,
    estimatedRefundAmount: outcome.estimatedRefundAmount,
    cancellationCharge: outcome.cancellationCharge,
    financialConfidence: outcome.financialConfidence,
    events: outcome.events.map((event) => ({
      kind: event.kind,
      amount: event.amount,
      tender: event.tender,
      confidence: event.confidence,
      currencyCode: event.currencyCode ?? orderMetricCurrency(receipt),
    })),
  };
}
