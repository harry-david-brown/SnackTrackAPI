import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import type { ReceiptRepairAccountPort } from '../ports/ReceiptRepairAcquisitionPorts';
import { getDefaultTimezone, isValidTimezone } from '../../utils/timezone';
import { databaseNonNegativeInteger, databaseNullableString } from './DatabaseRowDecoder';

/** Acquisition needs only the account's parsing context, never login/mailbox credentials. */
export class ReceiptRepairAccountRepository implements ReceiptRepairAccountPort {
  constructor(private readonly db: DatabaseQueryExecutor) {}

  async getContext(userId: string) {
    const result = await this.db.query<{ import_generation: unknown; timezone: unknown }>(
      'SELECT import_generation,timezone FROM users WHERE id=$1',
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const timezone = databaseNullableString(row, 'timezone') ?? getDefaultTimezone();
    const generation = databaseNonNegativeInteger(row, 'import_generation');
    if (!Number.isSafeInteger(generation) || !isValidTimezone(timezone))
      throw new Error('Invalid account repair context');
    return { generation, timezone };
  }
}
