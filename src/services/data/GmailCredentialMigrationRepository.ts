import type { DatabaseConnection } from '../ports/DatabasePort';
import type { GmailCredentialCipherPort } from '../ports/GmailCredentialCipherPort';

/** Explicit deployment backfill; no plaintext compatibility reads in the runtime. */
export class GmailCredentialMigrationRepository {
  constructor(private readonly database: DatabaseConnection, private readonly cipher: GmailCredentialCipherPort) {}

  async encryptBatch(): Promise<number> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<{ id: string; gmail_access_token: string | null; gmail_refresh_token: string | null }>(
        `SELECT id, gmail_access_token, gmail_refresh_token FROM users
         WHERE gmail_access_token NOT LIKE 'gmail.v1.%' OR gmail_refresh_token NOT LIKE 'gmail.v1.%'
         ORDER BY id LIMIT 50 FOR UPDATE`,
      );
      for (const row of result.rows) {
        const encode = (kind: 'access' | 'refresh', value: string | null) => {
          if (value === null) return null;
          if (value.startsWith('gmail.v1.')) {
            this.cipher.decrypt(row.id, kind, value);
            return value;
          }
          return this.cipher.encrypt(row.id, kind, value);
        };
        await transaction.query(
          'UPDATE users SET gmail_access_token=$2, gmail_refresh_token=$3 WHERE id=$1',
          [row.id, encode('access', row.gmail_access_token), encode('refresh', row.gmail_refresh_token)],
        );
      }
      return result.rows.length;
    });
  }
}
