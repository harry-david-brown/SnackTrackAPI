import { ConflictError } from '../../core/errors';
import { DatabaseTransactionRunner } from '../ports/DatabasePort';
import { ImportLockHandle, ImportLockService } from '../import/ImportLockService';

interface ReceiptClearLock {
  acquireLockWithWait(userId: string, timeoutMs?: number): Promise<ImportLockHandle | null>;
  assertLockOwned(handle: ImportLockHandle): Promise<void>;
  releaseLock(handle: ImportLockHandle): Promise<boolean>;
}

interface UserCacheInvalidator {
  invalidateAllUserCaches(userId: string): Promise<void>;
}

export interface ReceiptClearResult {
  deletedReceipts: number;
}

/** Clears receipt-derived history while preserving the user's account. */
export class ReceiptClearService {
  constructor(
    private readonly postgres: DatabaseTransactionRunner,
    private readonly cache: UserCacheInvalidator,
    private readonly receiptLock: ReceiptClearLock = ImportLockService,
  ) {}

  async clearReceipts(userId: string): Promise<ReceiptClearResult> {
    const lockHandle = await this.receiptLock.acquireLockWithWait(userId, 300000);
    if (!lockHandle) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'An import is still finishing. Please try clearing receipts again.',
      );
    }

    let deletedReceipts = 0;
    try {
      await this.postgres.withTransaction(async (transaction) => {
        await transaction.query('UPDATE users SET import_generation=import_generation+1,updated_at=NOW() WHERE id=$1', [userId]);
        await transaction.query(
          `UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW()
           WHERE user_id=$1 AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')`,
          [userId],
        );
        await transaction.query('DELETE FROM import_receipt_staging WHERE job_id IN (SELECT id FROM import_jobs WHERE user_id=$1)', [userId]);
        const receiptResult = await transaction.query('DELETE FROM receipts WHERE user_id = $1', [
          userId,
        ]);
        deletedReceipts = receiptResult.rowCount ?? 0;
        await transaction.query('DELETE FROM receipt_observations WHERE user_id=$1', [userId]);
        await transaction.query('DELETE FROM receipt_repair_source_batches WHERE user_id=$1', [userId]);
        await transaction.query('DELETE FROM receipt_association_reviews WHERE user_id=$1', [userId]);
        await transaction.query('DELETE FROM receipt_repair_manifests WHERE user_id=$1',[userId]);
        await transaction.query('DELETE FROM receipt_import_batches WHERE user_id=$1',[userId]);
        await transaction.query('DELETE FROM receipt_reconciliation_lineage WHERE user_id=$1',[userId]);
        await transaction.query('DELETE FROM gmail_sync_runs WHERE user_id = $1', [userId]);
        await transaction.query('DELETE FROM user_experience_state WHERE user_id = $1', [userId]);

        // Clearing receipt history resets source coverage while deliberately
        // preserving provider connection and consent decisions.
        await transaction.query(
          `UPDATE user_import_preferences
           SET gmail_import_status = 'never_started',
               gmail_import_updated_at = NOW(),
               gmail_imported_count = 0,
               gmail_import_error_code = NULL,
               gmail_baseline_completed_at = NULL,
               last_check_attempt_at = NULL,
               last_successful_check_at = NULL,
               last_stats_updated_at = NULL,
               last_new_order_at = NULL,
               last_tracking_error_at = NULL,
               last_tracking_error_code = NULL,
               tracking_status = 'inactive',
               initial_setup_deferred_until = NULL,
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId],
        );
        await transaction.query(
          `UPDATE user_export_provider_preferences
           SET status = 'not_started', relevance = 'unknown', error_code = NULL, updated_at = NOW()
           WHERE user_id = $1`,
          [userId],
        );

        await this.receiptLock.assertLockOwned(lockHandle);
      });
    } finally {
      await this.receiptLock.releaseLock(lockHandle);
    }

    await this.cache.invalidateAllUserCaches(userId);
    return { deletedReceipts };
  }
}
