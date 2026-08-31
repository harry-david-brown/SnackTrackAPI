import { ConflictError, NotFoundError } from '../../core/errors';
import { ImportLockHandle, ImportLockService } from '../import/ImportLockService';
import { PostgresService } from './PostgresService';

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
    private readonly postgres: PostgresService,
    private readonly cache: UserCacheInvalidator,
    private readonly connectionHealth: ConnectionHealthInvalidator,
    private readonly importLock: AccountResetLock = ImportLockService
  ) {}

  async resetForOnboarding(userId: string): Promise<AccountResetResult> {
    const lockHandle = await this.importLock.acquireLockWithWait(userId, 300000);
    if (!lockHandle) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'An import is still finishing. Please try the reset again.'
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
    lockHandle: ImportLockHandle
  ): Promise<AccountResetResult> {
    const client = await this.postgres.getClient();
    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `UPDATE users SET
           gmail_refresh_token = NULL,
           gmail_access_token = NULL,
           gmail_token_expiry = NULL,
           gmail_connected = FALSE,
           gmail_email = NULL,
           gmail_scopes = ARRAY[]::TEXT[],
           gmail_connection_mode = 'none',
           updated_at = NOW()
         WHERE id = $1`,
        [userId]
      );
      if (!userResult.rowCount) throw new NotFoundError('User', userId);

      const receiptResult = await client.query(
        'DELETE FROM receipts WHERE user_id = $1',
        [userId]
      );
      await client.query('DELETE FROM gmail_sync_runs WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_import_preference_events WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_export_provider_preferences WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_import_preferences WHERE user_id = $1', [userId]);
      await client.query('INSERT INTO user_import_preferences (user_id) VALUES ($1)', [userId]);

      await this.importLock.assertLockOwned(lockHandle);
      await client.query('COMMIT');
      return { deletedReceipts: receiptResult.rowCount || 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
