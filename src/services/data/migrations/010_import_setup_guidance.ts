import { Migration } from './Migration';

export const importSetupGuidanceMigration: Migration = {
  version: 10,
  name: 'import_setup_guidance',
  statements: [
    `ALTER TABLE user_import_preferences
      ADD COLUMN IF NOT EXISTS initial_setup_deferred_until TIMESTAMPTZ`,
    `ALTER TABLE user_export_provider_preferences
      ADD COLUMN IF NOT EXISTS relevance VARCHAR(16) NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE user_export_provider_preferences
      DROP CONSTRAINT IF EXISTS user_export_provider_preferences_relevance_check`,
    `ALTER TABLE user_export_provider_preferences
      ADD CONSTRAINT user_export_provider_preferences_relevance_check
      CHECK (relevance IN ('unknown', 'not_used'))`,
    `CREATE OR REPLACE FUNCTION snacktrack_reconcile_provider_relevance() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.receipt_type IN ('uber_eats', 'doordash') AND NEW.data_source IN ('email', 'csv') THEN
          INSERT INTO user_export_provider_preferences (user_id, provider, relevance)
          VALUES (NEW.user_id, NEW.receipt_type, 'unknown')
          ON CONFLICT (user_id, provider) DO UPDATE SET relevance = 'unknown';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_receipt_provider_relevance ON receipts',
    `CREATE TRIGGER trg_receipt_provider_relevance
      AFTER INSERT OR UPDATE OF user_id, receipt_type ON receipts
      FOR EACH ROW EXECUTE FUNCTION snacktrack_reconcile_provider_relevance()`,
  ],
};
