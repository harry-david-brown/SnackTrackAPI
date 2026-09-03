import { Migration } from './Migration';

export const asyncImportJobsMigration: Migration = {
  version: 12,
  name: 'async_import_jobs',
  statements: [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS import_generation BIGINT NOT NULL DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS import_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind VARCHAR(32) NOT NULL CHECK (kind IN ('gmail_historical','outlook_historical','manual_tracking','scheduled_tracking','export_file')),
      trigger_type VARCHAR(16) NOT NULL CHECK (trigger_type IN ('user','scheduler')),
      status VARCHAR(24) NOT NULL CHECK (status IN ('awaiting_upload','pending_dispatch','queued','running','retrying','succeeded','failed','expired','superseded')),
      phase VARCHAR(32) NOT NULL DEFAULT 'waiting',
      progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
      result JSONB,
      error_code VARCHAR(96),
      error_message VARCHAR(500),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      heartbeat_at TIMESTAMPTZ,
      object_key VARCHAR(500),
      original_filename VARCHAR(255),
      content_type VARCHAR(128),
      content_length BIGINT CHECK (content_length IS NULL OR content_length >= 0),
      import_generation BIGINT NOT NULL,
      idempotency_key VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      queued_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_import_jobs_idempotency
      ON import_jobs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_import_jobs_one_active_writer
      ON import_jobs(user_id) WHERE status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')`,
    `CREATE INDEX IF NOT EXISTS idx_import_jobs_user_recent ON import_jobs(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_import_jobs_status_heartbeat ON import_jobs(status, heartbeat_at)`,
    `CREATE TABLE IF NOT EXISTS import_job_outbox (
      id BIGSERIAL PRIMARY KEY,
      job_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('dispatch','notify')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      last_error VARCHAR(500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(job_id, event_type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_import_job_outbox_pending
      ON import_job_outbox(available_at, id) WHERE published_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS import_receipt_staging (
      job_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      sequence_number INTEGER NOT NULL,
      receipt JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(job_id, sequence_number)
    )`,
    `CREATE TABLE IF NOT EXISTS push_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id VARCHAR(128) NOT NULL,
      expo_push_token VARCHAR(255) NOT NULL,
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('ios','android')),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, installation_id),
      UNIQUE(expo_push_token)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_push_devices_user_enabled ON push_devices(user_id) WHERE enabled`,
    `CREATE TABLE IF NOT EXISTS push_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      push_device_id UUID NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
      status VARCHAR(24) NOT NULL CHECK (status IN ('pending','sent','delivered','failed','device_disabled')),
      expo_ticket_id VARCHAR(255),
      error_code VARCHAR(96),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(job_id, push_device_id)
    )`,
  ],
};
