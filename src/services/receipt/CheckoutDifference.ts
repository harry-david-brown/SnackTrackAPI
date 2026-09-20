import { ReceiptWriteCommand } from '../../models/Receipt';
import { CheckoutDifference, moneySum } from '../../models/ReceiptResolution';

/** A signed comparison of two source observations, not an observed fee. */
export function calculateCheckoutDifference(email: ReceiptWriteCommand | undefined, exported: ReceiptWriteCommand | undefined): CheckoutDifference | undefined {
  if (!email || !exported) return undefined;
  // The compatibility amountSpent placeholder is not a reported email balance.
  if (email.resolution?.orderEvidence?.recordedTotal === null) return undefined;
  const currency = exported.monetaryDetails?.currencyCode ?? 'UNKNOWN';
  const emailCurrency = email.monetaryDetails?.currencyCode ?? 'UNKNOWN';
  const candidate = exported.resolution?.reconstructedSubtotal ??
    (exported.resolution?.amountBasis === 'item_subtotal' ? exported.monetaryDetails?.subtotal : undefined);
  const subtotal = candidate !== undefined && Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
  const reason = currency === 'UNKNOWN' || emailCurrency === 'UNKNOWN' ? 'unknown_currency' :
    currency !== emailCurrency ? 'currency_conflict' : subtotal === null ? 'missing_export_subtotal' : undefined;
  const reconciled = subtotal !== null && email.monetaryDetails?.subtotal !== undefined &&
    moneySum([email.monetaryDetails.subtotal, -subtotal]) === 0;
  return {
    status: reason ? 'unavailable' : 'available',
    amount: reason || subtotal === null ? null : moneySum([email.amountSpent, -subtotal]),
    emailTotal: email.amountSpent, exportSubtotal: subtotal, currencyCode: currency,
    ...(email.monetaryDetails?.subtotal === undefined ? {} : { receiptSubtotal: email.monetaryDetails.subtotal }),
    ...(subtotal === null || email.monetaryDetails?.subtotal === undefined || currency !== emailCurrency || currency === 'UNKNOWN' ? {} : { subtotalDiscrepancy: moneySum([email.monetaryDetails.subtotal,-subtotal]) }),
    subtotalBasis: subtotal === null ? 'unavailable' : reconciled ? 'receipt_reconciled' :
      exported.resolution?.amountBasis === 'item_subtotal' ? 'export_item_subtotal' : 'reconstructed',
    emailSourceMessageId: email.resolution?.sourceMessageId,
    emailRevisionAt: email.resolution?.sourceRevisionAt,
    ...(reason ? { reason } : {}),
  };
}
