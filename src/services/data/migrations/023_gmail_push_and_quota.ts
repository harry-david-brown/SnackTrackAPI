import { Migration } from './Migration';

export const gmailPushAndQuotaMigration: Migration = {
  version: 23,
  name: 'gmail_push_and_quota',
  statements: [
    `ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_kind_check`,
    `ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_kind_check CHECK (
      kind IN ('gmail_historical','outlook_historical','manual_tracking','scheduled_tracking','gmail_push_tracking','export_file')
    )`,
    `CREATE TABLE IF NOT EXISTS gmail_push_state (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      latest_history_id NUMERIC(30,0),
      dispatched_history_id NUMERIC(30,0),
      pending BOOLEAN NOT NULL DEFAULT FALSE,
      first_pending_at TIMESTAMPTZ,
      last_notification_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      last_dispatched_at TIMESTAMPTZ,
      last_processed_at TIMESTAMPTZ,
      watch_history_id NUMERIC(30,0),
      watch_expiration TIMESTAMPTZ,
      watch_last_renewed_at TIMESTAMPTZ,
      watch_renewal_lease_until TIMESTAMPTZ,
      notification_count BIGINT NOT NULL DEFAULT 0,
      coalesced_notification_count BIGINT NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error_code VARCHAR(96),
      last_pubsub_message_id VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gmail_push_pending
      ON gmail_push_state(next_attempt_at,user_id) WHERE pending`,
    `CREATE INDEX IF NOT EXISTS idx_gmail_push_watch_expiration
      ON gmail_push_state(watch_expiration,user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_gmail_email_lookup
      ON users(LOWER(gmail_email)) WHERE gmail_connected AND gmail_email IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS gmail_api_project_minute_budget (
      bucket_start TIMESTAMPTZ PRIMARY KEY,
      units BIGINT NOT NULL CHECK (units >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS gmail_api_project_day_budget (
      bucket_start DATE PRIMARY KEY,
      units BIGINT NOT NULL CHECK (units >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS gmail_api_user_minute_budget (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bucket_start TIMESTAMPTZ NOT NULL,
      units INTEGER NOT NULL CHECK (units >= 0),
      PRIMARY KEY(user_id,bucket_start)
    )`,
    `CREATE TABLE IF NOT EXISTS gmail_api_usage_minute (
      bucket_start TIMESTAMPTZ NOT NULL,
      category VARCHAR(32) NOT NULL CHECK (category IN ('onboarding_import','monitoring','connection')),
      method VARCHAR(32) NOT NULL,
      units BIGINT NOT NULL CHECK (units >= 0),
      request_count BIGINT NOT NULL CHECK (request_count >= 0),
      PRIMARY KEY(bucket_start,category,method)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gmail_api_usage_range
      ON gmail_api_usage_minute(bucket_start,category)`,
  ],
};
