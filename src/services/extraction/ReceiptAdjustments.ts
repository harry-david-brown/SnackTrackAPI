import type { MoneyAdjustment } from '../../models/ReceiptResolution';
/** Parse explicit adjustment labels only. Savings headlines are never ledger entries. */
export function extractReceiptAdjustments(text: string): MoneyAdjustment[] {
  const definitions: readonly [string, MoneyAdjustment['kind']][] = [
    ['Delivery Discount','delivery_discount'], ['Membership Benefit','membership'],
    ['Special Offers','promotion'], ['Discounts','promotion'], ['Promotion','promotion'],
    ['Credits','credit'], ['Refund','refund'],
  ];
  return definitions.flatMap(([label,kind]) => {
    const match = text.match(new RegExp(`\\b${label}\\b\\s*:?\\s*(-?)\\s*(?:CA\\$|US\\$|\\$|€|£)\\s*(-?)\\s*(\\d+(?:\\.\\d{2})?)`, 'i'));
    return match ? [{ kind, label, amount: -Number(match[3]) }] : [];
  });
}
