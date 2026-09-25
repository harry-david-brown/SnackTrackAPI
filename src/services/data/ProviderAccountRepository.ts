import { AuthenticationError, ConflictError } from '../../core/errors';
import type { ProviderAccountIdentity, ProviderAccountPort } from '../ports/AuthPorts';
import type { User } from '../../models/User';
import type { DatabaseConnection, DatabaseQueryExecutor } from '../ports/DatabasePort';
import { databaseRow, databaseUuid } from './DatabaseRowDecoder';
import { OAuthRepository } from './OAuthRepository';
import { UserRepository } from './UserRepository';

/** Existing email addresses are never authorization to add a new login method. */
export class ProviderAccountRepository implements ProviderAccountPort {
  constructor(private readonly database: DatabaseConnection) {}

  resolve(identity: ProviderAccountIdentity): Promise<User> {
    return this.database.withTransaction((transaction) =>
      ProviderAccountRepository.resolveWithExecutor(identity, transaction));
  }

  static async resolveWithExecutor(
    identity: ProviderAccountIdentity,
    transaction: DatabaseQueryExecutor,
  ): Promise<User> {
    const users = new UserRepository(transaction);
    const identities = new OAuthRepository(transaction);
    const linked = await identities.findByProvider(identity.provider, identity.providerUserId);
    if (linked) {
      await transaction.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [linked.userId]);
      // Recovery locks the user before deleting links. Re-read after acquiring that lock
      // so a removed provider cannot mint a session using the new recovery generation.
      const currentLink = await identities.findByProvider(identity.provider, identity.providerUserId);
      if (!currentLink || currentLink.userId !== linked.userId) {
        throw new ConflictError('OAUTH_ACCOUNT_CONFLICT', 'This sign-in method was removed. Use your password to sign in.');
      }
      const user = await users.findById(linked.userId);
      if (user?.emailVerified) return user;
      throw new ConflictError('OAUTH_ACCOUNT_CONFLICT',
        'Recover this account with a password reset before signing in.');
    }
    const email = identity.email?.trim().toLowerCase();
    if (!email || !identity.emailVerified) {
      throw new AuthenticationError(
        'Verify your email with the provider, or sign up with email and password.',
        'PROVIDER_EMAIL_VERIFICATION_REQUIRED');
    }
    const inserted = await transaction.query(
      `INSERT INTO users (id, email, timezone, email_verified, created_at)
       VALUES (gen_random_uuid(), $1, 'America/New_York', TRUE, NOW())
       ON CONFLICT (email) DO NOTHING RETURNING id`, [email]);
    if (!inserted.rows[0]) {
      // Includes races with password registration: never adopt the winning account.
      throw new ConflictError('OAUTH_ACCOUNT_CONFLICT',
        'An account with this email already exists. Use its existing sign-in method or reset its password.');
    }
    const id = databaseUuid(databaseRow(inserted.rows[0], 'provider account'), 'id');
    await transaction.query(
      `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [id, identity.provider, identity.providerUserId, email]);
    const winningLink = await identities.findByProvider(identity.provider, identity.providerUserId);
    if (!winningLink || winningLink.userId !== id) {
      // Throwing rolls back the newly inserted user as well as its attempted link.
      throw new ConflictError('OAUTH_ACCOUNT_CONFLICT', 'This provider account is already linked. Please sign in again.');
    }
    const user = await users.findById(id);
    if (!user) throw new Error('Provider-authenticated account could not be loaded');
    return user;
  }
}
