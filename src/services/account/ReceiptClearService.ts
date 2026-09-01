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
        const receiptResult = await transaction.query('DELETE FROM receipts WHERE user_id = $1', [
          userId,
        ]);
        deletedReceipts = receiptResult.rowCount ?? 0;
        await transaction.query('DELETE FROM gmail_sync_runs WHERE user_id = $1', [userId]);

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
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId],
        );
        await transaction.query(
          `UPDATE user_export_provider_preferences
           SET status = 'not_started', error_code = NULL, updated_at = NOW()
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
