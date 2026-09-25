import type { Migration } from './Migration';

export const authSecurityMigration: Migration = {
  version: 34,
  name: 'auth_security',
  statements: [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0
       CHECK (session_version >= 0)`,
    `CREATE TABLE IF NOT EXISTS mailbox_authorization_attempts (
       state_hash TEXT PRIMARY KEY,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
       verifier_hash TEXT NOT NULL,
       session_version INTEGER NOT NULL,
       import_generation BIGINT NOT NULL,
       completion_hash TEXT UNIQUE,
       encrypted_callback TEXT,
       claimed_at TIMESTAMPTZ,
       expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
     )`,
    `CREATE INDEX IF NOT EXISTS idx_mailbox_authorization_expiry
       ON mailbox_authorization_attempts(expires_at)`,
  ],
};
