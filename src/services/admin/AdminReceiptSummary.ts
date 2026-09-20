import { DatabaseError } from '../../core/errors';
import { isOrderMetrics } from '../analytics/shared/orderMetricContracts';
import {
  summarizeOrderMetrics,
  type OrderMetrics,
  type CurrencyOrderMetrics,
  type OrderMetricReceipt,
} from '../analytics/shared/orderMetrics';

export type AdminReceiptSummary = Omit<OrderMetrics, 'currencies'> & {
  receiptRecords: number;
  currencies: Omit<CurrencyOrderMetrics, 'payments'>[];
};
export interface AdminReceiptSource {
  dataSource: 'email' | 'csv';
  receiptType: 'uber_eats' | 'doordash';
  /** Canonical records with this evidence; source buckets overlap and are not additive. */
  count: number;
  unresolvedCount: number;
  establishedOrders: number;
}
export interface AdminReceiptReport {
  summary: AdminReceiptSummary;
  sources: AdminReceiptSource[];
}

export const adminOrderCountFields = [
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
] as const satisfies readonly (keyof OrderMetrics)[];
const moneyFields = [
  'netSpend',
  'deliveredNetSpend',
  'cancellationCost',
  'confirmedRefundAmount',
  'estimatedRefundAmount',
  'possibleAdditionalSpend',
] as const;
const currencyCountFields = [
  'pricedOrders',
  'estimatedPriceOrders',
  'unknownPriceOrders',
  'unpricedPossibleOrders',
  'confirmedRefundsWithUnknownAmount',
] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const invalid = (): never => {
  throw new DatabaseError('Invalid administrator receipt summary');
};
const withoutPayments = ({ payments: _payments, ...currency }: CurrencyOrderMetrics) => currency;

/** Same domain policy as History/Summary; no raw financial or source identifiers are exposed. */
export function summarizeAdminReceipts(
  receipts: readonly OrderMetricReceipt[],
): AdminReceiptSummary {
  const metrics = summarizeOrderMetrics(receipts);
  return {
    ...metrics,
    receiptRecords: receipts.length,
    currencies: metrics.currencies.map(withoutPayments),
  };
}

export function decodeAdminReceiptSummary(value: unknown): AdminReceiptSummary {
  if (!record(value) || !count(value.receiptRecords) || !Array.isArray(value.currencies))
    return invalid();
  const metrics = {
    policyVersion: value.policyVersion,
    ...Object.fromEntries(adminOrderCountFields.map((field) => [field, value[field]])),
    currencies: value.currencies.map((currency) => {
      if (!record(currency)) return invalid();
      return {
        currencyCode: currency.currencyCode,
        payments: [],
        ...Object.fromEntries(
          [...moneyFields, ...currencyCountFields].map((field) => [field, currency[field]]),
        ),
      };
    }),
  };
  if (
    !isOrderMetrics(metrics) ||
    value.receiptRecords !==
      metrics.attempts + metrics.possibleAdditionalOrders + metrics.unlinkedAdjustments
  )
    return invalid();
  return {
    ...metrics,
    receiptRecords: value.receiptRecords,
    currencies: metrics.currencies.map(withoutPayments),
  };
}

export function decodeAdminReceiptSources(value: unknown): AdminReceiptSource[] {
  if (!Array.isArray(value)) return invalid();
  const keys = new Set<string>();
  return value.map((row) => {
    if (
      !record(row) ||
      (row.dataSource !== 'email' && row.dataSource !== 'csv') ||
      (row.receiptType !== 'uber_eats' && row.receiptType !== 'doordash') ||
      !count(row.count) ||
      !count(row.unresolvedCount) ||
      !count(row.establishedOrders) ||
      row.establishedOrders + row.unresolvedCount > row.count
    )
      return invalid();
    const key = `${row.dataSource}:${row.receiptType}`;
    if (keys.has(key)) return invalid();
    keys.add(key);
    return {
      dataSource: row.dataSource,
      receiptType: row.receiptType,
      count: row.count,
      unresolvedCount: row.unresolvedCount,
      establishedOrders: row.establishedOrders,
    };
  });
}

/** Deprecated scalar fields must not combine currencies or turn an unknown balance into zero. */
export function adminReceiptScalarCost(summary: AdminReceiptSummary) {
  if (!summary.receiptRecords) return { total: 0, average: 0, currencyCode: null };
  const currency = summary.currencies.length === 1 ? summary.currencies[0] : undefined;
  if (
    !currency ||
    currency.currencyCode === 'UNKNOWN' ||
    currency.unknownPriceOrders ||
    summary.possibleAdditionalOrders ||
    summary.unlinkedAdjustments
  )
    return { total: null, average: null, currencyCode: null };
  return {
    total: currency.netSpend,
    average: summary.attempts ? Math.round((currency.netSpend * 100) / summary.attempts) / 100 : 0,
    currencyCode: currency.currencyCode,
  };
}
