import type { Receipt } from '../../models/Receipt';

export interface ReceiptDeduplicationResult {
  readonly receipts: Receipt[];
  readonly duplicatesFound: number;
  readonly higherAmountReplacements: number;
  readonly totalWithIdentity: number;
  readonly totalBeforeDeduplication: number;
  readonly totalAfterDeduplication: number;
}

const identityFor = (receipt: Receipt): string | null => {
  if (receipt.externalId) return `external:${receipt.externalId}`;
  if (!receipt.orderDate) return null;
  const merchant = receipt.restaurantName?.trim().toLowerCase() || 'unknown';
  return `fallback:${merchant}|${receipt.orderDate.toISOString().slice(0, 16)}`;
};

/** Pure batch deduplication; the highest-total variant wins for tip adjustments. */
export const deduplicateReceipts = (input: readonly Receipt[]): ReceiptDeduplicationResult => {
  const identified = new Map<string, Receipt>();
  const unidentified: Receipt[] = [];
  let duplicatesFound = 0;
  let higherAmountReplacements = 0;

  for (const receipt of input) {
    const identity = identityFor(receipt);
    if (!identity) {
      unidentified.push(receipt);
      continue;
    }
    const existing = identified.get(identity);
    if (!existing) identified.set(identity, receipt);
    else {
      duplicatesFound += 1;
      if (receipt.amountSpent > existing.amountSpent) {
        higherAmountReplacements += 1;
        identified.set(identity, receipt);
      }
    }
  }

  const receipts = [...unidentified, ...identified.values()];
  return {
    receipts,
    duplicatesFound,
    higherAmountReplacements,
    totalWithIdentity: input.filter((receipt) => Boolean(receipt.externalId)).length,
    totalBeforeDeduplication: input.reduce((sum, receipt) => sum + receipt.amountSpent, 0),
    totalAfterDeduplication: receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0),
  };
};
