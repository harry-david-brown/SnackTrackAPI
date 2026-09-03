import { Migration } from './Migration';

export const outlookMailboxImportMigration: Migration = {
  version: 6,
  name: 'outlook_mailbox_import',
  statements: [
    `CREATE TABLE IF NOT EXISTS mailbox_connections (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(24) NOT NULL CHECK (provider IN ('microsoft')),
      provider_account_id TEXT NOT NULL,
      email VARCHAR(320) NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      connection_mode VARCHAR(20) NOT NULL DEFAULT 'offline'
        CHECK (connection_mode IN ('temporary', 'offline')),
      status VARCHAR(24) NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connected', 'reconnect_required')),
      encrypted_token_cache TEXT NOT NULL,
      token_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, provider),
      UNIQUE (provider, provider_account_id)
    )`,
    `CREATE TABLE IF NOT EXISTS mailbox_import_states (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(24) NOT NULL CHECK (provider IN ('microsoft')),
      import_status VARCHAR(24) NOT NULL DEFAULT 'never_started'
        CHECK (import_status IN ('never_started', 'importing', 'completed', 'failed')),
      imported_count INTEGER NOT NULL DEFAULT 0,
      error_code VARCHAR(80),
      baseline_completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, provider)
    )`,
    `CREATE TABLE IF NOT EXISTS mailbox_sync_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(24) NOT NULL CHECK (provider IN ('microsoft')),
      trigger_type VARCHAR(20) NOT NULL CHECK (trigger_type IN ('manual', 'background')),
      outcome VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (outcome IN ('running', 'success', 'partial', 'failed')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      emails_scanned INTEGER NOT NULL DEFAULT 0,
      receipts_processed INTEGER NOT NULL DEFAULT 0,
      new_orders INTEGER NOT NULL DEFAULT 0,
      updated_orders INTEGER NOT NULL DEFAULT 0,
      unchanged_orders INTEGER NOT NULL DEFAULT 0,
      supported_receipts_found INTEGER NOT NULL DEFAULT 0,
      export_covered_receipts INTEGER NOT NULL DEFAULT 0,
      eligible_receipts INTEGER NOT NULL DEFAULT 0,
      deduplicated_receipts INTEGER NOT NULL DEFAULT 0,
      error_code VARCHAR(80)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mailbox_connections_user_status
      ON mailbox_connections(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_mailbox_sync_runs_user_provider_started
      ON mailbox_sync_runs(user_id, provider, started_at DESC)`,
  ],
};
