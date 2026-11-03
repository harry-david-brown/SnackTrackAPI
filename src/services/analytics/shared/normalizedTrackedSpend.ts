import type { DisplayCurrency, RecapRateSnapshot } from '../../ports/RecapExchangeRatesPort';

/** Convert known net costs without treating missing rates or unknown currencies as zero. */
export function normalizeTrackedSpend(
  buckets: Record<string, { total: number; count: number }>,
  currencyCode: DisplayCurrency,
  snapshot?: RecapRateSnapshot,
): { amount: number | null; currencyCode: DisplayCurrency; approximate: boolean } {
  let amount = 0;
  let approximate = false;
  for (const [source, bucket] of Object.entries(buckets)) {
    if (bucket.count === 0 || bucket.total === 0) continue;
    if (source === currencyCode) {
      amount += bucket.total;
      continue;
    }
    const from = snapshot?.rates[source as DisplayCurrency];
    const to = snapshot?.rates[currencyCode];
    if (!from || !to || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
      return { amount: null, currencyCode, approximate: false };
    }
    amount += bucket.total * to / from;
    approximate = true;
  }
  const hasPricedOrders = Object.values(buckets).some(bucket => bucket.count > 0);
  return {
    amount: !hasPricedOrders && Object.keys(buckets).length > 0 ? null : Math.round((amount + Number.EPSILON) * 100) / 100,
    currencyCode,
    approximate,
  };
}
