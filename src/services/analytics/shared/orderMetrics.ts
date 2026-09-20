import type { ReceiptCurrencyCode } from '../../../models/Receipt';
import type { FulfillmentStatus, Tender } from '../../../models/OrderEvidence';
import { moneySum, type ReceiptResolution } from '../../../models/ReceiptResolution';
import { getLocalDateKey } from '../../../utils/timezone';
import { ACTIVE_RECEIPT_POLICY } from '../../receipt/ReceiptPolicy';

export const ORDER_METRIC_POLICY = 3;

/** Minimal canonical read shape shared by domain receipts and analytics adapters. */
export interface OrderMetricReceipt {
  amountSpent: number;
  dataSource?: string;
  resolution?: ReceiptResolution;
  currencyCode?: string | null;
  monetaryDetails?: { currencyCode?: string };
  orderDate?: Date | null;
  timezone?: string;
}

/** One compatibility gate; explicit policy-3 projections are always interpreted correctly. */
export function usesOrderEventMetrics(receipts: readonly OrderMetricReceipt[]): boolean {
  return (
    Number(ACTIVE_RECEIPT_POLICY) === 3 ||
    receipts.some((r) => r.resolution?.orderOutcome?.version === 3)
  );
}

export function orderMetricCurrency(
  receipt: Pick<OrderMetricReceipt, 'currencyCode' | 'monetaryDetails'>,
): ReceiptCurrencyCode {
  const currency = receipt.monetaryDetails?.currencyCode ?? receipt.currencyCode;
  return currency === 'CAD' || currency === 'USD' || currency === 'EUR' || currency === 'GBP'
    ? currency
    : 'UNKNOWN';
}

/** Date-only receipt text is sufficient for day totals, never for hour-of-day stories. */
export function hasOrderTimeEvidence(receipt: OrderMetricReceipt): boolean {
  const stamp = receipt.resolution?.timestamp;
  return Boolean(receipt.orderDate && stamp?.role === 'placed' && stamp.precision === 'minute');
}

export interface OrderMetricEligibility {
  establishedAttempt: boolean;
  delivered: boolean;
  possibleAdditionalOrder: boolean;
  unlinkedAdjustment: boolean;
  fulfillment: FulfillmentStatus;
  netAmount: number | null;
  estimatedAmount: boolean;
  legacy: boolean;
}

/** One owner for the distinction between order activity, cost and unresolved evidence. */
export function orderMetricEligibility(receipt: OrderMetricReceipt): OrderMetricEligibility {
  const outcome = receipt.resolution?.orderOutcome;
  const unlinkedAdjustment = outcome?.kind === 'unlinked_adjustment';
  const possibleAdditionalOrder =
    !unlinkedAdjustment && receipt.resolution?.reconciliation?.status === 'unresolved';
  const establishedAttempt = !unlinkedAdjustment && !possibleAdditionalOrder;
  const fulfillment = outcome?.fulfillment ?? 'unknown';
  return {
    establishedAttempt,
    delivered: establishedAttempt && fulfillment === 'completed',
    possibleAdditionalOrder,
    unlinkedAdjustment,
    fulfillment,
    netAmount: outcome
      ? outcome.financialConfidence === 'conflicted'
        ? null
        : outcome.netAmount
      : receipt.resolution?.amountBasis === 'item_subtotal'
        ? null
        : receipt.amountSpent,
    estimatedAmount: outcome ? outcome.financialConfidence === 'inferred' : true,
    legacy: outcome === undefined,
  };
}

export interface CurrencyOrderMetrics {
  currencyCode: ReceiptCurrencyCode;
  netSpend: number;
  deliveredNetSpend: number;
  cancellationCost: number;
  confirmedRefundAmount: number;
  estimatedRefundAmount: number;
  possibleAdditionalSpend: number;
  pricedOrders: number;
  estimatedPriceOrders: number;
  unknownPriceOrders: number;
  unpricedPossibleOrders: number;
  confirmedRefundsWithUnknownAmount: number;
  /** Evidence-backed tender flows; never add these to netSpend a second time. */
  payments: TenderOrderMetrics[];
}

export interface TenderOrderMetrics {
  tender: Tender;
  charges: number;
  refunds: number;
  refundReversals: number;
}

export interface OrderMetrics {
  policyVersion: 3;
  attempts: number;
  deliveries: number;
  canceled: number;
  chargedCancellations: number;
  zeroBalanceCancellations: number;
  failed: number;
  unfulfilled: number;
  unknownFulfillment: number;
  confirmedRefunds: number;
  fullyRefunded: number;
  partiallyRefunded: number;
  unclassifiedRefunds: number;
  reversedRefunds: number;
  likelyRefunds: number;
  possibleAdditionalOrders: number;
  unlinkedAdjustments: number;
  legacyOrders: number;
  currencies: CurrencyOrderMetrics[];
}

export function summarizeOrderMetrics(receipts: readonly OrderMetricReceipt[]): OrderMetrics {
  const totals: OrderMetrics = {
    policyVersion: ORDER_METRIC_POLICY,
    attempts: 0,
    deliveries: 0,
    canceled: 0,
    chargedCancellations: 0,
    zeroBalanceCancellations: 0,
    failed: 0,
    unfulfilled: 0,
    unknownFulfillment: 0,
    confirmedRefunds: 0,
    fullyRefunded: 0,
    partiallyRefunded: 0,
    unclassifiedRefunds: 0,
    reversedRefunds: 0,
    likelyRefunds: 0,
    possibleAdditionalOrders: 0,
    unlinkedAdjustments: 0,
    legacyOrders: 0,
    currencies: [],
  };
  const currencies = new Map<ReceiptCurrencyCode, CurrencyOrderMetrics>();
  for (const receipt of receipts) {
    const eligible = orderMetricEligibility(receipt);
    const outcome = receipt.resolution?.orderOutcome;
    if (eligible.unlinkedAdjustment) {
      totals.unlinkedAdjustments++;
      continue;
    }
    const currencyCode = orderMetricCurrency(receipt);
    let currency = currencies.get(currencyCode);
    if (!currency) {
      currency = {
        currencyCode,
        netSpend: 0,
        deliveredNetSpend: 0,
        cancellationCost: 0,
        confirmedRefundAmount: 0,
        estimatedRefundAmount: 0,
        possibleAdditionalSpend: 0,
        pricedOrders: 0,
        estimatedPriceOrders: 0,
        unknownPriceOrders: 0,
        unpricedPossibleOrders: 0,
        confirmedRefundsWithUnknownAmount: 0,
        payments: [],
      };
      currencies.set(currencyCode, currency);
    }
    if (eligible.possibleAdditionalOrder) {
      totals.possibleAdditionalOrders++;
      if (eligible.netAmount === null) currency.unpricedPossibleOrders++;
      else
        currency.possibleAdditionalSpend = moneySum([
          currency.possibleAdditionalSpend,
          eligible.netAmount,
        ]);
      continue;
    }
    totals.attempts++;
    // Outcome events already deduplicate repeated receipt snapshots. Unknown or
    // conflicting allocation stays unallocated; it is not a second order cost.
    for (const event of outcome?.events ?? []) {
      if (event.confidence !== 'confirmed' || event.kind === 'charge_adjustment') continue;
      const eventCurrency = event.currencyCode ?? currencyCode;
      if (eventCurrency !== currencyCode) continue;
      let payment = currency.payments.find((p) => p.tender === event.tender);
      if (!payment) {
        payment = { tender: event.tender, charges: 0, refunds: 0, refundReversals: 0 };
        currency.payments.push(payment);
      }
      const field =
        event.kind === 'charge'
          ? 'charges'
          : event.kind === 'refund'
            ? 'refunds'
            : 'refundReversals';
      payment[field] = moneySum([payment[field], event.amount]);
    }
    if (eligible.legacy) totals.legacyOrders++;
    switch (eligible.fulfillment) {
      case 'completed':
        totals.deliveries++;
        break;
      case 'canceled':
        totals.canceled++;
        if (eligible.netAmount !== null && eligible.netAmount > 0) totals.chargedCancellations++;
        else if (eligible.netAmount === 0) totals.zeroBalanceCancellations++;
        break;
      case 'failed':
        totals.failed++;
        break;
      case 'unfulfilled':
        totals.unfulfilled++;
        break;
      case 'unknown':
        totals.unknownFulfillment++;
        break;
    }
    if (eligible.netAmount === null) currency.unknownPriceOrders++;
    else {
      currency.pricedOrders++;
      if (eligible.estimatedAmount) currency.estimatedPriceOrders++;
      currency.netSpend = moneySum([currency.netSpend, eligible.netAmount]);
      if (eligible.delivered)
        currency.deliveredNetSpend = moneySum([currency.deliveredNetSpend, eligible.netAmount]);
      if (eligible.fulfillment === 'canceled')
        currency.cancellationCost = moneySum([currency.cancellationCost, eligible.netAmount]);
    }
    if (outcome?.refundConfidence === 'confirmed') {
      totals.confirmedRefunds++;
      if (outcome.refundStatus === 'full') totals.fullyRefunded++;
      if (outcome.refundStatus === 'partial') totals.partiallyRefunded++;
      if (
        outcome.refundStatus === 'confirmed_unclassified' ||
        outcome.refundStatus === 'conflicted'
      )
        totals.unclassifiedRefunds++;
      if (outcome.refundStatus === 'reversed') totals.reversedRefunds++;
      if (outcome.confirmedRefundAmount === null) currency.confirmedRefundsWithUnknownAmount++;
      else
        currency.confirmedRefundAmount = moneySum([
          currency.confirmedRefundAmount,
          outcome.confirmedRefundAmount,
        ]);
    }
    if (outcome?.refundStatus === 'probable_full') {
      totals.likelyRefunds++;
      if (outcome.estimatedRefundAmount !== null)
        currency.estimatedRefundAmount = moneySum([
          currency.estimatedRefundAmount,
          outcome.estimatedRefundAmount,
        ]);
    }
  }
  totals.currencies = [...currencies.values()].sort((a, b) =>
    a.currencyCode.localeCompare(b.currencyCode),
  );
  for (const currency of totals.currencies)
    currency.payments.sort((a, b) => a.tender.localeCompare(b.tender));
  return totals;
}

/** Period projections use the same policy, including uncertainty outside the main totals. */
export function summarizeOrderMetricPeriods(
  receipts: readonly OrderMetricReceipt[],
  timezone: string,
) {
  const days = new Map<string, OrderMetricReceipt[]>();
  const months = new Map<string, OrderMetricReceipt[]>();
  let undatedRecords = 0;
  for (const receipt of receipts) {
    const day =
      receipt.orderDate && Number.isFinite(receipt.orderDate.getTime())
        ? getLocalDateKey(
            receipt.orderDate,
            receipt.resolution?.timestamp?.timezone ?? receipt.timezone ?? timezone,
          )
        : null;
    if (!day) {
      undatedRecords++;
      continue;
    }
    days.set(day, [...(days.get(day) ?? []), receipt]);
    const month = day.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), receipt]);
  }
  const project = (groups: Map<string, OrderMetricReceipt[]>) =>
    Object.fromEntries(
      [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, group]) => [key, summarizeOrderMetrics(group)]),
    );
  return { days: project(days), months: project(months), undatedRecords };
}

export type DeliveryDayRanking =
  | {
      status: 'matching';
      reason: 'unresolved_orders' | 'unknown_fulfillment' | 'missing_order_dates';
    }
  | { status: 'empty' }
  | { status: 'available'; day: string; deliveries: number; spending: CurrencyOrderMetrics[] };

/** Withhold an uncertain ranking, not just the currently leading uncertain day. */
export function mostDeliveriesDay(
  receipts: readonly OrderMetricReceipt[],
  timezone: string,
): DeliveryDayRanking {
  if (receipts.some((r) => orderMetricEligibility(r).possibleAdditionalOrder))
    return { status: 'matching', reason: 'unresolved_orders' };
  if (
    receipts.some((r) => {
      const e = orderMetricEligibility(r);
      return e.establishedAttempt && e.fulfillment === 'unknown';
    })
  )
    return { status: 'matching', reason: 'unknown_fulfillment' };
  if (
    receipts.some(
      (r) =>
        orderMetricEligibility(r).delivered &&
        (!r.orderDate || !Number.isFinite(r.orderDate.getTime())),
    )
  )
    return { status: 'matching', reason: 'missing_order_dates' };
  const days = new Map<string, OrderMetricReceipt[]>();
  for (const receipt of receipts) {
    if (!orderMetricEligibility(receipt).delivered || !receipt.orderDate) continue;
    const day = getLocalDateKey(
      receipt.orderDate,
      receipt.resolution?.timestamp?.timezone ?? receipt.timezone ?? timezone,
    );
    if (day) days.set(day, [...(days.get(day) ?? []), receipt]);
  }
  const best = [...days].sort(([a, ar], [b, br]) => br.length - ar.length || a.localeCompare(b))[0];
  return best
    ? {
        status: 'available',
        day: best[0],
        deliveries: best[1].length,
        spending: summarizeOrderMetrics(best[1]).currencies,
      }
    : { status: 'empty' };
}
