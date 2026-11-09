import type { Migration } from './Migration';

export const accountDeletionRequestsMigration: Migration = {
  version: 37,
  name: 'account_deletion_requests',
  statements: [
    `ALTER TABLE users ADD COLUMN deletion_requested_at TIMESTAMPTZ`,
    `CREATE TABLE account_deletion_requests (
       user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       attempts INTEGER NOT NULL DEFAULT 0,
       last_error_code TEXT
     )`,
    `CREATE INDEX idx_account_deletion_requests_due ON account_deletion_requests(next_attempt_at)`,
  ],
};
