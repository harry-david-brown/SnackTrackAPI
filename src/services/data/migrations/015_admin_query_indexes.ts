import { Migration } from './Migration';

export const adminQueryIndexesMigration: Migration = {
  version: 15,
  name: 'admin_query_indexes',
  statements: [
    `CREATE INDEX IF NOT EXISTS idx_gmail_sync_runs_admin_attention
      ON gmail_sync_runs(outcome, started_at DESC, user_id)
      WHERE outcome IN ('running', 'failed', 'partial')`,
    `CREATE INDEX IF NOT EXISTS idx_mailbox_sync_runs_admin_attention
      ON mailbox_sync_runs(outcome, started_at DESC, user_id)
      WHERE outcome IN ('running', 'failed', 'partial')`,
    `CREATE INDEX IF NOT EXISTS idx_user_import_preferences_tracking_status
      ON user_import_preferences(tracking_status, user_id)`,
  ],
};
