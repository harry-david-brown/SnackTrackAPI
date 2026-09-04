import type { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';
import {
  databaseNonNegativeInteger,
  databaseNullableString,
  databaseRow,
  databaseTimestamp,
} from './DatabaseRowDecoder';
import {
  FIRST_RECAP_MINIMUM_ORDERS,
  FIRST_RECAP_VERSION,
  type ExperienceState,
  type SetupCompletionMethod,
} from '../experience/ExperienceStateTypes';

interface ExperienceRow extends DatabaseRow {
  receipt_count: unknown;
  setup_completed_at: unknown;
  setup_completion_method: unknown;
  first_recap_seen_at: unknown;
  active_operation_id: unknown;
}

const setupMethods = new Set<SetupCompletionMethod>([
  'email_receipts',
  'provider_history_request',
  'provider_archive',
]);

export class ExperienceStateRepository {
  constructor(private readonly database: DatabaseQueryExecutor) {}

  async get(userId: string): Promise<ExperienceState> {
    const result = await this.database.query<ExperienceRow>(
      `SELECT
         (SELECT COUNT(*)::int FROM receipts WHERE user_id=$1) AS receipt_count,
         experience.setup_completed_at,
         experience.setup_completion_method,
         experience.first_recap_seen_at,
         (SELECT id FROM import_jobs
          WHERE user_id=$1
            AND trigger_type='user'
            AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')
          ORDER BY created_at DESC LIMIT 1) AS active_operation_id
       FROM (SELECT $1::UUID AS user_id) input
       LEFT JOIN user_experience_state experience ON experience.user_id=input.user_id`,
      [userId],
    );
    const row = databaseRow(result.rows[0], 'experience state');
    const receiptCount = databaseNonNegativeInteger(row, 'receipt_count');
    const setupCompletedAt = databaseTimestamp(row, 'setup_completed_at');
    const activeOperationId = databaseNullableString(row, 'active_operation_id');
    const rawMethod = databaseNullableString(row, 'setup_completion_method');
    const completionMethod = rawMethod && setupMethods.has(rawMethod as SetupCompletionMethod)
      ? rawMethod as SetupCompletionMethod
      : null;
    const seenAt = databaseTimestamp(row, 'first_recap_seen_at');

    return {
      setup: {
        state: setupCompletedAt ? 'complete' : activeOperationId ? 'importing' : 'required',
        completedAt: setupCompletedAt,
        completionMethod,
        activeOperationId,
      },
      firstRecap: {
        state: seenAt
          ? 'seen'
          : receiptCount >= FIRST_RECAP_MINIMUM_ORDERS
            ? 'ready'
            : 'ineligible',
        minimumOrderCount: FIRST_RECAP_MINIMUM_ORDERS,
        version: FIRST_RECAP_VERSION,
        seenAt,
      },
      receiptCount,
    };
  }

  async markFirstRecapSeen(userId: string, version: string): Promise<ExperienceState> {
    await this.database.query(
      `INSERT INTO user_experience_state (
         user_id, first_recap_seen_at, first_recap_version
       ) VALUES ($1, NOW(), $2)
       ON CONFLICT (user_id) DO UPDATE SET
         first_recap_seen_at=COALESCE(user_experience_state.first_recap_seen_at, NOW()),
         first_recap_version=COALESCE(user_experience_state.first_recap_version, EXCLUDED.first_recap_version),
         updated_at=NOW()`,
      [userId, version],
    );
    return this.get(userId);
  }
}
