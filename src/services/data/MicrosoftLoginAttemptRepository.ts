import { ConflictError } from '../../core/errors';
import type { User } from '../../models/User';
import type { DatabaseConnection, DatabaseQueryExecutor } from '../ports/DatabasePort';
import {
  databaseNullableString,
  databaseRow,
  databaseString,
  databaseTimestamp,
  databaseUuid,
} from './DatabaseRowDecoder';
import { OAuthRepository } from './OAuthRepository';
import { UserRepository } from './UserRepository';

export type MicrosoftLoginAttemptStatus =
  | 'pending_identity'
  | 'email_verification_required'
  | 'completed';

export interface MicrosoftLoginAttempt {
  readonly id: string;
  readonly nonceHash: string;
  readonly status: MicrosoftLoginAttemptStatus;
  readonly providerUserId?: string;
  readonly suggestedEmail?: string;
  readonly expiresAt: Date;
}

const mapAttempt = (value: unknown): MicrosoftLoginAttempt => {
  const row = databaseRow(value, 'Microsoft login attempt');
  const status = databaseString(row, 'status');
  if (
    status !== 'pending_identity' &&
    status !== 'email_verification_required' &&
    status !== 'completed'
  ) {
    throw new Error('Invalid Microsoft login attempt status');
  }
  const expiresAt = databaseTimestamp(row, 'expires_at');
  if (!expiresAt) throw new Error('Invalid Microsoft login attempt expiry');
  return {
    id: databaseUuid(row, 'id'),
    nonceHash: databaseString(row, 'nonce_hash'),
    status,
    providerUserId: databaseNullableString(row, 'provider_user_id') ?? undefined,
    suggestedEmail: databaseNullableString(row, 'suggested_email') ?? undefined,
    expiresAt: new Date(expiresAt),
  };
};

export class MicrosoftLoginAttemptRepository {
  constructor(private readonly postgres: DatabaseConnection) {}

  async create(
    id: string,
    attemptTokenHash: string,
    nonceHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO oauth_login_attempts
         (id, provider, attempt_token_hash, nonce_hash, status, expires_at)
       VALUES ($1, 'microsoft', $2, $3, 'pending_identity', $4)`,
      [id, attemptTokenHash, nonceHash, expiresAt],
    );
  }

  async findActiveByTokenHash(
    attemptTokenHash: string,
    executor: DatabaseQueryExecutor = this.postgres,
  ): Promise<MicrosoftLoginAttempt | undefined> {
    const result = await executor.query(
      `SELECT id, nonce_hash, status, provider_user_id, suggested_email, expires_at
       FROM oauth_login_attempts
       WHERE provider = 'microsoft' AND attempt_token_hash = $1
         AND status <> 'completed' AND expires_at > NOW()`,
      [attemptTokenHash],
    );
    return result.rows[0] ? mapAttempt(result.rows[0]) : undefined;
  }

  async requireEmailVerification(
    attemptId: string,
    providerUserId: string,
    suggestedEmail?: string,
  ): Promise<void> {
    const result = await this.postgres.query(
      `UPDATE oauth_login_attempts
       SET status = 'email_verification_required', provider_user_id = $2,
           suggested_email = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'pending_identity' AND expires_at > NOW()`,
      [attemptId, providerUserId, suggestedEmail ?? null],
    );
    if (!result.rowCount) throw this.expiredAttempt();
  }

  async setVerificationEmail(attemptId: string, email: string): Promise<void> {
    const result = await this.postgres.query(
      `UPDATE oauth_login_attempts
       SET suggested_email = $2, verification_sent_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'email_verification_required' AND expires_at > NOW()
         AND (verification_sent_at IS NULL OR verification_sent_at <= NOW() - INTERVAL '60 seconds')`,
      [attemptId, email.toLowerCase().trim()],
    );
    if (!result.rowCount) {
      throw new ConflictError(
        'MICROSOFT_VERIFICATION_COOLDOWN',
        'Wait before requesting another verification code.',
      );
    }
  }

  async complete(
    attemptId: string,
    providerUserId: string,
    email?: string,
  ): Promise<User> {
    return this.postgres.withTransaction((transaction) =>
      this.completeWithExecutor(attemptId, providerUserId, email, transaction),
    );
  }

  /**
   * Creates a Microsoft-linked account without asserting email ownership.
   * An existing email is never linked here; callers can fall back to verification.
   */
  async completeUnverifiedNewAccount(
    attemptId: string,
    providerUserId: string,
    email: string,
  ): Promise<User | undefined> {
    return this.postgres.withTransaction(async (transaction) => {
      const attemptResult = await transaction.query(
        `SELECT id, provider_user_id
         FROM oauth_login_attempts
         WHERE id = $1 AND status <> 'completed' AND expires_at > NOW()
         FOR UPDATE`,
        [attemptId],
      );
      if (!attemptResult.rows[0]) throw this.expiredAttempt();
      const locked = databaseRow(attemptResult.rows[0], 'locked Microsoft login attempt');
      const recordedProviderUserId = databaseNullableString(locked, 'provider_user_id');
      if (recordedProviderUserId && recordedProviderUserId !== providerUserId) {
        throw new ConflictError(
          'OAUTH_ACCOUNT_CONFLICT',
          'This Microsoft sign-in attempt belongs to a different account.',
        );
      }

      const users = new UserRepository(transaction);
      const oauthAccounts = new OAuthRepository(transaction);
      const linked = await oauthAccounts.findByProvider('microsoft', providerUserId);
      if (linked) {
        const linkedUser = await users.findById(linked.userId);
        if (!linkedUser) {
          throw new ConflictError(
            'OAUTH_ACCOUNT_CONFLICT',
            'The linked Microsoft account no longer exists.',
          );
        }
        await this.markCompleted(attemptId, providerUserId, transaction);
        return linkedUser;
      }

      const normalizedEmail = email.toLowerCase().trim();
      const inserted = await transaction.query(
        `INSERT INTO users (id, email, timezone, email_verified, created_at)
         VALUES (gen_random_uuid(), $1, 'America/New_York', FALSE, NOW())
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [normalizedEmail],
      );
      if (!inserted.rows[0]) return undefined;

      const userId = databaseUuid(
        databaseRow(inserted.rows[0], 'unverified Microsoft login user'),
        'id',
      );
      await transaction.query(
        `INSERT INTO oauth_accounts
           (id, user_id, provider, provider_user_id, email, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'microsoft', $2, $3, NOW(), NOW())
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [userId, providerUserId, normalizedEmail],
      );
      const winningLink = await oauthAccounts.findByProvider('microsoft', providerUserId);
      if (!winningLink || winningLink.userId !== userId) {
        throw new ConflictError(
          'OAUTH_ACCOUNT_CONFLICT',
          'This Microsoft account is already linked to another SnackTrack account.',
        );
      }
      const user = await users.findById(userId);
      if (!user) throw new Error('Microsoft-authenticated account could not be loaded');
      await this.markCompleted(attemptId, providerUserId, transaction);
      return user;
    });
  }

  async completeWithExecutor(
    attemptId: string,
    providerUserId: string,
    email: string | undefined,
    transaction: DatabaseQueryExecutor,
  ): Promise<User> {
    const attemptResult = await transaction.query(
      `SELECT id, provider_user_id
       FROM oauth_login_attempts
       WHERE id = $1 AND status <> 'completed' AND expires_at > NOW()
       FOR UPDATE`,
      [attemptId],
    );
    if (!attemptResult.rows[0]) throw this.expiredAttempt();
    const locked = databaseRow(attemptResult.rows[0], 'locked Microsoft login attempt');
    const recordedProviderUserId = databaseNullableString(locked, 'provider_user_id');
    if (recordedProviderUserId && recordedProviderUserId !== providerUserId) {
      throw new ConflictError(
        'OAUTH_ACCOUNT_CONFLICT',
        'This Microsoft sign-in attempt belongs to a different account.',
      );
    }

    const users = new UserRepository(transaction);
    const oauthAccounts = new OAuthRepository(transaction);
    const linked = await oauthAccounts.findByProvider('microsoft', providerUserId);
    let user: User | undefined;
    if (linked) {
      user = await users.findById(linked.userId);
      if (!user) {
        throw new ConflictError(
          'OAUTH_ACCOUNT_CONFLICT',
          'The linked Microsoft account no longer exists.',
        );
      }
      if (email) {
        const normalizedEmail = email.toLowerCase().trim();
        if (user.email.toLowerCase() !== normalizedEmail) {
          throw new ConflictError(
            'OAUTH_ACCOUNT_CONFLICT',
            'This Microsoft account is already linked to another SnackTrack account.',
          );
        }
        if (!user.emailVerified) {
          await users.updateEmailVerified(normalizedEmail, true, transaction);
          user = { ...user, emailVerified: true };
        }
      }
    } else {
      if (!email) {
        throw new ConflictError(
          'MICROSOFT_EMAIL_VERIFICATION_REQUIRED',
          'An email address must be verified to finish Microsoft sign-in.',
        );
      }
      const normalizedEmail = email.toLowerCase().trim();
      const inserted = await transaction.query(
        `INSERT INTO users (id, email, timezone, email_verified, created_at)
         VALUES (gen_random_uuid(), $1, 'America/New_York', TRUE, NOW())
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [normalizedEmail],
      );
      const userId = databaseUuid(databaseRow(inserted.rows[0], 'Microsoft login user'), 'id');
      await transaction.query(
        `INSERT INTO oauth_accounts
           (id, user_id, provider, provider_user_id, email, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'microsoft', $2, $3, NOW(), NOW())
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [userId, providerUserId, normalizedEmail],
      );
      const winningLink = await oauthAccounts.findByProvider('microsoft', providerUserId);
      if (!winningLink || winningLink.userId !== userId) {
        throw new ConflictError(
          'OAUTH_ACCOUNT_CONFLICT',
          'This Microsoft account is already linked to another SnackTrack account.',
        );
      }
      await users.updateEmailVerified(normalizedEmail, true, transaction);
      user = await users.findById(userId);
      if (!user) throw new Error('Microsoft-authenticated account could not be loaded');
    }

    await this.markCompleted(attemptId, providerUserId, transaction);
    return user;
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.postgres.query(
      `DELETE FROM oauth_login_attempts WHERE expires_at < NOW() - INTERVAL '1 day'`,
    );
    return result.rowCount ?? 0;
  }

  private expiredAttempt(): ConflictError {
    return new ConflictError(
      'MICROSOFT_ATTEMPT_EXPIRED',
      'Microsoft sign-in expired. Please try again.',
    );
  }

  private async markCompleted(
    attemptId: string,
    providerUserId: string,
    transaction: DatabaseQueryExecutor,
  ): Promise<void> {
    await transaction.query(
      `UPDATE oauth_login_attempts
       SET status = 'completed', provider_user_id = $2, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [attemptId, providerUserId],
    );
  }
}
