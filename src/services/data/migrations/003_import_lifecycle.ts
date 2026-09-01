import { Migration } from './Migration';

export const importLifecycleMigration: Migration = {
  version: 3,
  name: 'import_lifecycle',
  statements: [
    `CREATE TABLE IF NOT EXISTS user_import_preferences (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      monitoring_consent_state VARCHAR(24) NOT NULL DEFAULT 'not_offered',
      monitoring_consent_version VARCHAR(50),
      monitoring_consented_at TIMESTAMPTZ,
      monitoring_revoked_at TIMESTAMPTZ,
      export_status VARCHAR(40) NOT NULL DEFAULT 'not_started',
      export_requested_at TIMESTAMPTZ,
      export_updated_at TIMESTAMPTZ,
      gmail_import_status VARCHAR(24) NOT NULL DEFAULT 'never_started',
      gmail_import_updated_at TIMESTAMPTZ,
      gmail_imported_count INTEGER NOT NULL DEFAULT 0,
      gmail_import_error_code VARCHAR(80),
      gmail_baseline_completed_at TIMESTAMPTZ,
      ongoing_tracking_consent_state VARCHAR(24) NOT NULL DEFAULT 'not_offered',
      ongoing_tracking_consent_version VARCHAR(50),
      ongoing_tracking_consented_at TIMESTAMPTZ,
      ongoing_tracking_revoked_at TIMESTAMPTZ,
      tracking_status VARCHAR(24) NOT NULL DEFAULT 'inactive',
      last_check_attempt_at TIMESTAMPTZ,
      last_successful_check_at TIMESTAMPTZ,
      last_stats_updated_at TIMESTAMPTZ,
      last_new_order_at TIMESTAMPTZ,
      last_tracking_error_at TIMESTAMPTZ,
      last_tracking_error_code VARCHAR(80),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE user_import_preferences
      ADD COLUMN IF NOT EXISTS monitoring_consent_state VARCHAR(24) NOT NULL DEFAULT 'not_offered',
      ADD COLUMN IF NOT EXISTS monitoring_consent_version VARCHAR(50),
      ADD COLUMN IF NOT EXISTS monitoring_consented_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS monitoring_revoked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS export_status VARCHAR(40) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS export_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS export_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS gmail_import_status VARCHAR(24) NOT NULL DEFAULT 'never_started',
      ADD COLUMN IF NOT EXISTS gmail_import_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS gmail_imported_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS gmail_import_error_code VARCHAR(80),
      ADD COLUMN IF NOT EXISTS gmail_baseline_completed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS ongoing_tracking_consent_state VARCHAR(24) NOT NULL DEFAULT 'not_offered',
      ADD COLUMN IF NOT EXISTS ongoing_tracking_consent_version VARCHAR(50),
      ADD COLUMN IF NOT EXISTS ongoing_tracking_consented_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS ongoing_tracking_revoked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(24) NOT NULL DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS last_check_attempt_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_successful_check_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_stats_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_new_order_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_tracking_error_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_tracking_error_code VARCHAR(80),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE user_import_preferences
      DROP CONSTRAINT IF EXISTS user_import_preferences_monitoring_consent_state_check,
      DROP CONSTRAINT IF EXISTS user_import_preferences_export_status_check,
      DROP CONSTRAINT IF EXISTS user_import_preferences_gmail_import_status_check,
      DROP CONSTRAINT IF EXISTS user_import_preferences_ongoing_tracking_consent_state_check,
      DROP CONSTRAINT IF EXISTS user_import_preferences_tracking_status_check`,
    `ALTER TABLE user_import_preferences
      ADD CONSTRAINT user_import_preferences_monitoring_consent_state_check
        CHECK (monitoring_consent_state IN ('not_offered', 'declined', 'granted', 'revoked')),
      ADD CONSTRAINT user_import_preferences_export_status_check
        CHECK (export_status IN (
          'not_started', 'requested_monitoring_enabled', 'requested_monitoring_disabled',
          'file_ready', 'import_processing', 'completed', 'failed'
        )),
      ADD CONSTRAINT user_import_preferences_gmail_import_status_check
        CHECK (gmail_import_status IN ('never_started', 'importing', 'completed', 'failed')),
      ADD CONSTRAINT user_import_preferences_ongoing_tracking_consent_state_check
        CHECK (ongoing_tracking_consent_state IN ('not_offered', 'declined', 'granted', 'revoked')),
      ADD CONSTRAINT user_import_preferences_tracking_status_check
        CHECK (tracking_status IN (
          'inactive', 'setting_up', 'active', 'paused', 'reconnect_required', 'error'
        ))`,
    `CREATE TABLE IF NOT EXISTS user_export_provider_preferences (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(24) NOT NULL CHECK (provider IN ('uber_eats', 'doordash')),
      status VARCHAR(32) NOT NULL DEFAULT 'not_started'
        CHECK (status IN ('not_started', 'requested', 'file_ready', 'import_processing', 'completed', 'failed')),
      requested_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error_code VARCHAR(80),
      ready_source VARCHAR(24)
        CHECK (ready_source IS NULL OR ready_source IN ('detected_email', 'user_confirmed')),
      PRIMARY KEY (user_id, provider)
    )`,
    `ALTER TABLE user_export_provider_preferences
      ADD COLUMN IF NOT EXISTS ready_source VARCHAR(24)
        CHECK (ready_source IS NULL OR ready_source IN ('detected_email', 'user_confirmed'))`,
    `INSERT INTO user_export_provider_preferences (user_id, provider, status, updated_at)
      SELECT user_id, 'uber_eats', 'file_ready', COALESCE(export_updated_at, NOW())
      FROM user_import_preferences
      WHERE export_status = 'file_ready'
      ON CONFLICT (user_id, provider) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS user_import_preference_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_name VARCHAR(60) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE user_import_preference_events
      DROP CONSTRAINT IF EXISTS user_import_preference_events_event_name_check`,
    `ALTER TABLE user_import_preference_events
      ADD CONSTRAINT user_import_preference_events_event_name_check
      CHECK (event_name IN (
        'monitoring_consent_granted', 'monitoring_consent_declined', 'monitoring_consent_revoked',
        'ongoing_tracking_consent_granted', 'ongoing_tracking_consent_declined', 'ongoing_tracking_consent_revoked',
        'export_requested', 'export_file_ready', 'export_import_processing', 'export_completed', 'export_failed',
        'gmail_import_reset'
      ))`,
    `CREATE TABLE IF NOT EXISTS gmail_sync_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    `ALTER TABLE gmail_sync_runs
      ADD COLUMN IF NOT EXISTS supported_receipts_found INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS export_covered_receipts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS eligible_receipts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS deduplicated_receipts INTEGER NOT NULL DEFAULT 0`,
    `UPDATE user_import_preferences
      SET gmail_baseline_completed_at = COALESCE(gmail_import_updated_at, NOW())
      WHERE gmail_baseline_completed_at IS NULL AND gmail_import_status = 'completed'`,
    `UPDATE user_import_preferences preferences
      SET gmail_baseline_completed_at = successful_run.completed_at
      FROM (
        SELECT user_id, MAX(completed_at) AS completed_at
        FROM gmail_sync_runs
        WHERE trigger_type = 'manual'
          AND outcome IN ('success', 'partial')
          AND completed_at IS NOT NULL
        GROUP BY user_id
      ) successful_run
      WHERE preferences.user_id = successful_run.user_id
        AND preferences.gmail_baseline_completed_at IS NULL`,
    'CREATE INDEX IF NOT EXISTS idx_user_import_preferences_export_status ON user_import_preferences(export_status)',
    'CREATE INDEX IF NOT EXISTS idx_user_export_provider_status ON user_export_provider_preferences(provider, status)',
    'CREATE INDEX IF NOT EXISTS idx_user_import_preference_events_user_created ON user_import_preference_events(user_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_user_import_preference_events_name_created ON user_import_preference_events(event_name, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_gmail_sync_runs_user_started ON gmail_sync_runs(user_id, started_at DESC)',
  ],
};
