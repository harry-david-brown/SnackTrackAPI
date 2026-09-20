import { ConflictError } from '../../core/errors';
import type { SourceObservation } from './ReceiptGroupReconciler';
import { evidenceFingerprint, receiptDocumentKey } from './ReceiptEvidenceFingerprint';

export type ReceiptReviewDecision = 'merge' | 'keep_separate' | 'revoke';
export interface ReceiptReview {
  id: string;
  userId: string;
  importGeneration: number;
  decision: ReceiptReviewDecision;
  observationIds: string[];
  supersedesId?: string;
  reason: string;
  reviewer: string;
  createdAt: string;
  /** Pre-workflow audit rows have no bound evidence and never act as overrides. */
  evidence?: { policyVersion: 3; fingerprint: string };
}
export type ReceiptReviewChange = { id: string; reason: string; reviewer: string } & (
  | { decision: 'merge' | 'keep_separate'; observationIds: string[]; supersedesId?: string }
  | { decision: 'revoke'; supersedesId: string }
);
export interface ReceiptReviewContext {
  userId: string;
  importGeneration: number;
  createdAt: string;
}

const invalid = (field: string): never => {
  throw new ConflictError('RECEIPT_REVIEW_INVALID', `Invalid receipt review: ${field}`);
};
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
};
const uuid = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    return invalid(field);
  return value.toLowerCase();
};
const text = (value: unknown, maximum: number, field: string): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    return invalid(field);
  return value.trim();
};
const timestamp = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid('createdAt');
  return value;
};
const observationIds = (value: unknown, minimum = 2): string[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100)
    return invalid('observationIds');
  const result = value.map((id) => uuid(id, 'observationIds')).sort();
  if (new Set(result).size !== result.length) return invalid('duplicate observation ID');
  return result;
};

export function decodeReceiptReviewChanges(value: unknown): ReceiptReviewChange[] {
  if (!Array.isArray(value) || value.length > 100) return invalid('changes');
  const changes = value.map((item): ReceiptReviewChange => {
    const row = record(item, 'change');
    if (
      Object.keys(row).some(
        (key) =>
          !['id', 'reason', 'reviewer', 'decision', 'observationIds', 'supersedesId'].includes(key),
      )
    )
      return invalid('unsupported change field');
    const common = {
      id: uuid(row.id, 'id'),
      reason: text(row.reason, 1024, 'reason'),
      reviewer: text(row.reviewer, 200, 'reviewer'),
    };
    if (row.decision === 'revoke') {
      if (row.observationIds !== undefined) return invalid('revoke observationIds');
      return {
        ...common,
        decision: 'revoke',
        supersedesId: uuid(row.supersedesId, 'supersedesId'),
      };
    }
    if (row.decision !== 'merge' && row.decision !== 'keep_separate') return invalid('decision');
    return {
      ...common,
      decision: row.decision,
      observationIds: observationIds(row.observationIds),
      ...(row.supersedesId === undefined
        ? {}
        : { supersedesId: uuid(row.supersedesId, 'supersedesId') }),
    };
  });
  if (new Set(changes.map((change) => change.id)).size !== changes.length)
    return invalid('duplicate change ID');
  return changes;
}

export function decodeReceiptReview(value: unknown): ReceiptReview {
  const row = record(value, 'review');
  if (
    typeof row.importGeneration !== 'number' ||
    !Number.isSafeInteger(row.importGeneration) ||
    row.importGeneration < 0
  )
    return invalid('importGeneration');
  const [change] = decodeReceiptReviewChanges([
    {
      id: row.id,
      decision: row.decision,
      reason: row.reason,
      reviewer: row.reviewer,
      supersedesId: row.supersedesId,
      ...(row.decision === 'revoke' ? {} : { observationIds: row.observationIds }),
    },
  ]);
  let evidence: ReceiptReview['evidence'];
  if (row.evidence !== undefined) {
    const binding = record(row.evidence, 'evidence');
    if (
      binding.policyVersion !== 3 ||
      typeof binding.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(binding.fingerprint)
    )
      return invalid('evidence');
    evidence = { policyVersion: 3, fingerprint: binding.fingerprint };
  }
  return {
    ...change,
    userId: uuid(row.userId, 'userId'),
    importGeneration: row.importGeneration,
    observationIds: observationIds(row.observationIds, row.decision === 'revoke' ? 0 : 2),
    createdAt: timestamp(row.createdAt),
    ...(evidence ? { evidence } : {}),
  };
}

/** Membership and canonical IDs can change; the reviewed source documents may not. */
export function receiptReviewFingerprint(
  ids: readonly string[],
  sources: readonly SourceObservation[],
): string {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return evidenceFingerprint(
    [...ids].sort().map((id) => {
      const source = byId.get(id);
      return { id, document: source ? receiptDocumentKey(source.receipt) : null };
    }),
  );
}

/** Append-only chains have one tip. A revoked tip never revives its ancestor. */
export function receiptReviewTips(reviews: readonly ReceiptReview[]): ReceiptReview[] {
  const byId = new Map(reviews.map((review) => [review.id, review]));
  if (byId.size !== reviews.length) return invalid('duplicate review ID');
  const superseded = new Set<string>();
  for (const review of reviews) {
    if (!review.supersedesId) continue;
    const parent = byId.get(review.supersedesId);
    if (
      !parent ||
      parent.userId !== review.userId ||
      parent.importGeneration !== review.importGeneration ||
      superseded.has(parent.id)
    )
      return invalid('supersession');
    superseded.add(parent.id);
    const seen = new Set([review.id]);
    let ancestor: ReceiptReview | undefined = parent;
    while (ancestor) {
      if (seen.has(ancestor.id)) return invalid('supersession cycle');
      seen.add(ancestor.id);
      ancestor = ancestor.supersedesId ? byId.get(ancestor.supersedesId) : undefined;
    }
  }
  return reviews
    .filter((review) => !superseded.has(review.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function activeReceiptReviews(reviews: readonly ReceiptReview[]): ReceiptReview[] {
  return receiptReviewTips(reviews).filter(
    (review) => review.decision !== 'revoke' && review.evidence !== undefined,
  );
}

const commandFor = (review: ReceiptReview): ReceiptReviewChange => {
  const common = {
    id: review.id,
    reason: review.reason,
    reviewer: review.reviewer,
    ...(review.supersedesId ? { supersedesId: review.supersedesId } : {}),
  };
  if (review.decision === 'revoke') {
    if (!review.supersedesId) return invalid('revoke supersedesId');
    return { ...common, decision: 'revoke', supersedesId: review.supersedesId };
  }
  return { ...common, decision: review.decision, observationIds: review.observationIds };
};

/** Preparation returns draft history for a manifest. It never mutates published decisions. */
export function prepareReceiptReviews(
  history: readonly ReceiptReview[],
  changes: readonly ReceiptReviewChange[],
  sources: readonly SourceObservation[],
  context: ReceiptReviewContext,
): ReceiptReview[] {
  const userId = uuid(context.userId, 'userId');
  const createdAt = timestamp(context.createdAt);
  if (!Number.isSafeInteger(context.importGeneration) || context.importGeneration < 0)
    return invalid('importGeneration');
  const result = history.map(decodeReceiptReview);
  if (
    result.some(
      (review) => review.userId !== userId || review.importGeneration !== context.importGeneration,
    )
  )
    return invalid('history scope');
  receiptReviewTips(result);
  const bySourceId = new Map(sources.map((source) => [source.id, source]));
  for (const change of decodeReceiptReviewChanges(changes)) {
    const existing = result.find((review) => review.id === change.id);
    if (existing) {
      if (evidenceFingerprint(commandFor(existing)) !== evidenceFingerprint(change))
        throw new ConflictError(
          'RECEIPT_REVIEW_IDEMPOTENCY_CONFLICT',
          'Review ID was already used for different instructions',
        );
      continue;
    }
    const parent = change.supersedesId
      ? result.find((review) => review.id === change.supersedesId)
      : undefined;
    if (change.supersedesId && !parent) return invalid('supersedesId');
    if (parent && result.some((review) => review.supersedesId === parent.id))
      throw new ConflictError(
        'RECEIPT_REVIEW_SUPERSEDED',
        'Review was superseded; inspect its current decision',
      );
    if (change.decision === 'revoke' && !parent) return invalid('revoke supersedesId');
    const ids =
      change.decision === 'revoke' && parent
        ? parent.observationIds
        : change.decision === 'revoke'
          ? invalid('revoke supersedesId')
          : change.observationIds;
    if (
      change.decision !== 'revoke' &&
      ids.some((id) => {
        const source = bySourceId.get(id);
        return !source || source.associationEnabled === false || source.receipt.userId !== userId;
      })
    )
      throw new ConflictError(
        'RECEIPT_REVIEW_SOURCE_UNAVAILABLE',
        'Reviewed source evidence is unavailable for this account',
      );
    const evidence =
      change.decision === 'revoke' && parent?.evidence
        ? parent.evidence
        : { policyVersion: 3 as const, fingerprint: receiptReviewFingerprint(ids, sources) };
    result.push(
      decodeReceiptReview({
        ...change,
        observationIds: ids,
        userId,
        importGeneration: context.importGeneration,
        createdAt,
        evidence,
      }),
    );
    receiptReviewTips(result);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Rollback compensates published tips; all original and superseding audit rows survive. */
export function compensateReceiptReviews(
  original: readonly ReceiptReview[],
  published: readonly ReceiptReview[],
  restoredSources: readonly SourceObservation[],
  context: ReceiptReviewContext & { manifestId: string; createId: () => string },
): ReceiptReview[] {
  const manifestId = uuid(context.manifestId, 'manifestId');
  const before = new Map(original.map((review) => [review.id, review]));
  const after = new Map(published.map((review) => [review.id, review]));
  for (const review of original)
    if (evidenceFingerprint(after.get(review.id)) !== evidenceFingerprint(review))
      throw new ConflictError(
        'RECEIPT_REVIEW_HISTORY_CHANGED',
        'Published review history no longer contains its original decisions',
      );
  const changes = receiptReviewTips(published)
    .filter((tip) => !before.has(tip.id))
    .map((tip): ReceiptReviewChange => {
      let ancestor = tip;
      while (!before.has(ancestor.id) && ancestor.supersedesId) {
        const parent = after.get(ancestor.supersedesId);
        if (!parent) return invalid('rollback supersession');
        ancestor = parent;
      }
      const previous = before.get(ancestor.id);
      const common = {
        id: context.createId(),
        supersedesId: tip.id,
        reviewer: 'system:receipt-repair-rollback',
        reason: `Rollback receipt repair ${manifestId}`,
      };
      return previous?.evidence && previous.decision !== 'revoke'
        ? { ...common, decision: previous.decision, observationIds: previous.observationIds }
        : { ...common, decision: 'revoke' };
    });
  return prepareReceiptReviews(published, changes, restoredSources, context);
}
