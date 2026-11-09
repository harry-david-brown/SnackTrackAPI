import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';
import type {
  GmailPushDispatch,
  GmailPushReceiptResult,
  GmailPushStatePort,
  GmailWatchCandidate,
} from '../ports/GmailPushPorts';

type Row = Record<string, unknown>;
const stringValue = (value: unknown): string => String(value);

/** Durable coalescing state for untrusted, at-least-once Pub/Sub delivery. */
export class GmailPushRepository implements GmailPushStatePort {
  constructor(private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  async recordNotification(input: {
    messageId: string;
    emailAddress: string;
    historyId: string;
    debounceSeconds: number;
  }): Promise<GmailPushReceiptResult> {
    return this.database.withTransaction(async (transaction) => {
      const users = await transaction.query<Row>(
        `SELECT u.id
         FROM users u
         JOIN user_import_preferences p ON p.user_id=u.id
         WHERE LOWER(u.gmail_email)=LOWER($1)
           AND u.gmail_connected=TRUE AND u.gmail_connection_mode='offline'
           AND u.gmail_refresh_token IS NOT NULL
           AND (p.ongoing_tracking_consent_state='granted' OR (
             EXISTS (
               SELECT 1 FROM user_export_provider_preferences export
               WHERE export.user_id=u.id AND export.status='requested'
                 AND export.alert_consent='granted' AND export.alert_consent_version='export-ready-background-v1'
             )
           ))
         LIMIT 2`,
        [input.emailAddress],
      );
      if (users.rows.length === 0) return { outcome: 'unknown_mailbox' } as const;
      if (users.rows.length > 1) return { outcome: 'ambiguous_mailbox' } as const;
      const userId = stringValue(users.rows[0].id);
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId]);
      const prior = await transaction.query<Row>(
        `SELECT last_pubsub_message_id,
           $2::NUMERIC<=GREATEST(COALESCE(latest_history_id,0),COALESCE(dispatched_history_id,0)) AS stale_history
         FROM gmail_push_state WHERE user_id=$1 FOR UPDATE`,
        [userId, input.historyId],
      );
      if (prior.rows[0]?.last_pubsub_message_id === input.messageId || prior.rows[0]?.stale_history === true) {
        return { outcome: 'duplicate' } as const;
      }

      await transaction.query(
        `INSERT INTO gmail_push_state(
           user_id,latest_history_id,pending,first_pending_at,last_notification_at,next_attempt_at,
           notification_count,last_pubsub_message_id,updated_at
         ) VALUES($1,$2::NUMERIC,TRUE,NOW(),NOW(),NOW()+($3*INTERVAL '1 second'),1,$4,NOW())
         ON CONFLICT(user_id) DO UPDATE SET
           latest_history_id=GREATEST(gmail_push_state.latest_history_id,EXCLUDED.latest_history_id),
           pending=TRUE,
           first_pending_at=CASE WHEN gmail_push_state.pending THEN gmail_push_state.first_pending_at ELSE NOW() END,
           last_notification_at=NOW(),
           next_attempt_at=CASE WHEN gmail_push_state.pending THEN gmail_push_state.next_attempt_at ELSE EXCLUDED.next_attempt_at END,
           notification_count=gmail_push_state.notification_count+1,
           last_pubsub_message_id=EXCLUDED.last_pubsub_message_id,
           coalesced_notification_count=gmail_push_state.coalesced_notification_count+CASE WHEN gmail_push_state.pending THEN 1 ELSE 0 END,
           updated_at=NOW()`,
        [userId, input.historyId, input.debounceSeconds, input.messageId],
      );
      return { outcome: 'accepted', userId } as const;
    });
  }

  async claimDue(limit = 100): Promise<GmailPushDispatch[]> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `WITH due AS (
           SELECT user_id FROM gmail_push_state
           WHERE pending AND next_attempt_at<=NOW()
           ORDER BY next_attempt_at,user_id FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE gmail_push_state s
         SET next_attempt_at=NOW()+INTERVAL '5 minutes',updated_at=NOW()
         FROM due WHERE s.user_id=due.user_id
         RETURNING s.user_id,s.latest_history_id::TEXT AS history_id,s.notification_count,s.consecutive_failures`,
        [Math.max(1, Math.min(limit, 500))],
      );
      return result.rows.map((row) => ({
        userId: stringValue(row.user_id),
        historyId: row.history_id === null || row.history_id === undefined ? null : stringValue(row.history_id),
        notificationCount: Number(row.notification_count ?? 0),
        failureCount: Number(row.consecutive_failures ?? 0),
      }));
    });
  }

  async markDispatched(userId: string, historyId: string | null, notificationCount: number): Promise<void> {
    await this.database.query(
      `UPDATE gmail_push_state SET
         dispatched_history_id=CASE WHEN $2::TEXT IS NULL THEN dispatched_history_id ELSE $2::NUMERIC END,
         last_dispatched_at=NOW(),
         pending=notification_count>$3,
         next_attempt_at=CASE WHEN notification_count>$3 THEN NOW()+INTERVAL '30 seconds' ELSE NULL END,
         first_pending_at=CASE WHEN notification_count>$3 THEN NOW() ELSE NULL END,
         updated_at=NOW()
       WHERE user_id=$1`,
      [userId, historyId, notificationCount],
    );
  }

  async releaseDispatch(userId: string, errorCode: string): Promise<void> {
    await this.database.query(
      `UPDATE gmail_push_state SET pending=TRUE,next_attempt_at=NOW()+
         (LEAST(consecutive_failures+1,10)*INTERVAL '1 minute'),
         consecutive_failures=consecutive_failures+1,last_error_code=$2,updated_at=NOW()
       WHERE user_id=$1`,
      [userId, errorCode.slice(0, 96)],
    );
  }

  async markProcessed(userId: string): Promise<void> {
    await this.database.query(
      `UPDATE gmail_push_state SET last_processed_at=NOW(),consecutive_failures=0,last_error_code=NULL,
         updated_at=NOW() WHERE user_id=$1`,
      [userId],
    );
  }

  async listWatchCandidates(limit = 500): Promise<GmailWatchCandidate[]> {
    return this.database.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO gmail_push_state(user_id)
         SELECT u.id FROM users u JOIN user_import_preferences p ON p.user_id=u.id
         WHERE u.deletion_requested_at IS NULL AND u.gmail_connected=TRUE AND u.gmail_connection_mode='offline' AND u.gmail_refresh_token IS NOT NULL
           AND (p.ongoing_tracking_consent_state='granted' OR (EXISTS (
               SELECT 1 FROM user_export_provider_preferences export
               WHERE export.user_id=u.id AND export.status='requested'
                 AND export.alert_consent='granted' AND export.alert_consent_version='export-ready-background-v1'
             )))
         ON CONFLICT(user_id) DO NOTHING`,
      );
      const result = await transaction.query<Row>(
        `WITH due AS (
           SELECT s.user_id FROM gmail_push_state s
           JOIN users u ON u.id=s.user_id JOIN user_import_preferences p ON p.user_id=u.id
           WHERE u.deletion_requested_at IS NULL AND u.gmail_connected=TRUE AND u.gmail_connection_mode='offline' AND u.gmail_refresh_token IS NOT NULL
             AND (p.ongoing_tracking_consent_state='granted' OR (EXISTS (
               SELECT 1 FROM user_export_provider_preferences export
               WHERE export.user_id=u.id AND export.status='requested'
                 AND export.alert_consent='granted' AND export.alert_consent_version='export-ready-background-v1'
             )))
             AND (s.watch_expiration IS NULL OR s.watch_expiration<NOW()+INTERVAL '5 days')
             AND (s.watch_renewal_lease_until IS NULL OR s.watch_renewal_lease_until<NOW())
           ORDER BY s.watch_expiration NULLS FIRST,s.user_id FOR UPDATE SKIP LOCKED LIMIT $1
         ) UPDATE gmail_push_state s SET watch_renewal_lease_until=NOW()+INTERVAL '15 minutes',updated_at=NOW()
           FROM due WHERE s.user_id=due.user_id RETURNING s.user_id`,
        [Math.max(1, Math.min(limit, 5_000))],
      );
      return result.rows.map((row) => ({ userId: stringValue(row.user_id) }));
    });
  }

  async hasHealthyWatch(userId: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM gmail_push_state WHERE user_id=$1 AND watch_expiration>NOW()+INTERVAL '1 day'`,
      [userId],
    );
    return Boolean(result.rows[0]);
  }

  async saveWatch(userId: string, historyId: string, expiration: Date): Promise<void> {
    await this.database.query(
      `INSERT INTO gmail_push_state(user_id,watch_history_id,watch_expiration,watch_last_renewed_at,updated_at)
       VALUES($1,$2::NUMERIC,$3,NOW(),NOW())
       ON CONFLICT(user_id) DO UPDATE SET watch_history_id=EXCLUDED.watch_history_id,
         watch_expiration=EXCLUDED.watch_expiration,watch_last_renewed_at=NOW(),
         watch_renewal_lease_until=NULL,consecutive_failures=0,last_error_code=NULL,updated_at=NOW()`,
      [userId, historyId, expiration],
    );
  }

  async recordWatchFailure(userId: string, errorCode: string): Promise<void> {
    await this.database.query(
      `INSERT INTO gmail_push_state(user_id,consecutive_failures,last_error_code,updated_at)
       VALUES($1,1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET
         consecutive_failures=gmail_push_state.consecutive_failures+1,
         last_error_code=EXCLUDED.last_error_code,watch_renewal_lease_until=NULL,updated_at=NOW()`,
      [userId, errorCode.slice(0, 96)],
    );
  }

  async clearWatch(userId: string): Promise<void> {
    await this.database.query(
      `UPDATE gmail_push_state SET pending=FALSE,next_attempt_at=NULL,watch_expiration=NULL,
       watch_history_id=NULL,updated_at=NOW() WHERE user_id=$1`,
      [userId],
    );
  }

}
