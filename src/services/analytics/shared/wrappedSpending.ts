import { moneySum } from '../../../models/ReceiptResolution';
import type { WrappedSpending } from '../WrappedAnalyticsTypes';
import {
  orderMetricEligibility,
  summarizeOrderMetrics,
  usesOrderEventMetrics,
  type OrderMetricReceipt,
} from './orderMetrics';

/** Money and activity use the same cohort, without inventing prices or FX rates. */
export function wrappedSpending(
  receipts: readonly OrderMetricReceipt[],
  eventMetrics = usesOrderEventMetrics(receipts),
): WrappedSpending {
  if (!eventMetrics) {
    return { totalSpent: moneySum(receipts.map((receipt) => receipt.amountSpent)) };
  }
  const spending = summarizeOrderMetrics(receipts).currencies;
  const only = spending.length === 1 ? spending[0] : undefined;
  return {
    // A scalar is meaningful only for a fully priced, single known currency.
    // The currency buckets still expose known subtotals and unpriced orders.
    totalSpent:
      only && only.currencyCode !== 'UNKNOWN' && only.unknownPriceOrders === 0
        ? only.netSpend
        : null,
    spending,
  };
}

export function wrappedNetAmount(receipt: OrderMetricReceipt): number | null {
  return usesOrderEventMetrics([receipt])
    ? orderMetricEligibility(receipt).netAmount
    : receipt.amountSpent;
}
