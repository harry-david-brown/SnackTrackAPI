import type { Receipt } from '../../models/Receipt';
import { resolveObservations } from '../receipt/ReceiptResolutionService';
export interface ReceiptDeduplicationResult {
  readonly receipts: Receipt[]; readonly duplicatesFound: number; readonly higherAmountReplacements: number;
  readonly totalWithIdentity: number; readonly totalBeforeDeduplication: number; readonly totalAfterDeduplication: number;
}
/** Batch coalescing uses real provider IDs or message IDs, never merchant/minute alone. */
export const deduplicateReceipts = (input: readonly Receipt[]): ReceiptDeduplicationResult => {
  const groups = new Map<string, Receipt[]>();
  input.forEach((r,index) => {
    const identity = r.externalId ? `order:${r.externalId}` : r.resolution?.sourceMessageId ? `message:${r.resolution.sourceMessageId}` : `unidentified:${index}`;
    const key = `${r.userId}:${r.receiptType}:${identity}`;
    groups.set(key,[...(groups.get(key) ?? []),r]);
  });
  // Preserve all revisions for durable evidence; only exact repeated payloads are removed here.
  const receipts = [...groups.values()].flatMap(group => [...new Map(group.map(r => [JSON.stringify(r),r])).values()]);
  return { receipts, duplicatesFound: input.length-receipts.length, higherAmountReplacements: 0,
    totalWithIdentity: input.filter(r => Boolean(r.externalId)).length,
    totalBeforeDeduplication: input.reduce((s,r) => s+r.amountSpent,0),
    totalAfterDeduplication: [...groups.values()].reduce((s,g) => s+resolveObservations(g).amountSpent,0) };
};
