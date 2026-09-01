import { Migration } from './Migration';

/**
 * Contracts the additive provider-lifecycle migration after every caller has
 * moved to user_export_provider_preferences. Migration 003 remains responsible
 * for copying legacy file-ready state before these duplicate columns disappear.
 */
export const removeLegacyExportLifecycleMigration: Migration = {
  version: 5,
  name: 'remove_legacy_export_lifecycle',
  statements: [
    'DROP INDEX IF EXISTS idx_user_import_preferences_export_status',
    `ALTER TABLE user_import_preferences
      DROP COLUMN IF EXISTS export_status,
      DROP COLUMN IF EXISTS export_requested_at,
      DROP COLUMN IF EXISTS export_updated_at`,
  ],
};
