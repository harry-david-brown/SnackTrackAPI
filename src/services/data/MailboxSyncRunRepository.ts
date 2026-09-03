import type { SyncRunCounts } from '../import/ImportLifecycleTypes';
import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';
import { databaseRow, databaseString } from './DatabaseRowDecoder';

/** Persists Microsoft mailbox import attempts and their provider baseline. */
export class MailboxSyncRunRepository {
  constructor(private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  async resetMicrosoftImportStatus(userId: string): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(
        `DELETE FROM mailbox_sync_runs WHERE user_id = $1 AND provider = 'microsoft'`,
        [userId],
      );
      await transaction.query(
        `DELETE FROM mailbox_import_states WHERE user_id = $1 AND provider = 'microsoft'`,
        [userId],
      );
    });
  }

  async startSyncRun(userId: string, trigger: 'manual' | 'background'): Promise<string> {
    await this.database.query(
      `INSERT INTO mailbox_import_states (user_id, provider)
       VALUES ($1, 'microsoft') ON CONFLICT (user_id, provider) DO NOTHING`,
      [userId],
    );
    const result = await this.database.query(
      `INSERT INTO mailbox_sync_runs (user_id, provider, trigger_type)
       VALUES ($1, 'microsoft', $2) RETURNING id`,
      [userId, trigger],
    );
    await this.database.query(
      trigger === 'manual'
        ? `UPDATE mailbox_import_states
           SET import_status = 'importing', error_code = NULL, updated_at = NOW()
           WHERE user_id = $1 AND provider = 'microsoft'`
        : `UPDATE user_import_preferences SET last_check_attempt_at = NOW(), updated_at = NOW()
           WHERE user_id = $1`,
      [userId],
    );
    return databaseString(databaseRow(result.rows[0], 'mailbox sync run'), 'id');
  }

  async completeSyncRun(
    runId: string,
    userId: string,
    outcome: 'success' | 'partial',
    counts: SyncRunCounts,
    trigger: 'manual' | 'background',
  ): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE mailbox_sync_runs
         SET outcome = $2, completed_at = NOW(), emails_scanned = $3,
             receipts_processed = $4, new_orders = $5, updated_orders = $6,
             unchanged_orders = $7, supported_receipts_found = $8,
             export_covered_receipts = $9, eligible_receipts = $10,
             deduplicated_receipts = $11
             ,rejected_messages=$12,decoded_bytes_examined=$13
         WHERE id = $1 AND user_id = $14 AND provider = 'microsoft'`,
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
      if (trigger === 'manual') {
        await transaction.query(
          `UPDATE mailbox_import_states
           SET import_status = 'completed', imported_count = $2, error_code = NULL,
               baseline_completed_at = COALESCE(baseline_completed_at, NOW()), updated_at = NOW()
           WHERE user_id = $1 AND provider = 'microsoft'`,
          [userId, counts.newOrders + counts.updatedOrders + counts.unchangedOrders],
        );
      } else {
        await transaction.query(
          `UPDATE user_import_preferences
           SET last_successful_check_at = NOW(),
               last_stats_updated_at = CASE WHEN $2 > 0 OR $3 > 0 THEN NOW() ELSE last_stats_updated_at END,
               last_new_order_at = CASE WHEN $2 > 0 THEN NOW() ELSE last_new_order_at END,
               tracking_status = CASE WHEN ongoing_tracking_consent_state = 'granted' THEN 'active' ELSE tracking_status END,
               last_tracking_error_at = NULL, last_tracking_error_code = NULL, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, counts.newOrders, counts.updatedOrders],
        );
      }
    });
  }

  async failSyncRun(
    runId: string,
    userId: string,
    errorCode: string,
    trigger: 'manual' | 'background',
  ): Promise<void> {
    const safeCode = errorCode.substring(0, 80);
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE mailbox_sync_runs SET outcome = 'failed', completed_at = NOW(), error_code = $2
         WHERE id = $1 AND user_id = $3 AND provider = 'microsoft'`,
        [runId, safeCode, userId],
      );
      await transaction.query(
        trigger === 'manual'
          ? `UPDATE mailbox_import_states
             SET import_status = 'failed', error_code = $2, updated_at = NOW()
             WHERE user_id = $1 AND provider = 'microsoft'`
          : `UPDATE user_import_preferences
             SET tracking_status = CASE WHEN ongoing_tracking_consent_state = 'granted' THEN 'error' ELSE tracking_status END,
                 last_tracking_error_at = NOW(), last_tracking_error_code = $2, updated_at = NOW()
             WHERE user_id = $1`,
        [userId, safeCode],
      );
    });
  }
}
