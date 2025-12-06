import { OAuthAccount } from '../../models/OAuthAccount';
import { PostgresService } from './PostgresService';
import { v4 as uuidv4 } from 'uuid';

export class OAuthRepository {
    constructor(private postgres: PostgresService) { }

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
                data.email || null,
                data.accessToken || null,
                data.refreshToken || null,
                data.tokenExpiry || null
            ]
        );
        return id;
    }

    async findByProvider(provider: string, providerUserId: string): Promise<OAuthAccount | undefined> {
        const result = await this.postgres.query(
            `SELECT id, user_id, provider, provider_user_id, email, 
              access_token, refresh_token, token_expiry, created_at, updated_at
       FROM oauth_accounts 
       WHERE provider = $1 AND provider_user_id = $2`,
            [provider, providerUserId]
        );

        if (result.rows.length === 0) return undefined;
        return this.mapRowToModel(result.rows[0]);
    }

    async findByUserId(userId: string): Promise<OAuthAccount[]> {
        const result = await this.postgres.query(
            `SELECT id, user_id, provider, provider_user_id, email, 
              access_token, refresh_token, token_expiry, created_at, updated_at
       FROM oauth_accounts 
       WHERE user_id = $1`,
            [userId]
        );

        return result.rows.map(this.mapRowToModel);
    }

    async updateToken(id: string, accessToken: string, refreshToken?: string, expiry?: Date): Promise<void> {
        await this.postgres.query(
            `UPDATE oauth_accounts
       SET access_token = $1, 
           refresh_token = COALESCE($2, refresh_token),
           token_expiry = COALESCE($3, token_expiry),
           updated_at = NOW()
       WHERE id = $4`,
            [accessToken, refreshToken || null, expiry || null, id]
        );
    }

    private mapRowToModel(row: any): OAuthAccount {
        return {
            id: row.id,
            userId: row.user_id,
            provider: row.provider,
            providerUserId: row.provider_user_id,
            email: row.email,
            accessToken: row.access_token,
            refreshToken: row.refresh_token,
            tokenExpiry: row.token_expiry,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}
