import { reconstructUberItems } from './OrderReconstruction';
import { DataSource, Receipt, ReceiptWriteCommand, type ReceiptMonetaryDetails } from '../../models/Receipt';
import { moneySum, reconcileMoney, type ReceiptResolution } from '../../models/ReceiptResolution';

import { providerId, matchObservation, isIdentityMatch } from './ReceiptObservationMatching';
import { calculateCheckoutDifference } from './CheckoutDifference';
export { sameOrder, merchantIdentity } from './ReceiptObservationMatching';

const evidenceRank = (r: ReceiptWriteCommand): number =>
  r.resolution?.amountBasis === 'receipt_total' ? 3 : r.dataSource === DataSource.EMAIL ? 2 : 1;
const stable = (r: ReceiptWriteCommand): string => JSON.stringify([r.externalId, r.amountSpent, r.items, r.monetaryDetails, r.resolution?.sourceMessageId, r.dataSource]);

/** Resolve all observations together so ingestion order cannot determine the serving value. */
export function resolveObservations(observations: readonly ReceiptWriteCommand[], id?: string, preferredFinancial?: ReceiptWriteCommand): Receipt {
  if (!observations.length) throw new Error('Receipt requires an observation');
  const subtotalEvidence = [...observations].filter(r => r.dataSource === DataSource.EMAIL && r.monetaryDetails?.subtotal !== undefined).sort((a,b) => (b.resolution?.sourceRevisionAt ?? '').localeCompare(a.resolution?.sourceRevisionAt ?? '') || stable(a).localeCompare(stable(b)))[0];
  const refreshed = observations.map(r => {
    if (r.receiptType !== 'uber_eats' || !r.resolution?.rows?.length) return r;
    const rows = r.resolution.rows;
    if (!rows.every(row => row.Item_Name && Number(row.Item_quantity) > 0 && Number.isFinite(Number(row.Item_Price)))) return r;
    const matchedSubtotal = r.monetaryDetails?.currencyCode && r.monetaryDetails.currencyCode !== 'UNKNOWN' && r.monetaryDetails.currencyCode === subtotalEvidence?.monetaryDetails?.currencyCode ? subtotalEvidence.monetaryDetails.subtotal : undefined;
    if (matchedSubtotal === undefined) return r;
    const items = reconstructUberItems(rows.map(row => ({ Item_Name: row.Item_Name, Item_quantity: row.Item_quantity,
      Item_Price: row.Item_Price, Customizations: row.Customizations ?? '', Customization_Cost_Local: row.Customization_Cost_Local ?? '' })), matchedSubtotal);
    const reconstructedSubtotal = items.every(item => item.evidence?.priceResolution?.status !== 'ambiguous')
      ? moneySum(items.map(item => item.evidence!.configuredLineTotal))
      : undefined;
    const resolution = { ...r.resolution, ...(reconstructedSubtotal === undefined ? {} : { reconstructedSubtotal }) };
    if (reconstructedSubtotal === undefined) delete resolution.reconstructedSubtotal;
    return { ...r, items, resolution };
  });
  const sorted = [...refreshed].sort((a, b) => evidenceRank(b) - evidenceRank(a) || (b.resolution?.version ?? 0) - (a.resolution?.version ?? 0) ||
    (b.resolution?.sourceRevisionAt ?? '').localeCompare(a.resolution?.sourceRevisionAt ?? '') || stable(a).localeCompare(stable(b)));
  if (preferredFinancial) {
    const index = observations.indexOf(preferredFinancial);
    if (index < 0) throw new Error('Financial evidence is not part of this order');
    const selected = refreshed[index];
    sorted.splice(sorted.indexOf(selected), 1);
    sorted.unshift(selected);
  }
  const financial = sorted[0];
  const financialHasTotal = financial.resolution?.orderEvidence?.recordedTotal !== null;
  const exportObservation = sorted.find(r => r.dataSource === DataSource.CSV);
  const emailObservation = sorted.find(r => r.dataSource === DataSource.EMAIL);
  const itemSource = sorted.find(r => r.items.length && r.dataSource === DataSource.CSV) ?? sorted.find(r => r.items.length) ?? financial;
  const financialCurrency = financial.monetaryDetails?.currencyCode;
  const compatible = sorted.filter(r => !financialCurrency || financialCurrency === 'UNKNOWN' || !r.monetaryDetails?.currencyCode || r.monetaryDetails.currencyCode === 'UNKNOWN' || r.monetaryDetails.currencyCode === financialCurrency);
  const details: ReceiptMonetaryDetails = Object.assign({}, ...[...compatible].reverse().map(r => r.monetaryDetails ?? {}));
  details.currencyCode = sorted.find(r => r.monetaryDetails?.currencyCode && r.monetaryDetails.currencyCode !== 'UNKNOWN')?.monetaryDetails?.currencyCode ?? 'UNKNOWN';
  const resolution: ReceiptResolution = { ...(financial.resolution ?? { version: 1 as const, amountBasis: 'legacy' as const, adjustments: [], issues: [] }),
    sources: [...new Set(observations.flatMap(r => [r.dataSource,...(r.resolution?.sources ?? [])]))].sort(),
    checkoutDifference: calculateCheckoutDifference(emailObservation,exportObservation),
    issues: [...new Set(sorted.flatMap(r => r.resolution?.issues ?? []))],
    reconstructedSubtotal: itemSource.resolution?.reconstructedSubtotal,
    exportedTotal: exportObservation?.resolution?.exportedTotal,
    timestamp: exportObservation?.resolution?.timestamp ?? financial.resolution?.timestamp,
    currencyInference: sorted.find(r => r.monetaryDetails?.currencyCode === details.currencyCode)?.resolution?.currencyInference,
  };
  if (emailObservation && exportObservation) {
    const match = matchObservation(exportObservation,emailObservation);
    if (match && !isIdentityMatch(match)) resolution.issues.push(`Email/export association inferred from ${match}`);
  }
  if (!financialHasTotal) {
    delete resolution.receiptTotal;
    delete resolution.financialResidual;
    delete resolution.residual;
  }
  if (details.subtotal !== undefined && resolution.reconstructedSubtotal !== undefined)
    resolution.subtotalResidual = moneySum([details.subtotal,-resolution.reconstructedSubtotal]);
  if (financialHasTotal && details.subtotal !== undefined && [details.tax,details.tip,details.deliveryFee,details.serviceFee].every(value => value !== undefined)) {
    resolution.financialResidual = reconcileMoney(details.subtotal,[details.tax!,details.tip!,details.deliveryFee!,details.serviceFee!],resolution.adjustments,financial.amountSpent);
    if (resolution.financialResidual !== 0) resolution.issues.push('Itemized financial components do not fully explain the reported total');
  }
  if (financialHasTotal && financial.dataSource === DataSource.EMAIL && resolution.exportedTotal !== undefined) {
    resolution.residual = moneySum([financial.amountSpent, -resolution.exportedTotal, -(details.tip ?? 0)]);
    if (resolution.residual !== 0) resolution.issues.push('Receipt and export differ after the observed tip');
  }
  if (!preferredFinancial && new Set(sorted.filter(r => evidenceRank(r) === evidenceRank(financial)).map(r => r.amountSpent)).size > 1)
    resolution.issues.push('Multiple source totals retained; selected by source revision and deterministic evidence order');
  return new Receipt(financial.userId, itemSource.items, financial.amountSpent, financial.receiptType,
    exportObservation?.restaurantName ?? financial.restaurantName,
    exportObservation?.orderDate ?? financial.orderDate,
    exportObservation ? DataSource.CSV : financial.dataSource,
    exportObservation?.deliveryTime ?? financial.deliveryTime,
    sorted.map(providerId).find(Boolean), id, details, resolution);
}
