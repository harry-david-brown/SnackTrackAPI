import type { ReceiptCurrencyCode } from './Receipt';
/** A document describes an order; it is not itself a purchase or a new payment. */
export type FulfillmentStatus = 'completed' | 'canceled' | 'failed' | 'unfulfilled' | 'unknown';
export type ReceiptDocumentKind =
  'original' | 'updated' | 'refund' | 'cancellation' | 'export' | 'unknown';
export type Tender = 'card' | 'provider_wallet' | 'other' | 'unknown';
export type FinancialEventKind = 'charge' | 'refund' | 'charge_adjustment' | 'refund_reversal';
export type EvidenceConfidence = 'confirmed' | 'inferred' | 'unknown' | 'conflicted';
export type OrderEvidenceParserVersion = 3 | 4;
export const CURRENT_UBER_EXPORT_PARSER_VERSION: OrderEvidenceParserVersion = 4;
export const isOrderEvidenceParserVersion = (value: unknown): value is OrderEvidenceParserVersion => value === 3 || value === 4;

export interface OrderTimestamp {
  role: 'placed' | 'delivered' | 'ended' | 'payment' | 'refund' | 'received';
  raw: string;
  precision: 'day' | 'minute' | 'second';
  /** Only set when timezone interpretation is established, never a guessed offset. */
  instant?: string;
}

export interface PaymentEvidence {
  kind: FinancialEventKind;
  amount: number;
  tender: Tender;
  currencyCode?: ReceiptCurrencyCode;
  /** A provider payment identifier, not an authorization URL or full card number. */
  reference?: string;
  cardLastFour?: string;
  timestamp?: OrderTimestamp;
}

/** Immutable parsed facts. Missing values remain unknown, not zero. */
export interface OrderSourceEvidence {
  version: 1;
  parserVersion: OrderEvidenceParserVersion;
  documentKind: ReceiptDocumentKind;
  fulfillment: FulfillmentStatus;
  rawStatus?: string;
  orderHeaderDay?: string;
  timestamps: OrderTimestamp[];
  recordedTotal: number | null;
  totalState: 'known' | 'blank' | 'invalid' | 'unavailable';
  previousTotal?: number;
  refundAmount?: number;
  /** Affirmative applied-refund notice without a quantified refund event. Absence is unknown. */
  refundConfirmed?: true;
  /** Explicit completed-refund wording about the whole order, not an item or a dollar amount. */
  refundScope?: 'full' | 'partial' | 'conflicted';
  refundReference?: string;
  refundDestination?: Tender;
  /** Explicit provider revision identity if present; never email arrival order. */
  revisionOf?: string;
  courier?: string;
  cancellationReason?: string;
  promotionExplainsZero?: boolean;
  payments: PaymentEvidence[];
  issues: string[];
}

export interface OrderFinancialEvent extends PaymentEvidence {
  key: string;
  confidence: EvidenceConfidence;
  observationIds: string[];
}

/** Derived canonical projection. Source facts above are never overwritten by this result. */
export interface OrderOutcome {
  version: 3;
  fulfillment: FulfillmentStatus;
  fulfillmentConfidence: EvidenceConfidence;
  kind: 'order' | 'unlinked_adjustment';
  refundStatus:
    | 'none_established'
    | 'confirmed_unclassified'
    | 'partial'
    | 'full'
    | 'reversed'
    | 'probable_full'
    | 'zero_unexplained'
    | 'conflicted';
  refundConfidence: EvidenceConfidence;
  originalCharge: number | null;
  netAmount: number | null;
  confirmedRefundAmount: number | null;
  estimatedRefundAmount: number | null;
  cancellationCharge: number | null;
  financialConfidence: EvidenceConfidence;
  financialObservationIds: string[];
  events: OrderFinancialEvent[];
  issues: string[];
}

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Invalid order evidence object');
  return v as Record<string, unknown>;
};
const text = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 4096) throw new Error('Invalid order evidence text');
  return v;
};
const values = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 10000) throw new Error('Invalid order evidence list');
  return v;
};
const amount = (v: unknown): number => {
  if (
    typeof v !== 'number' ||
    !Number.isFinite(v) ||
    v < 0 ||
    v > 1_000_000 ||
    Math.abs(v * 100 - Math.round(v * 100)) > 0.00001
  )
    throw new Error('Invalid order evidence amount');
  return v;
};
const nullableAmount = (v: unknown): number | null => (v === null ? null : amount(v));
const choice = <T extends string>(v: unknown, allowed: readonly T[]): T => {
  const candidate = text(v);
  const found = allowed.find((item) => item === candidate);
  if (found === undefined) throw new Error('Invalid order evidence choice');
  return found;
};
const fulfillment = (v: unknown) =>
  choice(v, ['completed', 'canceled', 'failed', 'unfulfilled', 'unknown'] as const);
const confidence = (v: unknown) =>
  choice(v, ['confirmed', 'inferred', 'unknown', 'conflicted'] as const);
const tender = (v: unknown) => choice(v, ['card', 'provider_wallet', 'other', 'unknown'] as const);

function decodeTimestamp(value: unknown): OrderTimestamp {
  const o = record(value);
  const result: OrderTimestamp = {
    role: choice(o.role, [
      'placed',
      'delivered',
      'ended',
      'payment',
      'refund',
      'received',
    ] as const),
    raw: text(o.raw),
    precision: choice(o.precision, ['day', 'minute', 'second'] as const),
  };
  if (o.instant !== undefined) {
    const instant = text(o.instant);
    if (
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(instant) ||
      !Number.isFinite(Date.parse(instant))
    )
      throw new Error('Invalid evidence instant');
    result.instant = instant;
  }
  return result;
}

function decodePayment(value: unknown): PaymentEvidence {
  const o = record(value);
  const result: PaymentEvidence = {
    kind: choice(o.kind, ['charge', 'refund', 'charge_adjustment', 'refund_reversal'] as const),
    amount: amount(o.amount),
    tender: tender(o.tender),
  };
  if (o.reference !== undefined) result.reference = text(o.reference);
  if (o.currencyCode !== undefined)
    result.currencyCode = choice(o.currencyCode, ['CAD', 'USD', 'EUR', 'GBP', 'UNKNOWN'] as const);
  if (o.cardLastFour !== undefined) {
    result.cardLastFour = text(o.cardLastFour);
    if (!/^\d{4}$/.test(result.cardLastFour)) throw new Error('Invalid masked card evidence');
  }
  if (o.timestamp !== undefined) result.timestamp = decodeTimestamp(o.timestamp);
  return result;
}

export function decodeOrderSourceEvidence(value: unknown): OrderSourceEvidence {
  const o = record(value);
  if (o.version !== 1 || !isOrderEvidenceParserVersion(o.parserVersion))
    throw new Error('Unsupported order source evidence version');
  const result: OrderSourceEvidence = {
    version: 1,
    parserVersion: o.parserVersion,
    documentKind: choice(o.documentKind, [
      'original',
      'updated',
      'refund',
      'cancellation',
      'export',
      'unknown',
    ] as const),
    fulfillment: fulfillment(o.fulfillment),
    timestamps: values(o.timestamps).map(decodeTimestamp),
    recordedTotal: nullableAmount(o.recordedTotal),
    totalState: choice(o.totalState, ['known', 'blank', 'invalid', 'unavailable'] as const),
    payments: values(o.payments).map(decodePayment),
    issues: values(o.issues).map(text),
  };
  if ((result.recordedTotal !== null) !== (result.totalState === 'known'))
    throw new Error('Contradictory order total evidence');
  for (const key of [
    'rawStatus',
    'revisionOf',
    'courier',
    'cancellationReason',
    'refundReference',
  ] as const)
    if (o[key] !== undefined) result[key] = text(o[key]);
  if (o.refundConfirmed !== undefined) {
    if (o.refundConfirmed !== true) throw new Error('Invalid refund confirmation evidence');
    result.refundConfirmed = true;
  }
  if (o.refundScope !== undefined) {
    result.refundScope = choice(o.refundScope, ['full', 'partial', 'conflicted'] as const);
    if (!['refund', 'updated', 'cancellation'].includes(result.documentKind))
      throw new Error('Refund scope requires a refund-bearing document');
  }
  for (const key of ['previousTotal', 'refundAmount'] as const)
    if (o[key] !== undefined) result[key] = amount(o[key]);
  if (o.orderHeaderDay !== undefined) {
    const day = text(o.orderHeaderDay);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day
    )
      throw new Error('Invalid order-header date');
    result.orderHeaderDay = day;
  }
  if (o.refundDestination !== undefined) result.refundDestination = tender(o.refundDestination);
  if (o.promotionExplainsZero !== undefined) {
    if (typeof o.promotionExplainsZero !== 'boolean') throw new Error('Invalid promotion evidence');
    result.promotionExplainsZero = o.promotionExplainsZero;
  }
  return result;
}

export function decodeOrderOutcome(value: unknown): OrderOutcome {
  const o = record(value);
  if (o.version !== 3) throw new Error('Unsupported order outcome version');
  return {
    version: 3,
    fulfillment: fulfillment(o.fulfillment),
    fulfillmentConfidence: confidence(o.fulfillmentConfidence),
    kind: choice(o.kind, ['order', 'unlinked_adjustment'] as const),
    refundStatus: choice(o.refundStatus, [
      'none_established',
      'confirmed_unclassified',
      'partial',
      'full',
      'reversed',
      'probable_full',
      'zero_unexplained',
      'conflicted',
    ] as const),
    refundConfidence: confidence(o.refundConfidence),
    originalCharge: nullableAmount(o.originalCharge),
    netAmount: nullableAmount(o.netAmount),
    confirmedRefundAmount: nullableAmount(o.confirmedRefundAmount),
    estimatedRefundAmount: nullableAmount(o.estimatedRefundAmount),
    cancellationCharge: nullableAmount(o.cancellationCharge),
    financialConfidence: confidence(o.financialConfidence),
    financialObservationIds: values(o.financialObservationIds).map(text),
    issues: values(o.issues).map(text),
    events: values(o.events).map((value) => {
      const e = record(value);
      return {
        ...decodePayment(e),
        key: text(e.key),
        confidence: confidence(e.confidence),
        observationIds: values(e.observationIds).map(text),
      };
    }),
  };
}
