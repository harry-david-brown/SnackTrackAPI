import { Migration } from './Migration';

export const microsoftIdentityLoginMigration: Migration = {
  version: 7,
  name: 'microsoft_identity_login',
  statements: [
    `CREATE TABLE IF NOT EXISTS oauth_login_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider VARCHAR(50) NOT NULL,
      attempt_token_hash VARCHAR(64) NOT NULL UNIQUE,
      nonce_hash VARCHAR(64) NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'pending_identity',
      provider_user_id VARCHAR(255),
      suggested_email VARCHAR(320),
      verification_sent_at TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      completed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT oauth_login_attempt_provider CHECK (provider = 'microsoft'),
      CONSTRAINT oauth_login_attempt_status CHECK (
        status IN ('pending_identity', 'email_verification_required', 'completed')
      )
    )`,
    `ALTER TABLE verification_codes
      ADD COLUMN IF NOT EXISTS scope_id UUID REFERENCES oauth_login_attempts(id) ON DELETE CASCADE`,
    `CREATE INDEX IF NOT EXISTS idx_oauth_login_attempts_expiry
      ON oauth_login_attempts(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_verification_scope_type
      ON verification_codes(scope_id, code_type)`,
  ],
};
