import { AppError } from '../../core/errors';
import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';

export const GMAIL_USAGE_CATEGORIES = ['onboarding_import', 'monitoring', 'connection'] as const;
export type GmailUsageCategory = (typeof GMAIL_USAGE_CATEGORIES)[number];

export interface GmailUnitLimits {
  readonly projectMinute: number;
  readonly projectDay: number;
  readonly userMinute: number;
}

/**
 * Atomically reserves Gmail quota before an external request and records the
 * reservation for app-wide reporting. Failed provider calls remain counted,
 * which deliberately errs on the side of protecting the Google quota.
 */
export class GmailUnitBudgetRepository {
  constructor(
    private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner,
    private readonly limits: GmailUnitLimits,
  ) {}

  async reserve(
    userId: string,
    category: GmailUsageCategory,
    method: string,
    units: number,
  ): Promise<void> {
    if (!Number.isInteger(units) || units <= 0 || method.length > 32) {
      throw new Error('Invalid Gmail unit reservation');
    }
    await this.database.withTransaction(async (transaction) => {
      const day = await transaction.query(
        `INSERT INTO gmail_api_project_day_budget(bucket_start,units)
         VALUES(CURRENT_DATE,$1)
         ON CONFLICT(bucket_start) DO UPDATE SET units=gmail_api_project_day_budget.units+EXCLUDED.units
           WHERE gmail_api_project_day_budget.units+EXCLUDED.units <= $2
         RETURNING units`,
        [units, this.limits.projectDay],
      );
      if (!day.rows[0]) this.exhausted('project_day', this.limits.projectDay);

      const minute = await transaction.query(
        `INSERT INTO gmail_api_project_minute_budget(bucket_start,units)
         VALUES(date_trunc('minute',NOW()),$1)
         ON CONFLICT(bucket_start) DO UPDATE SET units=gmail_api_project_minute_budget.units+EXCLUDED.units
           WHERE gmail_api_project_minute_budget.units+EXCLUDED.units <= $2
         RETURNING units`,
        [units, this.limits.projectMinute],
      );
      if (!minute.rows[0]) this.exhausted('project_minute', this.limits.projectMinute);

      const userMinute = await transaction.query(
        `INSERT INTO gmail_api_user_minute_budget(user_id,bucket_start,units)
         VALUES($1,date_trunc('minute',NOW()),$2)
         ON CONFLICT(user_id,bucket_start) DO UPDATE SET units=gmail_api_user_minute_budget.units+EXCLUDED.units
           WHERE gmail_api_user_minute_budget.units+EXCLUDED.units <= $3
         RETURNING units`,
        [userId, units, this.limits.userMinute],
      );
      if (!userMinute.rows[0]) this.exhausted('user_minute', this.limits.userMinute);

      await transaction.query(
        `INSERT INTO gmail_api_usage_minute(bucket_start,category,method,units,request_count)
         VALUES(date_trunc('minute',NOW()),$1,$2,$3,1)
         ON CONFLICT(bucket_start,category,method) DO UPDATE SET
           units=gmail_api_usage_minute.units+EXCLUDED.units,
           request_count=gmail_api_usage_minute.request_count+1`,
        [category, method, units],
      );
    });
  }

  async cleanup(): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      await transaction.query(`DELETE FROM gmail_api_user_minute_budget WHERE bucket_start < NOW()-INTERVAL '2 days'`);
      await transaction.query(`DELETE FROM gmail_api_project_minute_budget WHERE bucket_start < NOW()-INTERVAL '2 days'`);
      await transaction.query(`DELETE FROM gmail_api_project_day_budget WHERE bucket_start < CURRENT_DATE-INTERVAL '90 days'`);
      await transaction.query(`DELETE FROM gmail_api_usage_minute WHERE bucket_start < NOW()-INTERVAL '90 days'`);
    });
  }

  private exhausted(window: string, limit: number): never {
    throw new AppError({
      code: 'GMAIL_UNIT_BUDGET_EXHAUSTED',
      message: `Gmail ${window} safety budget of ${limit} units is exhausted`,
      publicMessage: 'Gmail checking is temporarily paused to protect service capacity.',
      details: { window, limit },
    });
  }
}
