import { AuthProvider, OAuthAccount } from '../../models/OAuthAccount';
import { DatabaseQueryExecutor } from '../ports/DatabasePort';
import { v4 as uuidv4 } from 'uuid';
import {
  databaseEnum,
  databaseNullableString,
  databaseRow,
  databaseString,
  databaseTimestamp,
  databaseUuid,
} from './DatabaseRowDecoder';

const AUTH_PROVIDERS: readonly AuthProvider[] = ['google', 'apple'];

const mapOAuthAccount = (value: unknown): OAuthAccount => {
  const row = databaseRow(value, 'OAuth account');
  const tokenExpiry = databaseTimestamp(row, 'token_expiry');
  const createdAt = databaseTimestamp(row, 'created_at');
  const updatedAt = databaseTimestamp(row, 'updated_at');
  if (!createdAt || !updatedAt) throw new Error('Invalid OAuth account timestamps');
  return {
    id: databaseUuid(row, 'id'),
    userId: databaseUuid(row, 'user_id'),
    provider: databaseEnum(row, 'provider', AUTH_PROVIDERS),
    providerUserId: databaseString(row, 'provider_user_id'),
    email: databaseNullableString(row, 'email') ?? undefined,
    accessToken: databaseNullableString(row, 'access_token') ?? undefined,
    refreshToken: databaseNullableString(row, 'refresh_token') ?? undefined,
    tokenExpiry: tokenExpiry ? new Date(tokenExpiry) : undefined,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  };
};

/** Typed persistence adapter for authentication-provider identity links. */
export class OAuthRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor) {}

  async create(data: Omit<OAuthAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const id = uuidv4();
    await this.postgres.query(
      `INSERT INTO oauth_accounts (
         id, user_id, provider, provider_user_id, email,
         access_token, refresh_token, token_expiry, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        id,
        data.userId,
        data.provider,
        data.providerUserId,
        data.email ?? null,
        data.accessToken ?? null,
        data.refreshToken ?? null,
        data.tokenExpiry ?? null,
      ],
    );
    return id;
  }

  async findByProvider(
    provider: AuthProvider,
    providerUserId: string,
  ): Promise<OAuthAccount | undefined> {
    const result = await this.postgres.query(
      `SELECT id, user_id, provider, provider_user_id, email,
              access_token, refresh_token, token_expiry, created_at, updated_at
       FROM oauth_accounts
       WHERE provider = $1 AND provider_user_id = $2`,
      [provider, providerUserId],
    );
    return result.rows[0] ? mapOAuthAccount(result.rows[0]) : undefined;
  }
}
