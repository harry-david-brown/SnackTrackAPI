import { ConflictError, NotFoundError } from '../../core/errors';
import { ImportLockHandle, ImportLockService } from '../import/ImportLockService';
import { DatabaseTransactionRunner } from '../ports/DatabasePort';

interface AccountResetLock {
  acquireLockWithWait(userId: string, timeoutMs?: number): Promise<ImportLockHandle | null>;
  assertLockOwned(handle: ImportLockHandle): Promise<void>;
  releaseLock(handle: ImportLockHandle): Promise<boolean>;
}

interface UserCacheInvalidator {
  invalidateAllUserCaches(userId: string): Promise<void>;
}

interface ConnectionHealthInvalidator {
  invalidate(userId: string): void;
}

export interface AccountResetResult {
  deletedReceipts: number;
}

/** Restores import-related account data to the defaults of a new user. */
export class AccountResetService {
  constructor(
    private readonly postgres: DatabaseTransactionRunner,
    private readonly cache: UserCacheInvalidator,
    private readonly connectionHealth: ConnectionHealthInvalidator,
    private readonly importLock: AccountResetLock = ImportLockService,
  ) {}

  async resetForOnboarding(userId: string): Promise<AccountResetResult> {
    const lockHandle = await this.importLock.acquireLockWithWait(userId, 300000);
    if (!lockHandle) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'An import is still finishing. Please try the reset again.',
      );
    }

    let result: AccountResetResult;
    try {
      result = await this.resetInTransaction(userId, lockHandle);
    } finally {
      await this.importLock.releaseLock(lockHandle);
    }

    this.connectionHealth.invalidate(userId);
    await this.cache.invalidateAllUserCaches(userId);
    return result;
  }

  private async resetInTransaction(
    userId: string,
    lockHandle: ImportLockHandle,
  ): Promise<AccountResetResult> {
    return this.postgres.withTransaction(async (transaction) => {
      const userResult = await transaction.query(
        `UPDATE users SET
           gmail_refresh_token = NULL,
           gmail_access_token = NULL,
           gmail_token_expiry = NULL,
           gmail_connected = FALSE,
           gmail_email = NULL,
           gmail_scopes = ARRAY[]::TEXT[],
           gmail_connection_mode = 'none',
           import_generation = import_generation + 1,
           updated_at = NOW()
         WHERE id = $1`,
        [userId],
      );
      if (!userResult.rowCount) throw new NotFoundError('User', userId);

      await transaction.query(
        `UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW()
         WHERE user_id=$1 AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')`,
        [userId],
      );

      const receiptResult = await transaction.query('DELETE FROM receipts WHERE user_id = $1', [
        userId,
      ]);
      await transaction.query('DELETE FROM mailbox_connections WHERE user_id = $1', [userId]);
      await transaction.query('DELETE FROM mailbox_sync_runs WHERE user_id = $1', [userId]);
      await transaction.query('DELETE FROM mailbox_import_states WHERE user_id = $1', [userId]);
      await transaction.query('DELETE FROM gmail_sync_runs WHERE user_id = $1', [userId]);
      await transaction.query('DELETE FROM user_import_preference_events WHERE user_id = $1', [
        userId,
      ]);
      await transaction.query('DELETE FROM user_export_provider_preferences WHERE user_id = $1', [
        userId,
      ]);
      await transaction.query('DELETE FROM user_import_preferences WHERE user_id = $1', [userId]);
      await transaction.query('DELETE FROM user_experience_state WHERE user_id = $1', [userId]);
      await transaction.query('INSERT INTO user_import_preferences (user_id) VALUES ($1)', [
        userId,
      ]);

      await this.importLock.assertLockOwned(lockHandle);
      return { deletedReceipts: receiptResult.rowCount || 0 };
    });
  }
}
