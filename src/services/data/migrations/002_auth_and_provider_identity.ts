import { Migration } from './Migration';

export const authAndProviderIdentityMigration: Migration = {
  version: 2,
  name: 'auth_and_provider_identity',
  statements: [
    `ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password VARCHAR(255),
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/New_York',
      ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS gmail_access_token TEXT,
      ADD COLUMN IF NOT EXISTS gmail_token_expiry TIMESTAMP,
      ADD COLUMN IF NOT EXISTS gmail_connected BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS gmail_email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS gmail_scopes TEXT[] DEFAULT ARRAY[]::TEXT[],
      ADD COLUMN IF NOT EXISTS gmail_connection_mode VARCHAR(20) DEFAULT 'none'`,
    'CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified)',
    'CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email))',
    `CREATE TABLE IF NOT EXISTS verification_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      code_type VARCHAR(50) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used_at TIMESTAMP NULL
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      provider_user_id VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      access_token TEXT,
      refresh_token TEXT,
      token_expiry TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_user_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_verification_email_type ON verification_codes(email, code_type)',
    'CREATE INDEX IF NOT EXISTS idx_verification_expires ON verification_codes(expires_at)',
  ],
};
