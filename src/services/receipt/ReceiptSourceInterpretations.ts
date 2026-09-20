import type { ReceiptWriteCommand } from '../../models/Receipt';
import { evidenceFingerprint } from './ReceiptEvidenceFingerprint';
import { providerId } from './ReceiptObservationMatching';

interface Interpretation {
  id: string;
  receipt: ReceiptWriteCommand;
}

export function sourceDocumentIdentity(source: Interpretation): string {
  const receipt = source.receipt;
  const scope = `${receipt.userId}:${receipt.receiptType}:${receipt.dataSource}:`;
  if (receipt.resolution?.sourceMessageId)
    return `${scope}message:${receipt.resolution.sourceMessageId}`;
  // Same export bytes under a newer parser are a reinterpretation. A changed export
  // amount or provider status is new evidence, not something to silently discard.
  if (receipt.dataSource === 'csv' && receipt.resolution?.rows?.length)
    // Row ordering is not an order identity; repeated rows still retain multiplicity.
    return `${scope}rows:${evidenceFingerprint(receipt.resolution.rows.map(evidenceFingerprint).sort())}`;
  return `${scope}observation:${source.id}`;
}

/** Keep every source in storage; use the newest parser of an identified document for decisions. */
export function currentSourceInterpretations<T extends Interpretation>(sources: readonly T[]): T[] {
  const latest = new Map<string, number>();
  for (const source of sources) {
    const key = sourceDocumentIdentity(source);
    latest.set(
      key,
      Math.max(latest.get(key) ?? 0, source.receipt.resolution?.orderEvidence?.parserVersion ?? 2),
    );
  }
  return sources.filter(
    (source) =>
      (source.receipt.resolution?.orderEvidence?.parserVersion ?? 2) ===
      latest.get(sourceDocumentIdentity(source)),
  );
}

/** Conflicting readings of one immutable document are not evidence of two purchases. */
export function conflictingSourceDocuments(sources: readonly Interpretation[]): Set<string> {
  const identities = new Map<string, Set<string>>();
  for (const source of currentSourceInterpretations(sources)) {
    const id = providerId(source.receipt);
    if (!id) continue;
    const key = sourceDocumentIdentity(source);
    const ids = identities.get(key) ?? new Set<string>();
    ids.add(id);
    identities.set(key, ids);
  }
  return new Set([...identities].filter(([, ids]) => ids.size > 1).map(([key]) => key));
}
