import { decodeOrderOutcome, decodeOrderSourceEvidence, type OrderOutcome, type OrderSourceEvidence } from './OrderEvidence';
/** Source values are retained separately from the serving interpretation. */
export type AmountBasis = 'receipt_total' | 'export_total' | 'item_subtotal' | 'legacy';
export interface MoneyAdjustment {
  kind: 'promotion' | 'membership' | 'delivery_discount' | 'credit' | 'refund' | 'unknown';
  label: string;
  amount: number; // signed; negative reduces payable amount
}
export type ItemPriceResolution =
  | {
      status: 'unit_reconciled' | 'line_reconciled' | 'unit_inferred' | 'line_inferred';
      recordedAmount: number;
      unitAmount: number;
      lineAmount: number;
      reasons: string[];
    }
  | {
      status: 'ambiguous';
      recordedAmount: number;
      reasons: string[];
    };
export interface ItemEvidence {
  /** Internal provenance only. The receipt response mapper must not expose it. */
  priceResolution?: ItemPriceResolution;
  customizationPriceBasis?: 'per_line_assumed' | 'per_item_assumed' | 'per_line_reconciled' | 'per_item_reconciled' | 'unavailable';
  priceBasis?: 'line_assumed' | 'line_reconciled' | 'unit_assumed' | 'unit_reconciled' | 'ambiguous';
  modifierGroups?: { labels: string[]; amount: number }[];
  modifiers?: { label: string; kind: 'addition' | 'removal' | 'substitution' | 'size' | 'selection' | 'unknown'; group: number }[];
  rawName: string;
  configuredName: string;
  baseLineTotal: number;
  configuredLineTotal: number;
  modifierTotal: number;
  method: 'observed' | 'complementary_modifiers' | 'preserved_ambiguous';
  sourceRows: number[];
  alternatives: string[];
  components: { name: string; quantity: number; role: 'side' | 'drink' }[];
}
export interface CheckoutDifference {
  status: 'available' | 'unavailable';
  amount: number | null;
  emailTotal: number;
  exportSubtotal: number | null;
  receiptSubtotal?: number;
  subtotalDiscrepancy?: number;
  currencyCode: string;
  subtotalBasis: 'export_item_subtotal' | 'reconstructed' | 'receipt_reconciled' | 'unavailable';
  emailSourceMessageId?: string;
  emailRevisionAt?: string;
  reason?: 'missing_export_subtotal' | 'unknown_currency' | 'currency_conflict';
}
export interface ReceiptResolution {
  orderEvidence?: OrderSourceEvidence;
  orderOutcome?: OrderOutcome;
  reconciliation?: { policyVersion: number; status: 'merged' | 'standalone' | 'unresolved'; method: string; observationIds: string[]; reason?: string; reviewIds?: string[]; invalidReviewIds?: string[] };
  version: 1;
  amountBasis: AmountBasis;
  exportedTotal?: number;
  receiptTotal?: number;
  reconstructedSubtotal?: number;
  adjustments: MoneyAdjustment[];
  headlineSavings?: number;
  residual?: number;
  financialResidual?: number;
  subtotalResidual?: number;
  issues: string[];
  timestamp?: { raw: string; deliveryRaw?: string; role: 'placed' | 'receipt'; timezone: string; convention: string; precision?: 'day' | 'minute' | 'received' };
  /** Sanitized relevant export fields; excludes addresses and payment details. */
  rows?: Record<string, string>[];
  currencyInference?: 'canadian_postal' | 'explicit_country';
  sourceMessageId?: string;
  sourceRevisionAt?: string;
  sources?: ('email' | 'csv' | 'api')[];
  checkoutDifference?: CheckoutDifference;
}

export const moneySum = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;

export function reconcileMoney(subtotal: number, charges: readonly number[], adjustments: readonly MoneyAdjustment[], total: number): number {
  return moneySum([total, -subtotal, ...charges.map(value => -value), ...adjustments.map(value => -value.amount)]);
}

const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid receipt evidence');
  return v as Record<string, unknown>;
};
const text = (v: unknown): string => { if (typeof v !== 'string') throw new Error('Invalid evidence text'); return v; };
const number = (v: unknown): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid evidence amount'); return v; };
const list = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Error('Invalid evidence list'); return v; };
const choice = <T extends string>(v: unknown, choices: readonly T[]): T => {
  const value = text(v); if (!choices.includes(value as T)) throw new Error('Invalid evidence choice'); return value as T;
};
export function decodeItemEvidence(v: unknown): ItemEvidence {
  const o = object(v);
  return {
    ...(o.priceResolution === undefined ? {} : { priceResolution: decodeItemPriceResolution(o.priceResolution) }),
    ...(o.customizationPriceBasis === undefined ? {} : { customizationPriceBasis: choice(o.customizationPriceBasis, ['per_line_assumed','per_item_assumed','per_line_reconciled','per_item_reconciled','unavailable'] as const) }),
    ...(o.priceBasis === undefined ? {} : { priceBasis: choice(o.priceBasis, ['line_assumed', 'line_reconciled', 'unit_assumed', 'unit_reconciled', 'ambiguous'] as const) }),
    ...(o.modifierGroups === undefined ? {} : { modifierGroups: list(o.modifierGroups).map(value => { const g=object(value); return { labels:list(g.labels).map(text),amount:number(g.amount) }; }) }),
    ...(o.modifiers === undefined ? {} : { modifiers: list(o.modifiers).map(value => { const m=object(value); return { label:text(m.label),kind:choice(m.kind,['addition','removal','substitution','size','selection','unknown'] as const),group:number(m.group) }; }) }),
    rawName: text(o.rawName), configuredName: text(o.configuredName), baseLineTotal: number(o.baseLineTotal),
    configuredLineTotal: number(o.configuredLineTotal), modifierTotal: number(o.modifierTotal),
    method: choice(o.method, ['observed', 'complementary_modifiers', 'preserved_ambiguous']),
    sourceRows: list(o.sourceRows).map(number), alternatives: list(o.alternatives).map(text),
    components: list(o.components).map(value => { const c = object(value); return { name: text(c.name), quantity: number(c.quantity), role: choice(c.role, ['side', 'drink']) }; }) };
}

export function decodeItemPriceResolution(value: unknown): ItemPriceResolution {
  const o = object(value);
  const status = choice(o.status, ['unit_reconciled','line_reconciled','unit_inferred','line_inferred','ambiguous'] as const);
  const recordedAmount = number(o.recordedAmount);
  const reasons = list(o.reasons).map(text);
  if (status === 'ambiguous') return { status, recordedAmount, reasons };
  return { status, recordedAmount, reasons, unitAmount: number(o.unitAmount), lineAmount: number(o.lineAmount) };
}
export function decodeResolution(v: unknown): ReceiptResolution | undefined {
  if (v === null || v === undefined) return undefined;
  const o = object(v);
  if (o.version !== 1) throw new Error('Unsupported receipt evidence version');
  const result: ReceiptResolution = { version: 1, amountBasis: choice(o.amountBasis, ['receipt_total', 'export_total', 'item_subtotal', 'legacy']),
    issues: list(o.issues).map(text), adjustments: list(o.adjustments).map(value => { const a = object(value); return {
      kind: choice(a.kind, ['promotion', 'membership', 'delivery_discount', 'credit', 'refund', 'unknown']), label: text(a.label), amount: number(a.amount) }; }) };
  if (o.orderEvidence !== undefined) result.orderEvidence = decodeOrderSourceEvidence(o.orderEvidence);
  if (o.orderOutcome !== undefined) result.orderOutcome = decodeOrderOutcome(o.orderOutcome);
  for (const field of ['exportedTotal', 'receiptTotal', 'reconstructedSubtotal', 'headlineSavings', 'residual', 'financialResidual', 'subtotalResidual'] as const)
    if (o[field] !== undefined) result[field] = number(o[field]);
  for (const field of ['sourceMessageId', 'sourceRevisionAt'] as const) if (o[field] !== undefined) result[field] = text(o[field]);
  if (o.sources !== undefined) result.sources = list(o.sources).map(v => choice(v, ['email','csv','api'] as const));
  if (o.reconciliation !== undefined) {
    const r = object(o.reconciliation);
    result.reconciliation = { policyVersion:number(r.policyVersion), status:choice(r.status,['merged','standalone','unresolved'] as const), method:text(r.method), observationIds:list(r.observationIds).map(text), ...(r.reason === undefined ? {} : {reason:text(r.reason)}), ...(r.reviewIds === undefined ? {} : {reviewIds:list(r.reviewIds).map(text)}), ...(r.invalidReviewIds === undefined ? {} : {invalidReviewIds:list(r.invalidReviewIds).map(text)}) };
  }
  if (o.checkoutDifference !== undefined) result.checkoutDifference = decodeCheckoutDifference(o.checkoutDifference);
  if (o.currencyInference !== undefined) result.currencyInference = choice(o.currencyInference, ['canadian_postal','explicit_country'] as const);
  if (o.rows !== undefined) result.rows = list(o.rows).map(value => Object.fromEntries(Object.entries(object(value)).map(([k, v]) => [k, text(v)])));
  if (o.timestamp !== undefined) { const t = object(o.timestamp); result.timestamp = { raw: text(t.raw),
    role: choice(t.role, ['placed', 'receipt']), timezone: text(t.timezone), convention: text(t.convention),
    ...(t.precision === undefined ? {} : {precision:choice(t.precision,['day','minute','received'] as const)}),
    ...(t.deliveryRaw === undefined ? {} : { deliveryRaw: text(t.deliveryRaw) }) }; }
  return result;
}

export function decodeCheckoutDifference(value: unknown): CheckoutDifference {
  const o = object(value);
  const status = choice(o.status, ['available','unavailable'] as const);
  const amount = o.amount === null ? null : number(o.amount);
  const exportSubtotal = o.exportSubtotal === null ? null : number(o.exportSubtotal);
  const emailTotal = number(o.emailTotal);
  if (emailTotal < 0 || (exportSubtotal !== null && exportSubtotal < 0)) throw new Error('Invalid checkout input amount');
  if ((status === 'available') !== (amount !== null) || (status === 'available' && (exportSubtotal === null || amount !== moneySum([emailTotal, -exportSubtotal])))) throw new Error('Invalid checkout difference');
  return { status, amount, emailTotal, exportSubtotal, currencyCode: text(o.currencyCode),
    ...(o.receiptSubtotal === undefined ? {} : { receiptSubtotal: number(o.receiptSubtotal) }),
    ...(o.subtotalDiscrepancy === undefined ? {} : { subtotalDiscrepancy: number(o.subtotalDiscrepancy) }),
    subtotalBasis: choice(o.subtotalBasis, ['export_item_subtotal','reconstructed','receipt_reconciled','unavailable'] as const),
    ...(o.emailSourceMessageId === undefined ? {} : { emailSourceMessageId: text(o.emailSourceMessageId) }),
    ...(o.emailRevisionAt === undefined ? {} : { emailRevisionAt: text(o.emailRevisionAt) }),
    ...(o.reason === undefined ? {} : { reason: choice(o.reason, ['missing_export_subtotal','unknown_currency','currency_conflict'] as const) }) };
}

export function decodeAdjustments(value: unknown): MoneyAdjustment[] {
  return list(value).map(value => { const a = object(value); return {
    kind: choice(a.kind, ['promotion','membership','delivery_discount','credit','refund','unknown'] as const),
    label: text(a.label), amount: number(a.amount) }; });
}
