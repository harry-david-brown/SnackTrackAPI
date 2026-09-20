import { DataSource, ReceiptWriteCommand } from '../../models/Receipt';
import { moneySum } from '../../models/ReceiptResolution';

export const merchantIdentity = (name?: string): string =>
  (name ?? '').normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const providerId = (r: ReceiptWriteCommand): string | undefined =>
  r.externalId && !/^doordash:(?:gmail|microsoft):/.test(r.externalId) ? r.externalId : undefined;
export type MatchEvidence = 'provider_id' | 'message_id' | 'export_identity' | 'branch_time_basket' | 'branch_time_subtotal' | 'branch_time_total' | 'branch_time_possible_tip';
export const isIdentityMatch = (evidence: MatchEvidence | undefined): boolean =>
  evidence === 'provider_id' || evidence === 'message_id' || evidence === 'export_identity';

/** Fallbacks are candidates only. The repository must reject competing candidates. */
export function matchObservation(a: ReceiptWriteCommand, b: ReceiptWriteCommand): MatchEvidence | undefined {
  if (a.userId !== b.userId || a.receiptType !== b.receiptType) return undefined;
  if (providerId(a) && providerId(b)) return providerId(a) === providerId(b) ? 'provider_id' : undefined;
  if (a.resolution?.sourceMessageId && a.resolution.sourceMessageId === b.resolution?.sourceMessageId) return 'message_id';
  const ac = a.monetaryDetails?.currencyCode, bc = b.monetaryDetails?.currencyCode;
  if (ac && bc && ac !== 'UNKNOWN' && bc !== 'UNKNOWN' && ac !== bc) return undefined;
  if (!a.orderDate || !b.orderDate || !merchantIdentity(a.restaurantName) || merchantIdentity(a.restaurantName) !== merchantIdentity(b.restaurantName)) return undefined;
  const delta = Math.abs(a.orderDate.getTime() - b.orderDate.getTime());
  if (!Number.isFinite(delta)) return undefined;
  if (a.dataSource === DataSource.CSV && b.dataSource === DataSource.CSV) return delta === 0 ? 'export_identity' : undefined;
  // Independent email receipts can represent distinct purchases, even with identical totals.
  if (a.dataSource !== DataSource.CSV && b.dataSource !== DataSource.CSV) return undefined;
  const exported = a.dataSource === DataSource.CSV ? a : b;
  const email = a.dataSource === DataSource.EMAIL ? a : b.dataSource === DataSource.EMAIL ? b : undefined;
  if (!email) return undefined;
  // Placement times must be close. A receipt may instead use its payment/delivery time;
  // allow that only when it falls inside the export's observed order/delivery interval.
  const placement = exported.orderDate!.getTime();
  const delivered = exported.deliveryTime?.getTime();
  const emailTime = email.orderDate!.getTime();
  const nearPlacement = delta <= 90_000;
  const duringOrder = Number.isFinite(delivered) && delivered! >= placement &&
    delivered! - placement <= 6 * 60 * 60_000 && emailTime >= placement - 90_000 && emailTime <= delivered! + 30 * 60_000;
  if (!nearPlacement && !duringOrder) return undefined;
  const basket = (r: ReceiptWriteCommand) => r.items.map(i => `${merchantIdentity(i.evidence?.rawName ?? i.name)}:${i.quantity}`).sort().join('|');
  if (a.items.length && b.items.length && basket(a) === basket(b)) return 'branch_time_basket';
  const subtotal = exported.resolution?.reconstructedSubtotal ?? exported.monetaryDetails?.subtotal;
  if (subtotal !== undefined && email.monetaryDetails?.subtotal !== undefined && Math.abs(moneySum([subtotal,-email.monetaryDetails.subtotal])) <= .01) return 'branch_time_subtotal';
  // DoorDash exports contain item subtotals, so they cannot corroborate a paid total.
  if (exported.resolution?.amountBasis !== 'export_total') return undefined;
  const total = exported.resolution.exportedTotal ?? exported.amountSpent;
  const observedTip = email.monetaryDetails?.tip;
  const residual = moneySum([email.amountSpent,-total,-(observedTip ?? 0)]);
  if (Math.abs(residual) <= .15) return 'branch_time_total';
  // Total-only emails can include an unitemized tip. This bounded candidate policy
  // does not invent or persist a tip; positive differences still need mutual uniqueness.
  if (observedTip === undefined && total > 0 && residual > 0 && residual <= Math.min(10,Math.max(3,total*.25))) return 'branch_time_possible_tip';
  return undefined;
}

export const sameOrder = (a: ReceiptWriteCommand, b: ReceiptWriteCommand): boolean => Boolean(matchObservation(a,b));
