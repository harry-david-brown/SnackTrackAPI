import { ConflictError, NotFoundError } from '../../core/errors';
import { PostgresService } from '../data/PostgresService';
import { ImportLockHandle, ImportLockService } from '../import/ImportLockService';

interface AccountDeletionLock {
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

interface RefreshTokenRevoker {
  revokeRefreshToken(token: string): Promise<void>;
}

export interface AccountDeletionResult {
  deleted: true;
}

/** Permanently deletes one account and all relational user-owned data. */
export class AccountDeletionService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly cache: UserCacheInvalidator,
    private readonly connectionHealth: ConnectionHealthInvalidator,
    private readonly tokenRevoker: RefreshTokenRevoker,
    private readonly accountLock: AccountDeletionLock = ImportLockService
  ) {}

  async deleteAccount(userId: string, refreshToken?: string): Promise<AccountDeletionResult> {
    const lockHandle = await this.accountLock.acquireLockWithWait(userId, 300000);
    if (!lockHandle) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'An account operation is still finishing. Please try deletion again.'
      );
    }

    try {
      const client = await this.postgres.getClient();
      try {
        await client.query('BEGIN');
        const userResult = await client.query<{ email: string }>(
          'SELECT email FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        const email = userResult.rows[0]?.email;
        if (!email) throw new NotFoundError('User', userId);

        // Verification codes are keyed by email rather than user_id and are
        // therefore not covered by the users ON DELETE CASCADE graph.
        await client.query('DELETE FROM verification_codes WHERE email = $1', [email]);
        const deleteResult = await client.query(
          'DELETE FROM users WHERE id = $1',
          [userId]
        );
        if (!deleteResult.rowCount) throw new NotFoundError('User', userId);

        await this.accountLock.assertLockOwned(lockHandle);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await this.accountLock.releaseLock(lockHandle);
    }

    this.connectionHealth.invalidate(userId);
    await this.cache.invalidateAllUserCaches(userId);
    if (refreshToken) await this.tokenRevoker.revokeRefreshToken(refreshToken);
    return { deleted: true };
  }
}
