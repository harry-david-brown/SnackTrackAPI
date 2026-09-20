import type { Migration } from './Migration';

export const receiptProviderIdentityMigration: Migration = {
  version: 25,
  name: 'receipt_provider_identity',
  statements: [
    'DROP INDEX IF EXISTS idx_receipts_user_external_id_unique',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_user_provider_external_id_unique
     ON receipts(user_id, receipt_type, external_id) WHERE external_id IS NOT NULL`,
  ],
};
