import type { DatabaseQueryExecutor } from '../ports/DatabasePort';

/** No account FK: deletion work must outlive cascaded user/job removal. */
export class ImportObjectDeletionRepository {
  constructor(private readonly database: DatabaseQueryExecutor) {}

  async listDue(): Promise<string[]> {
    const result = await this.database.query<{ object_key: string }>(
      `SELECT object_key FROM import_object_deletions WHERE next_attempt_at<=NOW()
       ORDER BY next_attempt_at LIMIT 100`,
    );
    return result.rows.map((row) => row.object_key);
  }

  async recordAttempt(objectKey: string, deleted: boolean): Promise<void> {
    // Retry successful deletion during the signed-upload grace period as an old
    // upload may finish after the first delete. Failed work is never discarded.
    if (deleted) {
      await this.database.query(
        'DELETE FROM import_object_deletions WHERE object_key=$1 AND retain_until<=NOW()', [objectKey],
      );
    }
    await this.database.query(
      `UPDATE import_object_deletions SET attempts=attempts+1,
         next_attempt_at=NOW()+INTERVAL '1 hour',
         last_deleted_at=CASE WHEN $2 THEN NOW() ELSE last_deleted_at END
       WHERE object_key=$1`, [objectKey, deleted],
    );
  }
}
