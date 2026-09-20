import type { Migration } from './Migration';

export const receiptEvidenceMigration: Migration = {
  version: 24,
  name: 'receipt_evidence',
  statements: [
    `ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_kind_check`,
    `ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_kind_check CHECK (kind IN ('gmail_historical','outlook_historical','manual_tracking','scheduled_tracking','gmail_push_tracking','export_file','receipt_rebuild','receipt_publish','receipt_rollback'))`,
    `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS resolution JSONB`,
    `CREATE TABLE IF NOT EXISTS receipt_observations (
      id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      document_key TEXT NOT NULL, import_generation INTEGER NOT NULL, parser_version INTEGER NOT NULL,
      payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, document_key, parser_version)
    )`,
    `CREATE INDEX IF NOT EXISTS receipt_observations_receipt_idx ON receipt_observations(receipt_id)`,
    `CREATE TABLE IF NOT EXISTS receipt_projection_revisions (
      receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(receipt_id, version)
    )`,
  ],
};
