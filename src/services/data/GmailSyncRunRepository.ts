import type { GmailSyncTrigger, SyncRunCounts } from '../import/ImportLifecycleTypes';
import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';
import { databaseRow, databaseString } from './DatabaseRowDecoder';
import type { ImportEventRepository } from './ImportEventRepository';

type EventPort = Pick<ImportEventRepository, 'record'>;

/** Persists individual Gmail sync runs and their corresponding lifecycle fields. */
export class GmailSyncRunRepository {
  constructor(
    private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner,
    private readonly events: EventPort,
  ) {}

  private async ensurePreferences(userId: string): Promise<void> {
    await this.database.query(
      `INSERT INTO user_import_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }

  async resetGmailImportStatus(userId: string): Promise<void> {
    await this.ensurePreferences(userId);
    const updated = await this.database.withTransaction(async (transaction) => {
      await transaction.query('DELETE FROM gmail_sync_runs WHERE user_id = $1', [userId]);
      const result = await transaction.query(
        `UPDATE user_import_preferences
         SET gmail_import_status = 'never_started', gmail_import_updated_at = NOW(),
             gmail_imported_count = 0, gmail_import_error_code = NULL,
             gmail_baseline_completed_at = NULL, last_check_attempt_at = NULL,
             last_successful_check_at = NULL, last_stats_updated_at = NULL,
             last_new_order_at = NULL, last_tracking_error_at = NULL,
             last_tracking_error_code = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [userId],
      );
      return (result.rowCount ?? 0) > 0;
    });
    if (updated) await this.events.record(userId, 'gmail_import_reset');
  }

  async startSyncRun(userId: string, triggerType: GmailSyncTrigger): Promise<string> {
    await this.ensurePreferences(userId);
    const result = await this.database.query(
      `INSERT INTO gmail_sync_runs (user_id, trigger_type)
       VALUES ($1, $2) RETURNING id`,
      [userId, triggerType],
    );
    const runId = databaseString(databaseRow(result.rows[0], 'gmail sync run'), 'id');
    await this.database.query(
      triggerType === 'manual'
        ? `UPDATE user_import_preferences
           SET gmail_import_status = 'importing', gmail_import_updated_at = NOW(),
               gmail_import_error_code = NULL, updated_at = NOW()
           WHERE user_id = $1`
        : `UPDATE user_import_preferences
           SET last_check_attempt_at = NOW(), updated_at = NOW()
           WHERE user_id = $1`,
      [userId],
    );
    return runId;
  }

  async completeSyncRun(
    runId: string,
    userId: string,
    outcome: 'success' | 'partial',
    counts: SyncRunCounts,
    triggerType: GmailSyncTrigger,
  ): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE gmail_sync_runs
         SET outcome = $2, completed_at = NOW(), emails_scanned = $3,
             receipts_processed = $4, new_orders = $5, updated_orders = $6,
             unchanged_orders = $7, supported_receipts_found = $8,
             export_covered_receipts = $9, eligible_receipts = $10,
             deduplicated_receipts = $11
             ,rejected_messages=$12,decoded_bytes_examined=$13
         WHERE id = $1 AND user_id = $14`,
        [
          runId,
          outcome,
          counts.emailsScanned,
          counts.receiptsProcessed,
          counts.newOrders,
          counts.updatedOrders,
          counts.unchangedOrders,
          counts.supportedReceiptsFound,
          counts.exportCoveredReceipts,
          counts.eligibleReceipts,
          counts.deduplicatedReceipts,
          counts.rejectedMessages,
          counts.decodedBytesExamined,
          userId,
        ],
      );
      await transaction.query(
        triggerType === 'manual'
          ? `UPDATE user_import_preferences
             SET gmail_import_status = 'completed', gmail_import_updated_at = NOW(),
                 gmail_imported_count = $2, gmail_import_error_code = NULL,
                 gmail_baseline_completed_at = COALESCE(gmail_baseline_completed_at, NOW()),
                 updated_at = NOW()
             WHERE user_id = $1`
          : `UPDATE user_import_preferences
             SET last_successful_check_at = NOW(),
                 last_stats_updated_at = CASE WHEN $2 > 0 OR $3 > 0 THEN NOW() ELSE last_stats_updated_at END,
                 last_new_order_at = CASE WHEN $2 > 0 THEN NOW() ELSE last_new_order_at END,
                 tracking_status = CASE WHEN ongoing_tracking_consent_state = 'granted' THEN 'active' ELSE tracking_status END,
                 last_tracking_error_at = NULL, last_tracking_error_code = NULL, updated_at = NOW()
             WHERE user_id = $1`,
        triggerType === 'manual'
          ? [userId, counts.newOrders + counts.updatedOrders + counts.unchangedOrders]
          : [userId, counts.newOrders, counts.updatedOrders],
      );
    });
  }

  async failSyncRun(
    runId: string,
    userId: string,
    errorCode: string,
    triggerType: GmailSyncTrigger,
  ): Promise<void> {
    const safeCode = errorCode.substring(0, 80);
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE gmail_sync_runs SET outcome = 'failed', completed_at = NOW(), error_code = $2
         WHERE id = $1 AND user_id = $3`,
        [runId, safeCode, userId],
      );
      await transaction.query(
        triggerType === 'manual'
          ? `UPDATE user_import_preferences
             SET gmail_import_status = 'failed', gmail_import_updated_at = NOW(),
                 gmail_import_error_code = $2, updated_at = NOW()
             WHERE user_id = $1`
          : `UPDATE user_import_preferences
             SET tracking_status = CASE
                   WHEN ongoing_tracking_consent_state = 'granted' THEN 'error' ELSE tracking_status END,
                 last_tracking_error_at = NOW(), last_tracking_error_code = $2, updated_at = NOW()
             WHERE user_id = $1`,
        [userId, safeCode],
      );
    });
  }
}
