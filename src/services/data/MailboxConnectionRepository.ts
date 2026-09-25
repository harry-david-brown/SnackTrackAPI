import { ConflictError, DatabaseError } from '../../core/errors';
import type {
  MailboxImportState,
  MicrosoftMailboxConnection,
  MicrosoftMailboxCredentials,
} from '../mailbox/MailboxConnection';
import type { MailboxSecretCipher } from '../mailbox/MailboxSecretCipher';
import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import {
  databaseNullableString,
  databaseNonNegativeInteger,
  databaseRow,
  databaseString,
  databaseStringArray,
  databaseTimestamp,
  databaseUuid,
} from './DatabaseRowDecoder';

const decodeCredentials = (value: string): MicrosoftMailboxCredentials => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new DatabaseError('Invalid Microsoft mailbox credential payload', cause as Error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DatabaseError('Invalid Microsoft mailbox credential payload');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.tokenCache !== 'string' || typeof record.homeAccountId !== 'string') {
    throw new DatabaseError('Invalid Microsoft mailbox credential payload');
  }
  return { tokenCache: record.tokenCache, homeAccountId: record.homeAccountId };
};

/** PostgreSQL adapter for Microsoft mailbox credentials and import state. */
export class MailboxConnectionRepository {
  constructor(
    private readonly database: DatabaseQueryExecutor,
    private readonly cipher: MailboxSecretCipher,
  ) {}

  async findMicrosoft(userId: string): Promise<MicrosoftMailboxConnection | undefined> {
    const result = await this.database.query(
      `SELECT user_id, provider_account_id, email, scopes, connection_mode, status,
              encrypted_token_cache, token_expires_at
       FROM mailbox_connections
       WHERE user_id = $1 AND provider = 'microsoft'`,
      [userId],
    );
    if (!result.rows[0]) return undefined;
    const row = databaseRow(result.rows[0], 'Microsoft mailbox connection');
    const connectionMode = databaseString(row, 'connection_mode');
    const state = databaseString(row, 'status');
    if (connectionMode !== 'temporary' && connectionMode !== 'offline') {
      throw new DatabaseError('Invalid Microsoft mailbox connection mode');
    }
    if (state !== 'connected' && state !== 'reconnect_required') {
      throw new DatabaseError('Invalid Microsoft mailbox connection state');
    }
    return {
      userId: databaseUuid(row, 'user_id'),
      provider: 'microsoft',
      providerAccountId: databaseString(row, 'provider_account_id'),
      email: databaseString(row, 'email'),
      scopes: databaseStringArray(row, 'scopes'),
      connectionMode,
      state,
      tokenExpiresAt: databaseTimestamp(row, 'token_expires_at'),
      credentials: decodeCredentials(
        this.cipher.decrypt(databaseString(row, 'encrypted_token_cache')),
      ),
    };
  }

  async saveMicrosoft(input: {
    userId: string;
    providerAccountId: string;
    email: string;
    scopes: readonly string[];
    tokenExpiresAt: Date | null;
    credentials: MicrosoftMailboxCredentials;
  }, executor: DatabaseQueryExecutor = this.database): Promise<void> {
    const encrypted = this.cipher.encrypt(JSON.stringify(input.credentials));
    try {
      await executor.query(
        `INSERT INTO mailbox_connections (
         user_id, provider, provider_account_id, email, scopes, connection_mode,
         status, encrypted_token_cache, token_expires_at
       ) VALUES ($1, 'microsoft', $2, $3, $4, 'offline', 'connected', $5, $6)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         email = EXCLUDED.email,
         scopes = EXCLUDED.scopes,
         connection_mode = 'offline',
         status = 'connected',
         encrypted_token_cache = EXCLUDED.encrypted_token_cache,
         token_expires_at = EXCLUDED.token_expires_at,
         updated_at = NOW()`,
        [
          input.userId,
          input.providerAccountId,
          input.email,
          [...input.scopes],
          encrypted,
          input.tokenExpiresAt,
        ],
      );
    } catch (error) {
      const code =
        error && typeof error === 'object' ? (error as Record<string, unknown>).code : undefined;
      if (code === '23505') {
        throw new ConflictError(
          'MAILBOX_ACCOUNT_ALREADY_CONNECTED',
          'This Outlook account is already connected to another SnackTrack account.',
        );
      }
      throw error;
    }
  }

  async updateMicrosoftTokenCache(
    userId: string,
    tokenCache: string,
    tokenExpiresAt: Date | null,
  ): Promise<void> {
    const connection = await this.findMicrosoft(userId);
    if (!connection) return;
    const encrypted = this.cipher.encrypt(
      JSON.stringify({ ...connection.credentials, tokenCache }),
    );
    await this.database.query(
      `UPDATE mailbox_connections
       SET encrypted_token_cache = $2, token_expires_at = $3, status = 'connected', updated_at = NOW()
       WHERE user_id = $1 AND provider = 'microsoft'`,
      [userId, encrypted, tokenExpiresAt],
    );
  }

  async markMicrosoftReconnectRequired(userId: string): Promise<void> {
    await this.database.query(
      `UPDATE mailbox_connections SET status = 'reconnect_required', updated_at = NOW()
       WHERE user_id = $1 AND provider = 'microsoft'`,
      [userId],
    );
  }

  async disconnectMicrosoft(userId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM mailbox_connections WHERE user_id = $1 AND provider = 'microsoft'`,
      [userId],
    );
  }

  async resetMicrosoftImportState(userId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM mailbox_import_states WHERE user_id = $1 AND provider = 'microsoft'`,
      [userId],
    );
  }

  async getMicrosoftImportState(userId: string): Promise<MailboxImportState> {
    const result = await this.database.query(
      `SELECT import_status, imported_count, error_code, baseline_completed_at, updated_at
       FROM mailbox_import_states WHERE user_id = $1 AND provider = 'microsoft'`,
      [userId],
    );
    if (!result.rows[0]) {
      return {
        provider: 'microsoft',
        status: 'never_started',
        updatedAt: null,
        importedCount: 0,
        errorCode: null,
        baselineCompletedAt: null,
      };
    }
    const row = databaseRow(result.rows[0], 'Microsoft mailbox import state');
    const status = databaseString(row, 'import_status');
    if (!['never_started', 'importing', 'completed', 'failed'].includes(status)) {
      throw new DatabaseError('Invalid Microsoft mailbox import status');
    }
    return {
      provider: 'microsoft',
      status: status as MailboxImportState['status'],
      updatedAt: databaseTimestamp(row, 'updated_at'),
      importedCount: databaseNonNegativeInteger(row, 'imported_count'),
      errorCode: databaseNullableString(row, 'error_code'),
      baselineCompletedAt: databaseTimestamp(row, 'baseline_completed_at'),
    };
  }
}
