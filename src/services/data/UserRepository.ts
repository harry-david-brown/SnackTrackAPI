import { User } from '../../models/User';
import { DuplicateUserEmailError } from '../../core/errors';
import { DatabaseQueryExecutor } from '../ports/DatabasePort';
import { v4 as uuidv4 } from 'uuid';
import {
  databaseBoolean,
  databaseNullableString,
  databaseRow,
  databaseString,
  databaseStringArray,
  databaseTimestamp,
  databaseUuid,
} from './DatabaseRowDecoder';
import {
  GmailConnectionMode,
  isGmailConnectionMode,
} from '../import/GmailConnectionContracts';

type UnknownRecord = Record<string, unknown>;

const postgresErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as UnknownRecord).code;
  return typeof code === 'string' ? code : undefined;
};

const requiredTimestamp = (row: UnknownRecord, field: string): string => {
  const value = databaseTimestamp(row, field);
  if (!value) throw new Error(`Invalid user row: ${field}`);
  return value;
};

const mapUser = (value: unknown, includePassword = false): User => {
  const row = databaseRow(value, 'user');
  return {
    id: databaseUuid(row, 'id'),
    email: databaseString(row, 'email'),
    ...(includePassword
      ? { password: databaseNullableString(row, 'password') ?? undefined }
      : {}),
    emailVerified: databaseBoolean(row, 'email_verified'),
    timezone: databaseString(row, 'timezone'),
    createdAt: requiredTimestamp(row, 'created_at'),
  };
};

const gmailConnectionMode = (value: unknown): User['gmailConnectionMode'] => {
  if (isGmailConnectionMode(value)) return value;
  throw new Error('Invalid user row: gmail_connection_mode');
};

/** Typed persistence adapter for account identity and Gmail credential records. */
export class UserRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor) {}

  async createUser(email: string, timezone = 'America/New_York'): Promise<string> {
    const existingUser = await this.findByEmail(email);
    if (existingUser) return existingUser.id;
    const userId = uuidv4();
    try {
      const result = await this.postgres.query(
        'INSERT INTO users (id, email, timezone) VALUES ($1, $2, $3) RETURNING id',
        [userId, email, timezone],
      );
      return databaseUuid(databaseRow(result.rows[0], 'created user'), 'id');
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        const racedUser = await this.findByEmail(email);
        if (racedUser) return racedUser.id;
      }
      throw error;
    }
  }

  async findById(id: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      `SELECT id, email, email_verified, COALESCE(timezone, 'America/New_York') AS timezone,
              created_at FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      `SELECT id, email, email_verified, COALESCE(timezone, 'America/New_York') AS timezone,
              created_at FROM users WHERE email = $1`,
      [email],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async findByEmailWithPassword(email: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      `SELECT id, email, password, email_verified,
              COALESCE(timezone, 'America/New_York') AS timezone, created_at
       FROM users WHERE email = $1`,
      [email],
    );
    return result.rows[0] ? mapUser(result.rows[0], true) : undefined;
  }

  async createUserWithPassword(
    email: string,
    hashedPassword: string,
    timezone = 'America/New_York',
  ): Promise<string> {
    if (await this.findByEmail(email)) throw new DuplicateUserEmailError();
    const userId = uuidv4();
    try {
      const result = await this.postgres.query(
        `INSERT INTO users (id, email, password, email_verified, timezone, created_at)
         VALUES ($1, $2, $3, FALSE, $4, NOW()) RETURNING id`,
        [userId, email, hashedPassword, timezone],
      );
      return databaseUuid(databaseRow(result.rows[0], 'created user'), 'id');
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new DuplicateUserEmailError();
      }
      throw error;
    }
  }

  async updateEmailVerified(
    email: string,
    verified: boolean,
    executor: DatabaseQueryExecutor = this.postgres,
  ): Promise<boolean> {
    const result = await executor.query(
      'UPDATE users SET email_verified = $1, updated_at = NOW() WHERE email = $2',
      [verified, email],
    );
    return Boolean(result.rowCount);
  }

  async updatePassword(
    email: string,
    hashedPassword: string,
    executor: DatabaseQueryExecutor = this.postgres,
  ): Promise<boolean> {
    const result = await executor.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE email = $2',
      [hashedPassword, email],
    );
    return Boolean(result.rowCount);
  }

  async updateTimezone(userId: string, timezone: string): Promise<void> {
    if (!timezone || timezone.length > 50) throw new Error('Invalid timezone format');
    await this.postgres.query('UPDATE users SET timezone = $1, updated_at = NOW() WHERE id = $2', [
      timezone,
      userId,
    ]);
  }

  async updateGmailTokens(
    userId: string,
    input: {
      refreshToken?: string | null;
      accessToken: string;
      expiryDate: Date;
      gmailEmail?: string;
      scopes: string[];
      connectionMode: Exclude<GmailConnectionMode, 'none'>;
    },
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE users SET
         gmail_refresh_token = $1, gmail_access_token = $2, gmail_token_expiry = $3,
         gmail_connected = TRUE, gmail_email = $4, gmail_scopes = $5,
         gmail_connection_mode = $6, updated_at = NOW()
       WHERE id = $7`,
      [
        input.refreshToken ?? null,
        input.accessToken,
        input.expiryDate,
        input.gmailEmail ?? null,
        input.scopes,
        input.connectionMode,
        userId,
      ],
    );
  }

  async findByIdWithGmailTokens(userId: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      `SELECT id, email, email_verified, COALESCE(timezone, 'America/New_York') AS timezone,
              gmail_refresh_token, gmail_access_token, gmail_token_expiry, gmail_connected,
              gmail_email, gmail_scopes, gmail_connection_mode, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!result.rows[0]) return undefined;
    const row = databaseRow(result.rows[0], 'Gmail user');
    return {
      ...mapUser(row),
      gmailRefreshToken: databaseNullableString(row, 'gmail_refresh_token') ?? undefined,
      gmailAccessToken: databaseNullableString(row, 'gmail_access_token') ?? undefined,
      gmailTokenExpiry: databaseTimestamp(row, 'gmail_token_expiry') ?? undefined,
      gmailConnected: databaseBoolean(row, 'gmail_connected'),
      gmailEmail: databaseNullableString(row, 'gmail_email') ?? undefined,
      gmailScopes: databaseStringArray(row, 'gmail_scopes'),
      gmailConnectionMode: gmailConnectionMode(row.gmail_connection_mode),
    };
  }

  async disconnectGmail(userId: string): Promise<void> {
    await this.postgres.query(
      `UPDATE users SET
         gmail_refresh_token = NULL, gmail_access_token = NULL, gmail_token_expiry = NULL,
         gmail_connected = FALSE, gmail_email = NULL, gmail_scopes = ARRAY[]::TEXT[],
         gmail_connection_mode = 'none', updated_at = NOW()
       WHERE id = $1`,
      [userId],
    );
  }

  async markGmailReconnectRequired(userId: string): Promise<void> {
    await this.postgres.query(
      `UPDATE users SET
         gmail_refresh_token = NULL, gmail_access_token = NULL, gmail_token_expiry = NULL,
         gmail_connected = TRUE, gmail_connection_mode = 'temporary', updated_at = NOW()
       WHERE id = $1`,
      [userId],
    );
  }

  async hasGmailConnected(userId: string): Promise<boolean> {
    const result = await this.postgres.query(
      'SELECT gmail_connected FROM users WHERE id = $1',
      [userId],
    );
    return result.rows[0]
      ? databaseBoolean(databaseRow(result.rows[0], 'Gmail connection'), 'gmail_connected')
      : false;
  }
}
