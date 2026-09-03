import { Migration } from './Migration';

export const importInputSecurityMigration: Migration = {
  version: 14,
  name: 'import_input_security',
  statements: [
    `ALTER TABLE import_jobs
      ADD COLUMN IF NOT EXISTS export_provider VARCHAR(24),
      ADD COLUMN IF NOT EXISTS object_etag VARCHAR(255),
      ADD COLUMN IF NOT EXISTS submitted_content_type VARCHAR(128),
      ADD COLUMN IF NOT EXISTS submitted_content_length BIGINT`,
    `ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_export_provider_check`,
    `ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_export_provider_check
      CHECK (export_provider IS NULL OR export_provider IN ('uber_eats','doordash'))`,
    `ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_submitted_content_length_check`,
    `ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_submitted_content_length_check
      CHECK (submitted_content_length IS NULL OR submitted_content_length >= 0)`,
    `CREATE TABLE IF NOT EXISTS user_mailbox_security_policies (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      allow_forwarded_receipts BOOLEAN NOT NULL DEFAULT FALSE,
      reason VARCHAR(500),
      updated_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE gmail_sync_runs
      ADD COLUMN IF NOT EXISTS rejected_messages INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS rejection_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS decoded_bytes_examined BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS authentication_outcomes JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE mailbox_sync_runs
      ADD COLUMN IF NOT EXISTS rejected_messages INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS rejection_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS decoded_bytes_examined BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS authentication_outcomes JSONB NOT NULL DEFAULT '{}'::jsonb`,
  ],
};
