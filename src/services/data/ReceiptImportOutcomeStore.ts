import { ConflictError } from '../../core/errors';
import type { Receipt } from '../../models/Receipt';
import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import {
  decodeReceiptImportOutcomeLedger,
  recordReceiptImportPage,
  resolveReceiptImportOutcome,
  startReceiptImportOutcome,
  type ReceiptImportOutcomeLedger,
  type ReceiptImportAccounting,
  type ReceiptImportScope,
} from '../import/ReceiptImportOutcome';

/** Called only inside the canonical writer transaction, after the account row is locked. */
export class ReceiptImportOutcomeStore {
  private async load(
    tx: DatabaseQueryExecutor,
    userId: string,
    jobId: string,
    before: readonly Receipt[],
  ): Promise<ReceiptImportOutcomeLedger> {
    const result = await tx.query<{ receipt_outcome_state: unknown }>(
      `SELECT j.receipt_outcome_state FROM import_jobs j JOIN users u ON u.id=j.user_id
       WHERE j.id=$1 AND j.user_id=$2 AND j.import_generation=u.import_generation
         AND j.status IN ('running','retrying') FOR UPDATE OF j`,
      [jobId, userId],
    );
    if (result.rows.length !== 1)
      throw new ConflictError(
        'IMPORT_OUTCOME_STALE',
        'Import outcome no longer belongs to an active account generation',
      );
    return result.rows[0].receipt_outcome_state === null
      ? { ...startReceiptImportOutcome(before), scopes: {} }
      : decodeReceiptImportOutcomeLedger(result.rows[0].receipt_outcome_state);
  }

  async record(
    tx: DatabaseQueryExecutor,
    userId: string,
    accounting: ReceiptImportAccounting,
    before: readonly Receipt[],
    after: readonly Receipt[],
    incomingIds: readonly string[],
  ): Promise<void> {
    if ([...before, ...after].some((receipt) => receipt.userId !== userId))
      throw new Error('Import accounting snapshots span accounts');
    const state = await this.load(tx, userId, accounting.jobId, before);
    const updated: ReceiptImportOutcomeLedger = {
      ...recordReceiptImportPage(state, before, after, incomingIds),
      scopes: {
        ...state.scopes,
        [accounting.scope]: recordReceiptImportPage(
          state.scopes[accounting.scope] ?? startReceiptImportOutcome(before),
          before,
          after,
          incomingIds,
        ),
      },
    };
    await tx.query(
      'UPDATE import_jobs SET receipt_outcome_state=$3::jsonb WHERE id=$1 AND user_id=$2',
      [accounting.jobId, userId, JSON.stringify(updated)],
    );
  }

  async resolve(
    tx: DatabaseQueryExecutor,
    userId: string,
    jobId: string,
    receipts: readonly Receipt[],
    scope?: ReceiptImportScope,
  ) {
    if (receipts.some((receipt) => receipt.userId !== userId))
      throw new Error('Import accounting snapshots span accounts');
    const ledger = await this.load(tx, userId, jobId, receipts);
    return resolveReceiptImportOutcome(
      scope ? (ledger.scopes[scope] ?? startReceiptImportOutcome(receipts)) : ledger,
      receipts,
    );
  }
}
