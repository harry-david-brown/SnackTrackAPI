import type { Migration } from './Migration';

/** Legacy audit rows remain inert; only evidence-bound decisions constrain reconciliation. */
export const receiptReviewEvidenceMigration: Migration = {
  version: 31,
  name: 'receipt_review_evidence',
  statements: [
    `ALTER TABLE receipt_association_reviews ADD COLUMN evidence JSONB,
      ADD CONSTRAINT receipt_review_evidence_check CHECK(evidence IS NULL OR COALESCE(
        (jsonb_typeof(evidence)='object' AND evidence->'policyVersion'='3'::jsonb
        AND jsonb_typeof(evidence->'fingerprint')='string'
        AND evidence->>'fingerprint' ~ '^[0-9a-f]{64}$'),FALSE))`,
    `CREATE UNIQUE INDEX receipt_review_verified_successor
      ON receipt_association_reviews(user_id,supersedes_id)
      WHERE supersedes_id IS NOT NULL AND evidence IS NOT NULL`,
  ],
};
