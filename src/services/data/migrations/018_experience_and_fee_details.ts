import { Migration } from './Migration';

export const experienceAndFeeDetailsMigration: Migration = {
  version: 18,
  name: 'experience_and_fee_details',
  statements: [
    `CREATE TABLE IF NOT EXISTS user_experience_state (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      setup_completed_at TIMESTAMPTZ,
      setup_completion_method VARCHAR(40),
      first_recap_seen_at TIMESTAMPTZ,
      first_recap_version VARCHAR(40),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT user_experience_setup_method_check CHECK (
        setup_completion_method IS NULL OR setup_completion_method IN (
          'email_receipts', 'provider_history_request', 'provider_archive'
        )
      )
    )`,
    `ALTER TABLE receipts
      ADD COLUMN IF NOT EXISTS currency_code VARCHAR(8),
      ADD COLUMN IF NOT EXISTS subtotal_amount DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS tip_amount DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS delivery_fee_amount DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS service_fee_amount DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS savings_amount DECIMAL(10,2)`,
    `INSERT INTO user_experience_state (
       user_id, setup_completed_at, setup_completion_method
     )
     SELECT users.id,
       COALESCE(
         (SELECT MIN(receipts.created_at) FROM receipts WHERE receipts.user_id = users.id),
         (SELECT MIN(preferences.requested_at)
          FROM user_export_provider_preferences preferences
          WHERE preferences.user_id = users.id
            AND preferences.status IN ('requested', 'file_ready', 'import_processing', 'completed')),
         NOW()
       ),
       CASE
         WHEN EXISTS (SELECT 1 FROM receipts WHERE receipts.user_id = users.id)
           THEN CASE WHEN EXISTS (
             SELECT 1 FROM receipts
             WHERE receipts.user_id = users.id AND receipts.data_source = 'csv'
           ) THEN 'provider_archive' ELSE 'email_receipts' END
         ELSE 'provider_history_request'
       END
     FROM users
     WHERE EXISTS (SELECT 1 FROM receipts WHERE receipts.user_id = users.id)
        OR EXISTS (
          SELECT 1 FROM user_export_provider_preferences preferences
          WHERE preferences.user_id = users.id
            AND preferences.status IN ('requested', 'file_ready', 'import_processing', 'completed')
        )
     ON CONFLICT (user_id) DO NOTHING`,
    `CREATE INDEX IF NOT EXISTS idx_receipts_fee_trend
      ON receipts(user_id, currency_code, order_date)
      WHERE delivery_fee_amount IS NOT NULL`,
  ],
};
