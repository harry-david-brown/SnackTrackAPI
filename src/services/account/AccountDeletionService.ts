import { ConflictError, NotFoundError } from '../../core/errors';
import { DatabaseTransactionRunner } from '../ports/DatabasePort';
import { databaseRow, databaseString } from '../data/DatabaseRowDecoder';
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

interface AccountDeletionLogger {
  warn(message: string, metadata: Readonly<Record<string, unknown>>): void;
}

const silentLogger: AccountDeletionLogger = { warn: () => undefined };

export interface AccountDeletionResult {
  deleted: true;
}

/** Permanently deletes one account and all relational user-owned data. */
export class AccountDeletionService {
  constructor(
    private readonly postgres: DatabaseTransactionRunner,
    private readonly cache: UserCacheInvalidator,
    private readonly connectionHealth: ConnectionHealthInvalidator,
    private readonly tokenRevoker: RefreshTokenRevoker,
    private readonly accountLock: AccountDeletionLock = ImportLockService,
    private readonly logger: AccountDeletionLogger = silentLogger,
  ) {}

  async deleteAccount(userId: string, refreshToken?: string): Promise<AccountDeletionResult> {
    const lockHandle = await this.accountLock.acquireLockWithWait(userId, 300000);
    if (!lockHandle) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'An account operation is still finishing. Please try deletion again.',
      );
    }

    try {
      await this.postgres.withTransaction(async (transaction) => {
        const userResult = await transaction.query<{ email: unknown }>(
          'SELECT email FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        const email = userResult.rows[0]
          ? databaseString(databaseRow(userResult.rows[0], 'account deletion user'), 'email')
          : undefined;

        // Verification codes are keyed by email rather than user_id and are
        // therefore not covered by the users ON DELETE CASCADE graph.
        if (email) {
          await transaction.query('DELETE FROM verification_codes WHERE email = $1', [email]);
          const deleteResult = await transaction.query('DELETE FROM users WHERE id = $1', [userId]);
          if (!deleteResult.rowCount) throw new NotFoundError('User', userId);
        }

        await this.accountLock.assertLockOwned(lockHandle);
      });
    } finally {
      await this.accountLock.releaseLock(lockHandle);
    }

    await this.bestEffort('connection_health_invalidation', userId, async () => {
      this.connectionHealth.invalidate(userId);
    });
    await this.bestEffort('cache_invalidation', userId, () =>
      this.cache.invalidateAllUserCaches(userId),
    );
    if (refreshToken) {
      await this.bestEffort('refresh_token_revocation', userId, () =>
        this.tokenRevoker.revokeRefreshToken(refreshToken),
      );
    }
    return { deleted: true };
  }

  private async bestEffort(
    effect: string,
    userId: string,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    const maximumAttempts = 2;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        const willRetry = attempt < maximumAttempts;
        this.logger.warn(
          willRetry
            ? 'Post-commit account deletion cleanup will retry'
            : 'Post-commit account deletion cleanup failed',
          {
            userId,
            operation: 'account_deletion',
            outcome: willRetry ? 'post_commit_cleanup_retrying' : 'post_commit_cleanup_failed',
            effect,
            attempt,
            maximumAttempts,
            error,
          },
        );
      }
    }
  }
}
