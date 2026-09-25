import type { Migration } from './Migration';

export const exportReadyAlertsMigration: Migration = {
  version: 33,
  name: 'export_ready_alerts',
  statements: [
    `ALTER TABLE user_export_provider_preferences
      ADD COLUMN request_id UUID NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN alert_consent VARCHAR(24) NOT NULL DEFAULT 'not_offered' CHECK (alert_consent IN ('not_offered','granted','declined','revoked')),
      ADD COLUMN alert_consent_version VARCHAR(50),
      ADD COLUMN alert_consented_at TIMESTAMPTZ,
      ADD COLUMN alert_revoked_at TIMESTAMPTZ,
      ADD COLUMN alert_next_check_at TIMESTAMPTZ,
      ADD COLUMN alert_last_error_code VARCHAR(96),
      ADD COLUMN alert_last_checked_at TIMESTAMPTZ`,
    `CREATE INDEX idx_export_alert_due ON user_export_provider_preferences(alert_next_check_at) WHERE status='requested' AND alert_consent='granted'`,
    `ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_kind_check`,
    `ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_kind_check CHECK (kind IN ('gmail_historical','outlook_historical','manual_tracking','scheduled_tracking','gmail_push_tracking','export_file','receipt_rebuild','receipt_publish','receipt_rollback','export_ready_check'))`,
    `DROP INDEX idx_import_jobs_one_active_writer`,
    `CREATE UNIQUE INDEX idx_import_jobs_one_active_writer ON import_jobs(user_id) WHERE status IN ('awaiting_upload','pending_dispatch','queued','running','retrying') AND kind<>'export_ready_check'`,
    `CREATE UNIQUE INDEX idx_export_ready_active ON import_jobs(user_id,export_provider) WHERE kind='export_ready_check' AND status IN ('pending_dispatch','queued','running','retrying')`,
  ],
};
