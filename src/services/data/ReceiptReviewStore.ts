import { ConflictError } from '../../core/errors';
import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import { evidenceFingerprint } from '../receipt/ReceiptEvidenceFingerprint';
import {
  decodeReceiptReview,
  receiptReviewTips,
  type ReceiptReview,
} from '../receipt/ReceiptReviewDecisions';

/** Published decisions only. Drafts live exclusively in immutable repair manifests. */
export async function loadReceiptReviews(
  tx: DatabaseQueryExecutor,
  userId: string,
): Promise<ReceiptReview[]> {
  const result = await tx.query(
    `SELECT r.* FROM receipt_association_reviews r
    JOIN users u ON u.id=r.user_id AND u.import_generation=r.import_generation
    WHERE r.user_id=$1 ORDER BY r.id`,
    [userId],
  );
  return result.rows.map((row) =>
    decodeReceiptReview({
      id: row.id,
      userId: row.user_id,
      importGeneration: Number(row.import_generation),
      decision: row.decision,
      observationIds: row.observation_ids,
      ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
      reason: row.reason,
      reviewer: row.reviewer,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      ...(row.evidence === null ? {} : { evidence: row.evidence }),
    }),
  );
}

/** Caller holds the shared writer lock and user row lock in its projection transaction. */
export async function appendReceiptReviews(
  tx: DatabaseQueryExecutor,
  userId: string,
  before: readonly ReceiptReview[],
  after: readonly ReceiptReview[],
): Promise<void> {
  const history = after.map(decodeReceiptReview);
  receiptReviewTips(history);
  if (
    history.some((review) => review.userId !== userId) ||
    before.some(
      (review) =>
        evidenceFingerprint(history.find((next) => next.id === review.id)) !==
        evidenceFingerprint(review),
    )
  )
    throw new ConflictError(
      'RECEIPT_REVIEW_HISTORY_CHANGED',
      'A repair cannot replace published review history',
    );
  const saved = new Set(before.map((review) => review.id));
  while (saved.size < history.length) {
    const pending = history.filter(
      (review) => !saved.has(review.id) && (!review.supersedesId || saved.has(review.supersedesId)),
    );
    if (!pending.length)
      throw new ConflictError('RECEIPT_REVIEW_INVALID', 'Invalid review supersession');
    for (const review of pending) {
      const inserted = await tx.query(
        `INSERT INTO receipt_association_reviews
        (id,user_id,import_generation,decision,observation_ids,supersedes_id,reason,reviewer,created_at,evidence)
        SELECT $1::uuid,u.id,$3::integer,$4,$5::uuid[],$6::uuid,$7,$8,$9::timestamptz,$10::jsonb FROM users u
        WHERE u.id=$2::uuid AND u.import_generation=$3::integer RETURNING id`,
        [
          review.id,
          userId,
          review.importGeneration,
          review.decision,
          review.observationIds,
          review.supersedesId ?? null,
          review.reason,
          review.reviewer,
          review.createdAt,
          JSON.stringify(review.evidence ?? null),
        ],
      );
      if (!inserted.rows.length)
        throw new ConflictError('REPAIR_GENERATION_STALE', 'Receipt review generation is stale');
      saved.add(review.id);
    }
  }
}
