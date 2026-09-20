import { createHash } from 'crypto';
import type { Receipt, ReceiptWriteCommand } from '../../models/Receipt';

const stable = (value: unknown): string => {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${stable(field)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

export const evidenceFingerprint = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');

/** Projection IDs are not part of a source document's identity. */
export function receiptDocumentKey(receipt: ReceiptWriteCommand): string {
  const { id: _id, ...payload } = receipt as Receipt;
  return evidenceFingerprint(payload);
}
