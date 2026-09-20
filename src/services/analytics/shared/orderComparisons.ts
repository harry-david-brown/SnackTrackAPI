import type { ReceiptCurrencyCode } from '../../../models/Receipt';
import { getLocalHour, isValidTimezone } from '../../../utils/timezone';
import { spendingByCurrency } from './receiptMetrics';
import {
  hasOrderTimeEvidence,
  orderMetricCurrency,
  orderMetricEligibility,
  summarizeOrderMetrics,
  type OrderMetricReceipt,
} from './orderMetrics';
import { isLateNightHour } from './timeWindows';
import type { WrappedPercentiles } from '../WrappedAnalyticsTypes';
import { isWrappedPercentiles } from './orderComparisonContracts';

/** Comparison eligibility is stricter than displaying best-available totals. */
export interface OrderComparisonProfile {
  currencyCode: ReceiptCurrencyCode;
  netSpend: number | null;
  pricedOrders: number;
  estimatedNetCost: boolean;
  deliveries: number | null;
  timedDeliveries: number;
  nightOwlShare: number | null;
}

export interface OrderComparisonRank {
  /** Strictly lower values; tied users remain together. */
  lowerCount: number;
  sampleSize: number;
}

export interface OrderComparisonRanks {
  policyVersion: 3;
  currencyCode: ReceiptCurrencyCode;
  totalSpent: OrderComparisonRank | null;
  orderCount: OrderComparisonRank | null;
  nightOwl: OrderComparisonRank | null;
  estimatedNetCost: boolean;
}

export interface LegacyPercentileRanks {
  policyVersion?: 2;
  spentRank: number;
  ordersRank: number;
  nightOwlRank: number;
  sampleSize: number;
}

export type WrappedPercentileRanks = OrderComparisonRanks | LegacyPercentileRanks;

/** A stale or mismatched comparison must never qualify an unsupported current metric. */
export function selectOrderComparisonStandings(
  candidate: WrappedPercentiles | undefined,
  profile: OrderComparisonProfile,
): WrappedPercentiles | undefined {
  if (!isWrappedPercentiles(candidate) || candidate.policyVersion !== 3) return undefined;
  const totalSpent =
    profile.netSpend !== null &&
    profile.pricedOrders >= 3 &&
    profile.currencyCode === candidate.currencyCode
      ? candidate.totalSpent
      : undefined;
  const orderCount =
    profile.deliveries !== null && profile.deliveries >= 3 ? candidate.orderCount : undefined;
  const nightOwl =
    profile.nightOwlShare !== null && profile.timedDeliveries >= 3 ? candidate.nightOwl : undefined;
  const sizes = [totalSpent, orderCount, nightOwl].flatMap((s) =>
    s?.sampleSize === undefined ? [] : [s.sampleSize],
  );
  return sizes.length
    ? { ...candidate, totalSpent, orderCount, nightOwl, sampleSize: Math.max(...sizes) }
    : undefined;
}

/** Used for the target snapshot and parity-tested against the SQL peer projection. */
export function buildOrderComparisonProfile(
  receipts: readonly OrderMetricReceipt[],
  timezone: string,
): OrderComparisonProfile {
  const metrics = summarizeOrderMetrics(receipts);
  const currencyCode = orderMetricCurrency({ currencyCode: spendingByCurrency(receipts).primary });
  const currency = metrics.currencies.find((c) => c.currencyCode === currencyCode);
  const settledIdentity = metrics.possibleAdditionalOrders === 0 && metrics.legacyOrders === 0;
  const deliveriesKnown = settledIdentity && metrics.unknownFulfillment === 0;
  const costsKnown =
    settledIdentity &&
    metrics.unlinkedAdjustments === 0 &&
    currencyCode !== 'UNKNOWN' &&
    currency !== undefined &&
    currency.unknownPriceOrders === 0;
  const hours = receipts.flatMap((receipt) => {
    if (
      !orderMetricEligibility(receipt).delivered ||
      !hasOrderTimeEvidence(receipt) ||
      !receipt.orderDate ||
      !Number.isFinite(receipt.orderDate.getTime())
    )
      return [];
    const zone = receipt.resolution?.timestamp?.timezone ?? receipt.timezone ?? timezone;
    // Provider/account event zones are named IANA zones. Do not guess an offset for invalid metadata.
    if (!/^[A-Za-z]/.test(zone) || !isValidTimezone(zone)) return [];
    const hour = getLocalHour(receipt.orderDate, zone);
    return hour === null ? [] : [hour];
  });
  return {
    currencyCode,
    netSpend: costsKnown ? currency.netSpend : null,
    pricedOrders: currency?.pricedOrders ?? 0,
    estimatedNetCost: (currency?.estimatedPriceOrders ?? 0) > 0,
    deliveries: deliveriesKnown ? metrics.deliveries : null,
    timedDeliveries: hours.length,
    nightOwlShare:
      deliveriesKnown && hours.length ? hours.filter(isLateNightHour).length / hours.length : null,
  };
}
