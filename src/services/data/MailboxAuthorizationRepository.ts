import { createHash, randomBytes } from 'crypto';
import { ConflictError, ValidationError } from '../../core/errors';
import type { MailboxSecretCipher } from '../mailbox/MailboxSecretCipher';
import type { DatabaseConnection, DatabaseQueryExecutor } from '../ports/DatabasePort';
import type { AuthorizationMailboxProvider, MailboxAuthorizationClaim, MailboxAuthorizationPort } from '../ports/MailboxAuthorizationPort';
import { databaseNonNegativeInteger, databaseRow, databaseString } from './DatabaseRowDecoder';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const expired = () => new ConflictError('MAILBOX_AUTHORIZATION_EXPIRED',
  'This email connection expired or belongs to another session. Start the connection again.');

/** Stores only encrypted, short-lived callbacks; no usable mailbox grant exists until app completion. */
export class MailboxAuthorizationRepository implements MailboxAuthorizationPort {
  constructor(private readonly database: DatabaseConnection, private readonly cipher: MailboxSecretCipher) {}

  async register(userId: string, provider: AuthorizationMailboxProvider, authUrl: string,
    verifierHash: string, sessionVersion: number): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(verifierHash)) {
      throw new ValidationError('Update the app and start the email connection again.', 'handoffChallenge');
    }
    const state = new URL(authUrl).searchParams.get('state');
    if (!state) throw new Error('Provider authorization URL is missing state');
    await this.database.query('DELETE FROM mailbox_authorization_attempts WHERE expires_at <= NOW()');
    const result = await this.database.query(
      `INSERT INTO mailbox_authorization_attempts
         (state_hash, user_id, provider, verifier_hash, session_version, import_generation)
       SELECT $1, id, $3, $4, session_version, import_generation FROM users
       WHERE id = $2 AND session_version = $5 AND deletion_requested_at IS NULL`,
      [hash(state), userId, provider, verifierHash, sessionVersion]);
    if (!result.rowCount) throw expired();
  }

  async receive(provider: AuthorizationMailboxProvider, state: string, code?: string): Promise<string> {
    const completionToken = randomBytes(32).toString('hex');
    const result = await this.database.query(
      `UPDATE mailbox_authorization_attempts
       SET completion_hash = $3, encrypted_callback = $4
       WHERE state_hash = $1 AND provider = $2 AND completion_hash IS NULL AND expires_at > NOW()`,
      [hash(state), provider, hash(completionToken),
        code ? this.cipher.encrypt(JSON.stringify({ state, code })) : null]);
    if (!result.rowCount) throw expired();
    return completionToken;
  }

  async consume(userId: string, provider: AuthorizationMailboxProvider, completionToken: string,
    verifier: string): Promise<MailboxAuthorizationClaim> {
    if (!/^[a-f0-9]{64}$/.test(completionToken) || !/^[a-f0-9]{64}$/.test(verifier)) throw expired();
    const result = await this.database.query(
      `UPDATE mailbox_authorization_attempts a SET claimed_at = NOW() FROM users u
       WHERE a.user_id = u.id AND a.user_id = $1 AND a.provider = $2
         AND a.completion_hash = $3 AND a.verifier_hash = $4 AND a.expires_at > NOW()
         AND a.encrypted_callback IS NOT NULL AND a.claimed_at IS NULL
         AND a.session_version = u.session_version AND a.import_generation = u.import_generation
         AND u.deletion_requested_at IS NULL
       RETURNING a.state_hash, a.session_version, a.import_generation::text, a.encrypted_callback`,
      [userId, provider, hash(completionToken), hash(verifier)]);
    if (!result.rows[0]) throw expired();
    const row = databaseRow(result.rows[0], 'mailbox authorization');
    const callback = databaseRow(JSON.parse(this.cipher.decrypt(databaseString(row, 'encrypted_callback'))), 'mailbox callback');
    return { userId, stateHash: databaseString(row, 'state_hash'), sessionVersion: databaseNonNegativeInteger(row, 'session_version'),
      importGeneration: databaseString(row, 'import_generation'),
      state: databaseString(callback, 'state'), code: databaseString(callback, 'code') };
  }

  async cancel(userId: string, provider: AuthorizationMailboxProvider): Promise<void> {
    await this.database.query('DELETE FROM mailbox_authorization_attempts WHERE user_id=$1 AND provider=$2', [userId, provider]);
  }

  async persist(claim: MailboxAuthorizationClaim,
    write: (transaction: DatabaseQueryExecutor) => Promise<void>): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      // Serialize against password recovery, account deletion, and import-data resets.
      const current = await transaction.query(
        `SELECT id FROM users WHERE id = $1 AND session_version = $2 AND import_generation = $3 AND deletion_requested_at IS NULL FOR UPDATE`,
        [claim.userId, claim.sessionVersion, claim.importGeneration]);
      if (!current.rows[0]) throw expired();
      const attempt = await transaction.query(
        `DELETE FROM mailbox_authorization_attempts WHERE state_hash=$1 AND user_id=$2
           AND claimed_at IS NOT NULL AND expires_at > NOW() RETURNING state_hash`,
        [claim.stateHash, claim.userId]);
      if (!attempt.rowCount) throw expired();
      await write(transaction);
    });
  }
}
