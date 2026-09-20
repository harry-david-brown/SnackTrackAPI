import { Receipt, ReceiptCurrencyCode } from '../../../models/Receipt';
import { moneySum } from '../../../models/ReceiptResolution';
import {
  orderMetricCurrency,
  orderMetricEligibility,
  usesOrderEventMetrics,
  type OrderMetricReceipt,
} from './orderMetrics';

export function spendingByCurrency(receipts: readonly OrderMetricReceipt[]) {
  const buckets: Record<string, { total: number; count: number }> = {};
  const receiptCounts: Record<string, number> = {};
  const eventMetrics = usesOrderEventMetrics(receipts);
  for (const r of receipts) {
    const eligibility = orderMetricEligibility(r);
    if (eventMetrics && !eligibility.establishedAttempt) continue;
    const currency = orderMetricCurrency(r);
    receiptCounts[currency] = (receiptCounts[currency] ?? 0) + 1;
    const bucket = buckets[currency] ?? { total: 0, count: 0 };
    buckets[currency] = bucket;
    const amount = eventMetrics ? eligibility.netAmount : r.amountSpent;
    if (amount === null) continue;
    bucket.total = moneySum([bucket.total, amount]);
    bucket.count++;
  }
  const primary =
    Object.keys(buckets).sort(
      (a, b) =>
        Number(a === 'UNKNOWN') - Number(b === 'UNKNOWN') ||
        receiptCounts[b] - receiptCounts[a] ||
        buckets[b].count - buckets[a].count ||
        a.localeCompare(b),
    )[0] ?? 'UNKNOWN';
  return { primary, buckets };
}
export function receiptCurrency(receipt: Receipt): ReceiptCurrencyCode {
  return receipt.monetaryDetails?.currencyCode ?? 'UNKNOWN';
}
export const overnightMinute = (minute: number): number =>
  minute < 4 * 60 ? minute + 24 * 60 : minute;

export const currencyOf = (r: {
  currencyCode?: string | null;
  monetaryDetails?: { currencyCode?: string };
}): string => r.monetaryDetails?.currencyCode ?? r.currencyCode ?? 'UNKNOWN';
