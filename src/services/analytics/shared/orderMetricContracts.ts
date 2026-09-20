import type { CurrencyOrderMetrics, OrderMetrics } from './orderMetrics';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const money = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;

export function isCurrencyOrderMetrics(value: unknown): value is CurrencyOrderMetrics {
  if (
    !record(value) ||
    !['CAD', 'USD', 'EUR', 'GBP', 'UNKNOWN'].includes(String(value.currencyCode))
  )
    return false;
  if (
    ![
      'netSpend',
      'deliveredNetSpend',
      'cancellationCost',
      'confirmedRefundAmount',
      'estimatedRefundAmount',
      'possibleAdditionalSpend',
    ].every((key) => money(value[key]))
  )
    return false;
  if (
    ![
      'pricedOrders',
      'estimatedPriceOrders',
      'unknownPriceOrders',
      'unpricedPossibleOrders',
      'confirmedRefundsWithUnknownAmount',
    ].every((key) => count(value[key]))
  )
    return false;
  if (Number(value.estimatedPriceOrders) > Number(value.pricedOrders)) return false;
  if (!Array.isArray(value.payments) || value.payments.length > 4) return false;
  const tenders = new Set<unknown>();
  return value.payments.every((payment) => {
    if (
      !record(payment) ||
      !['card', 'provider_wallet', 'other', 'unknown'].includes(String(payment.tender)) ||
      tenders.has(payment.tender)
    )
      return false;
    tenders.add(payment.tender);
    return money(payment.charges) && money(payment.refunds) && money(payment.refundReversals);
  });
}

/** Cached policy-3 data is a versioned contract, not a best-effort bag of numbers. */
export function isOrderMetrics(value: unknown): value is OrderMetrics {
  if (!record(value) || value.policyVersion !== 3) return false;
  if (
    ![
      'attempts',
      'deliveries',
      'canceled',
      'chargedCancellations',
      'zeroBalanceCancellations',
      'failed',
      'unfulfilled',
      'unknownFulfillment',
      'confirmedRefunds',
      'fullyRefunded',
      'partiallyRefunded',
      'unclassifiedRefunds',
      'reversedRefunds',
      'likelyRefunds',
      'possibleAdditionalOrders',
      'unlinkedAdjustments',
      'legacyOrders',
    ].every((key) => count(value[key]))
  )
    return false;
  if (!Array.isArray(value.currencies) || !value.currencies.every(isCurrencyOrderMetrics))
    return false;
  if (new Set(value.currencies.map((c) => c.currencyCode)).size !== value.currencies.length)
    return false;
  return (
    value.attempts ===
      Number(value.deliveries) +
        Number(value.canceled) +
        Number(value.failed) +
        Number(value.unfulfilled) +
        Number(value.unknownFulfillment) &&
    value.attempts ===
      value.currencies.reduce((n, c) => n + c.pricedOrders + c.unknownPriceOrders, 0)
  );
}

export function isOrderMetricPeriods(value: unknown): boolean {
  if (
    !record(value) ||
    !record(value.days) ||
    !record(value.months) ||
    !count(value.undatedRecords)
  )
    return false;
  return (
    Object.entries(value.days).every(
      ([day, metrics]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && isOrderMetrics(metrics),
    ) &&
    Object.entries(value.months).every(
      ([month, metrics]) => /^\d{4}-\d{2}$/.test(month) && isOrderMetrics(metrics),
    )
  );
}
