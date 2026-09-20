import type { ReceiptItem } from '../../models/Receipt';

/** The sole analytics boundary for item unit prices. */
export function usableItemUnitPrice(
  item: ReceiptItem,
  context?: { receiptType?: string; dataSource?: string },
): number | undefined {
  const resolution = item.evidence?.priceResolution;
  if (resolution) return resolution.status === 'ambiguous' ? undefined : resolution.unitAmount;
  if (context?.receiptType === 'uber_eats' && context.dataSource === 'csv' && item.quantity > 1) return undefined;
  return Number.isFinite(item.price) && item.price >= 0 ? item.price : undefined;
}

export function recordedItemPrice(item: ReceiptItem): number | undefined {
  const recorded = item.evidence?.priceResolution?.recordedAmount;
  return recorded !== undefined && Number.isFinite(recorded) && recorded >= 0 ? recorded : undefined;
}
