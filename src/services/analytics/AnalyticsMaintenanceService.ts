import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';

const DAY_MS = 86_400_000;
const LOCK_KEY = 7_204_118_039;

export class AnalyticsMaintenanceService {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  start(): void {
    if (this.timer) return;
    void this.run().catch(() => undefined);
    this.timer = setInterval(() => void this.run().catch(() => undefined), DAY_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(now = new Date()): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const lock = await transaction.query<{ locked: unknown }>(
        'SELECT pg_try_advisory_xact_lock($1) AS locked', [LOCK_KEY],
      );
      if (lock.rows[0]?.locked !== true) return;
      const start = new Date(now.getTime() - 7 * DAY_MS);
      const end = new Date(now.getTime() + DAY_MS);
      await transaction.query(
        `DELETE FROM analytics_daily_rollups WHERE metric_date >= $1::date AND metric_date < $2::date`,
        [start, end],
      );
      await transaction.query(
        `INSERT INTO analytics_daily_rollups(metric_date,metric_name,dimensions,metric_value)
         SELECT occurred_at::date, 'event_count', jsonb_build_object('eventName',event_name), COUNT(*)
         FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2
         GROUP BY occurred_at::date,event_name`, [start, end],
      );
      await transaction.query(
        `INSERT INTO analytics_daily_rollups(metric_date,metric_name,dimensions,metric_value)
         SELECT occurred_at::date, 'unique_users', jsonb_build_object('eventName',event_name), COUNT(DISTINCT user_id)
         FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2 AND user_id IS NOT NULL
         GROUP BY occurred_at::date,event_name`, [start, end],
      );
      await transaction.query(`DELETE FROM analytics_events WHERE occurred_at < $1 - INTERVAL '13 months'`, [now]);
      await transaction.query(`DELETE FROM admin_audit_events WHERE created_at < $1 - INTERVAL '2 years'`, [now]);
      await transaction.query(`DELETE FROM admin_sessions WHERE expires_at < $1 - INTERVAL '7 days'`, [now]);
      await transaction.query(`DELETE FROM admin_invitations WHERE expires_at < $1 - INTERVAL '30 days'`, [now]);
      await transaction.query(`DELETE FROM admin_password_reset_tokens WHERE expires_at < $1 - INTERVAL '30 days'`, [now]);
    });
  }
}
