import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';
import type { AccountDeletionRequestPort } from '../ports/AccountDeletionPort';
import { databaseRow, databaseUuid } from './DatabaseRowDecoder';

/** The account row is the admission fence; this queue survives API/worker restarts. */
export class AccountDeletionRequestRepository implements AccountDeletionRequestPort {
  constructor(private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  async request(userId: string): Promise<void> {
    await this.database.withTransaction(async (tx) => {
      // Match import admission ordering: advisory lock, account row, then jobs.
      await tx.query("SET LOCAL lock_timeout = '3s'");
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const user = await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      if (!user.rows.length) return; // A concurrent finalizer already completed deletion.
      await tx.query(`UPDATE users SET deletion_requested_at=NOW(), import_generation=import_generation+1
        WHERE id=$1 AND deletion_requested_at IS NULL`, [userId]);
      await tx.query(`INSERT INTO account_deletion_requests(user_id) VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING`, [userId]);
      await tx.query(`UPDATE import_jobs SET status='cancelled',phase='cancelled',completed_at=NOW(),
        heartbeat_at=NULL,updated_at=NOW(),error_code='ACCOUNT_DELETION_PENDING',
        error_message='Import cancelled because account deletion was requested.'
        WHERE user_id=$1 AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')`, [userId]);
      await tx.query('UPDATE push_devices SET enabled=FALSE,disabled_at=NOW() WHERE user_id=$1', [userId]);
      await tx.query('DELETE FROM mailbox_authorization_attempts WHERE user_id=$1', [userId]);
      await tx.query(`UPDATE import_job_outbox SET published_at=COALESCE(published_at,NOW()),
        last_error='account deletion requested'
        WHERE job_id IN (SELECT id FROM import_jobs WHERE user_id=$1) AND published_at IS NULL`, [userId]);
    });
  }

  async due(limit: number): Promise<string[]> {
    const result = await this.database.query(`SELECT user_id FROM account_deletion_requests
      WHERE next_attempt_at<=NOW() ORDER BY next_attempt_at LIMIT $1`, [limit]);
    return result.rows.map(row => databaseUuid(databaseRow(row, 'account deletion request'), 'user_id'));
  }

  async defer(userId: string, errorCode: string): Promise<void> {
    await this.database.query(`UPDATE account_deletion_requests SET attempts=attempts+1,
      next_attempt_at=NOW()+INTERVAL '10 seconds',last_error_code=$2 WHERE user_id=$1`, [userId, errorCode]);
  }
}
