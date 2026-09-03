import { Migration } from './Migration';
import { coreSchemaMigration } from './001_core_schema';
import { authAndProviderIdentityMigration } from './002_auth_and_provider_identity';
import { importLifecycleMigration } from './003_import_lifecycle';
import { receiptIdentityAndAnalyticsMigration } from './004_receipt_identity_and_analytics';
import { removeLegacyExportLifecycleMigration } from './005_remove_legacy_export_lifecycle';
import { outlookMailboxImportMigration } from './006_outlook_mailbox_import';
import { microsoftIdentityLoginMigration } from './007_microsoft_identity_login';
import { adminControlPlaneMigration } from './008_admin_control_plane';
import { adminAnalyticsMigration } from './009_admin_analytics';
import { importSetupGuidanceMigration } from './010_import_setup_guidance';
import { adminAnalyticsCaptureMigration } from './011_admin_analytics_capture';
import { asyncImportJobsMigration } from './012_async_import_jobs';
import { importJobCheckpointsMigration } from './013_import_job_checkpoints';
import { importInputSecurityMigration } from './014_import_input_security';
import { adminQueryIndexesMigration } from './015_admin_query_indexes';

export const migrations: readonly Migration[] = [
  coreSchemaMigration,
  authAndProviderIdentityMigration,
  importLifecycleMigration,
  receiptIdentityAndAnalyticsMigration,
  removeLegacyExportLifecycleMigration,
  outlookMailboxImportMigration,
  microsoftIdentityLoginMigration,
  adminControlPlaneMigration,
  adminAnalyticsMigration,
  importSetupGuidanceMigration,
  adminAnalyticsCaptureMigration,
  asyncImportJobsMigration,
  importJobCheckpointsMigration,
  importInputSecurityMigration,
  adminQueryIndexesMigration,
];
