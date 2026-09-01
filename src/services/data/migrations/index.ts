import { Migration } from './Migration';
import { coreSchemaMigration } from './001_core_schema';
import { authAndProviderIdentityMigration } from './002_auth_and_provider_identity';
import { importLifecycleMigration } from './003_import_lifecycle';
import { receiptIdentityAndAnalyticsMigration } from './004_receipt_identity_and_analytics';
import { removeLegacyExportLifecycleMigration } from './005_remove_legacy_export_lifecycle';

export const migrations: readonly Migration[] = [
  coreSchemaMigration,
  authAndProviderIdentityMigration,
  importLifecycleMigration,
  receiptIdentityAndAnalyticsMigration,
  removeLegacyExportLifecycleMigration,
];
