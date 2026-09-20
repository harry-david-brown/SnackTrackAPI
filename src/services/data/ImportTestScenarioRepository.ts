import { AppError, NotFoundError, ValidationError } from '../../core/errors';
import {
  GMAIL_LONG_RUNNING_DELAY_MS,
  GMAIL_LONG_RUNNING_SCENARIO,
  SIMULATED_LONG_RUNNING_ERROR_CODE,
  type ImportTestScenarios,
} from '../import/ImportTestScenarios';
import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';

type Database = DatabaseQueryExecutor & DatabaseTransactionRunner;

const timestamp = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Owner-controlled test scenarios, isolated from user-facing import preferences. */
export class ImportTestScenarioRepository {
  constructor(private readonly database: Database) {}

  async get(userId: string): Promise<ImportTestScenarios> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT enabled,reason,updated_at FROM user_import_test_scenarios
       WHERE user_id=$1 AND scenario=$2`,
      [userId, GMAIL_LONG_RUNNING_SCENARIO],
    );
    const row = result.rows[0];
    return {
      gmailLongRunning: row?.enabled === true,
      reason: typeof row?.reason === 'string' ? row.reason : null,
      updatedAt: timestamp(row?.updated_at),
    };
  }

  async setGmailLongRunning(input: {
    userId: string;
    enabled: boolean;
    reason: string;
    actorAdminId: string;
    requestId?: string;
  }): Promise<ImportTestScenarios> {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) throw new ValidationError('Must be 10–500 characters', 'reason');
    await this.database.withTransaction(async (transaction) => {
      const user = await transaction.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [input.userId]);
      if (!user.rows[0]) throw new NotFoundError('User', input.userId);
      await transaction.query(
        `INSERT INTO user_import_test_scenarios
         (user_id,scenario,enabled,reason,updated_by_admin_id,updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (user_id,scenario) DO UPDATE SET
           enabled=EXCLUDED.enabled,reason=EXCLUDED.reason,
           updated_by_admin_id=EXCLUDED.updated_by_admin_id,updated_at=NOW()`,
        [input.userId, GMAIL_LONG_RUNNING_SCENARIO, input.enabled, reason, input.actorAdminId],
      );
      await transaction.query(
        `INSERT INTO admin_audit_events
         (actor_admin_id,action,target_type,target_id,reason,request_id,outcome,metadata)
         VALUES ($1,$2,'user',$3,$4,$5,'success',$6::jsonb)`,
        [
          input.actorAdminId,
          input.enabled ? 'import_test.gmail_long_running_enabled' : 'import_test.gmail_long_running_disabled',
          input.userId,
          reason,
          input.requestId ?? null,
          JSON.stringify({ scenario: GMAIL_LONG_RUNNING_SCENARIO, enabled: input.enabled, delaySeconds: GMAIL_LONG_RUNNING_DELAY_MS / 1000 }),
        ],
      );
    });
    return this.get(input.userId);
  }

  /** Returns a future resume time once per Gmail job when the scenario is enabled. */
  async delayGmailImportIfEnabled(jobId: string, userId: string): Promise<Date | null> {
    return this.database.withTransaction(async (transaction) => {
      const existing = await transaction.query<Record<string, unknown>>(
        `SELECT resume_at,resumed_at,resume_at>NOW() AS pending
         FROM import_test_scenario_runs WHERE job_id=$1 FOR UPDATE`,
        [jobId],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.pending === true) {
          const resumeAt = new Date(previous.resume_at instanceof Date ? previous.resume_at.getTime() : String(previous.resume_at));
          await this.markJobDelayed(transaction, jobId, userId, resumeAt);
          return resumeAt;
        }
        if (!previous.resumed_at) {
          await transaction.query('UPDATE import_test_scenario_runs SET resumed_at=NOW() WHERE job_id=$1', [jobId]);
        }
        return null;
      }

      const enabled = await transaction.query(
        `SELECT 1 FROM user_import_test_scenarios
         WHERE user_id=$1 AND scenario=$2 AND enabled=true`,
        [userId, GMAIL_LONG_RUNNING_SCENARIO],
      );
      if (!enabled.rows[0]) return null;

      const inserted = await transaction.query<Record<string, unknown>>(
        `INSERT INTO import_test_scenario_runs (job_id,user_id,scenario,resume_at)
         VALUES ($1,$2,$3,NOW()+($4::integer*INTERVAL '1 millisecond'))
         RETURNING resume_at`,
        [jobId, userId, GMAIL_LONG_RUNNING_SCENARIO, GMAIL_LONG_RUNNING_DELAY_MS],
      );
      const resumeAt = new Date(inserted.rows[0]?.resume_at instanceof Date ? inserted.rows[0].resume_at.getTime() : String(inserted.rows[0]?.resume_at));
      await this.markJobDelayed(transaction, jobId, userId, resumeAt);
      return resumeAt;
    });
  }

  private async markJobDelayed(executor: DatabaseQueryExecutor, jobId: string, userId: string, resumeAt: Date): Promise<void> {
    const updated = await executor.query<Record<string, unknown>>(
      `UPDATE import_jobs SET status='retrying',phase='simulated_long_running',
         attempts=GREATEST(0,attempts-1),error_code=$3,
         error_message='This import is intentionally delayed for an administrator test scenario.',
         heartbeat_at=NULL,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='running'`,
      [jobId, userId, SIMULATED_LONG_RUNNING_ERROR_CODE],
    );
    if (updated.rowCount !== 1) throw new AppError({
      code: 'IMPORT_TEST_SCENARIO_STATE_CONFLICT',
      message: `Import job ${jobId} could not enter its test delay`,
      publicMessage: 'The import could not enter the requested test scenario safely.',
    });
    await executor.query(
      `INSERT INTO import_job_events(job_id,event_type,attempt,status,phase,progress,error_code,details)
       SELECT id,'test_delay_started',attempts,status,phase,progress,error_code,$2::jsonb FROM import_jobs WHERE id=$1`,
      [jobId, JSON.stringify({ delaySeconds: GMAIL_LONG_RUNNING_DELAY_MS / 1000, resumeAt: resumeAt.toISOString() })],
    );
  }
}
