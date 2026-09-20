import { ReceiptReconciliationStore } from './ReceiptReconciliationStore';
import type { ReceiptReviewChange } from '../receipt/ReceiptReviewDecisions';
import { ReceiptRepairSourceStore } from './ReceiptRepairSourceStore';
import { ReceiptImportOutcomeStore } from './ReceiptImportOutcomeStore';
import type { ReceiptImportAccounting, ReceiptImportScope } from '../import/ReceiptImportOutcome';
import type { RepairSourceProvenance } from '../receipt/ReceiptRepairSources';
import { decodeReceiptObservation } from './receiptObservationCodec';
import { DatabaseError } from '../../core/errors';
import { Receipt, ReceiptType, ReceiptWriteCommand } from '../../models/Receipt';
import {
  DatabaseQueryExecutor,
  DatabaseRow,
  DatabaseTransactionRunner,
} from '../ports/DatabasePort';
import type { ReceiptListFilters, ReceiptPage, ReceiptUpsertResult } from '../ports/ReceiptPorts';
import { mapReceiptRow, ReceiptRow } from './receiptRowMapper';
import { databaseRow, databaseString, databaseTimestamp } from './DatabaseRowDecoder';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';
import { receiptHistoryQuery } from './ReceiptHistoryQuery';
import { receiptHasSourceSql, receiptOrderPredicates } from './ReceiptReadPredicates';

interface HistoryPageRow extends DatabaseRow {
  count: unknown;
  receipts: unknown;
  timezone: unknown;
}

interface ReceiptCutoffRow extends DatabaseRow {
  receipt_type: unknown;
  latest: unknown;
}

/** Canonical receipt persistence adapter. */
export class ReceiptRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor & DatabaseTransactionRunner, private readonly policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY) {}

  async findPage(filters: ReceiptListFilters, limit: number, offset: number): Promise<ReceiptPage> {
    const query = receiptHistoryQuery(filters, limit, offset);
    const result = await this.postgres.query<HistoryPageRow>(query.sql, query.params);
    const row = databaseRow(result.rows[0], 'receipt history page');
    if (!Array.isArray(row.receipts)) throw new DatabaseError('Invalid receipt history page');
    const total = databaseNumber(row.count, 'receipt_count', {
      integer: true,
    });
    return {
      receipts: row.receipts.map(value => mapReceiptRow(databaseRow(value, 'receipt history record'))),
      total,
      ...(row.timezone === null ? {} : { timezone: databaseString(row, 'timezone') }),
    };
  }

  async findByUserId(userId: string): Promise<Receipt[]> {
    const result = await this.postgres.query<ReceiptRow>(
      'SELECT * FROM receipts WHERE user_id = $1 ORDER BY order_date DESC, id DESC',
      [userId],
    );
    return result.rows.map(mapReceiptRow);
  }

  /** Shared persistence path for mailbox, direct export, and durable staged imports. */
  async upsertEmailReceipts(
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptUpsertResult> {
    return this.postgres.withTransaction((tx) =>
      this.mergeObservations(tx, receipts, assertWriteAllowed, accounting),
    );
  }

  async replaceProviderExport(
    userId: string,
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
    batch?: { id: string; rejected: number },
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptUpsertResult> {
    this.validateExport(userId, receipts);
    return this.postgres.withTransaction((tx) =>
      new ReceiptReconciliationStore((executor, receipt) =>
        this.writeProjection(executor, receipt),
        this.policyVersion,
      ).ingest(tx, receipts, assertWriteAllowed, batch, accounting),
    );
  }

  private validateExport(userId: string, receipts: readonly ReceiptWriteCommand[]): void {
    if (
      !receipts.length ||
      receipts.some((r) => r.userId !== userId || !r.orderDate) ||
      new Set(receipts.map((r) => r.receiptType)).size !== 1
    )
      throw new Error('Export must contain dated receipts from exactly one user and provider');
  }

  private async mergeObservations(
    tx: DatabaseQueryExecutor,
    incoming: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptUpsertResult> {
    return new ReceiptReconciliationStore((executor, receipt) =>
      this.writeProjection(executor, receipt),
      this.policyVersion,
    ).ingest(tx, incoming, assertWriteAllowed, undefined, accounting);
  }

  async getImportOutcome(userId: string, jobId: string, assertWriteAllowed: () => Promise<void>, scope?: ReceiptImportScope) {
    if (this.policyVersion !== 3) throw new Error('Canonical import outcomes require receipt policy 3');
    return this.postgres.withTransaction(async tx => {
      await assertWriteAllowed();
      const snapshot = await new ReceiptReconciliationStore((executor, receipt) => this.writeProjection(executor, receipt), this.policyVersion).load(tx, userId);
      const outcome = await new ReceiptImportOutcomeStore().resolve(tx, userId, jobId, snapshot.receipts, scope);
      await assertWriteAllowed();
      return outcome;
    });
  }

  private async writeProjection(tx: DatabaseQueryExecutor, resolved: Receipt): Promise<void> {
    const m = resolved.monetaryDetails;
    await tx.query(
      `INSERT INTO receipts(id,user_id,receipt_type,data_source,restaurant_name,order_date,amount_spent,items,delivery_time,external_id,
        currency_code,subtotal_amount,tax_amount,tip_amount,delivery_fee_amount,service_fee_amount,savings_amount,resolution)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
        ON CONFLICT(id) DO UPDATE SET data_source=EXCLUDED.data_source,restaurant_name=EXCLUDED.restaurant_name,
        order_date=EXCLUDED.order_date,amount_spent=EXCLUDED.amount_spent,items=EXCLUDED.items,delivery_time=EXCLUDED.delivery_time,
        external_id=EXCLUDED.external_id,currency_code=EXCLUDED.currency_code,subtotal_amount=EXCLUDED.subtotal_amount,
        tax_amount=EXCLUDED.tax_amount,tip_amount=EXCLUDED.tip_amount,delivery_fee_amount=EXCLUDED.delivery_fee_amount,
        service_fee_amount=EXCLUDED.service_fee_amount,savings_amount=EXCLUDED.savings_amount,resolution=EXCLUDED.resolution,
        last_seen_at=NOW(),updated_at=NOW()`,
      [
        resolved.id,
        resolved.userId,
        resolved.receiptType,
        resolved.dataSource,
        resolved.restaurantName?.substring(0, 255) ?? null,
        resolved.orderDate,
        resolved.amountSpent,
        JSON.stringify(resolved.items),
        resolved.deliveryTime ?? null,
        resolved.externalId ?? null,
        m?.currencyCode ?? null,
        m?.subtotal ?? null,
        m?.tax ?? null,
        m?.tip ?? null,
        m?.deliveryFee ?? null,
        m?.serviceFee ?? null,
        m?.savings ?? null,
        JSON.stringify(resolved.resolution),
      ],
    );
  }

  async stageProviderExport(
    jobId: string,
    receipts: readonly ReceiptWriteCommand[],
  ): Promise<void> {
    await this.postgres.query('DELETE FROM import_receipt_staging WHERE job_id=$1', [jobId]);
    for (let offset = 0; offset < receipts.length; offset += 100) {
      const values: unknown[] = [];
      const placeholders = receipts.slice(offset, offset + 100).map((receipt, index) => {
        values.push(jobId, offset + index, JSON.stringify(receipt));
        const p = index * 3 + 1;
        return `($${p},$${p + 1},$${p + 2}::jsonb)`;
      });
      await this.postgres.query(
        `INSERT INTO import_receipt_staging(job_id,sequence_number,receipt) VALUES ${placeholders.join(',')}`,
        values,
      );
    }
  }

  async replaceStagedProviderExport(
    jobId: string,
    userId: string,
    assertWriteAllowed: () => Promise<void>,
    batch?: { id: string; rejected: number },
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptUpsertResult> {
    return this.postgres.withTransaction(async (tx) => {
      await assertWriteAllowed();
      const rows = await tx.query<{ receipt: unknown }>(
        `SELECT s.receipt FROM import_receipt_staging s JOIN import_jobs j ON j.id=s.job_id JOIN users u ON u.id=j.user_id WHERE s.job_id=$1 AND j.user_id=$2 AND j.import_generation=u.import_generation AND j.status IN ('running','retrying') ORDER BY sequence_number`,
        [jobId, userId],
      );
      const receipts = rows.rows.map((r) => decodeReceiptObservation(r.receipt));
      this.validateExport(userId, receipts);
      const result = await new ReceiptReconciliationStore((executor, receipt) =>
        this.writeProjection(executor, receipt),
        this.policyVersion,
      ).ingest(tx, receipts, assertWriteAllowed, batch ?? { id: jobId, rejected: 0 }, accounting);
      await tx.query('DELETE FROM import_receipt_staging WHERE job_id=$1', [jobId]);
      return result;
    });
  }

  async rebuildProjection(
    userId: string,
    generation: number,
    mode: 'prepare' | 'publish' | 'rollback',
    assertWriteAllowed: () => Promise<void>,
    manifestId?: string,
    stagedBatchIds: readonly string[] = [],
    reviewChanges: readonly ReceiptReviewChange[] = [],
  ): Promise<{
    orders: number;
    changed: number;
    legacy: number;
    mode: string;
    manifestId?: string;
  }> {
    return this.postgres.withTransaction((tx) =>
      new ReceiptReconciliationStore((executor, receipt) =>
        this.writeProjection(executor, receipt),
        this.policyVersion,
      ).repair(tx, userId, generation, mode, assertWriteAllowed, manifestId, stagedBatchIds, reviewChanges),
    );
  }

  async stageRepairSources(
    userId: string,
    generation: number,
    receipts: readonly ReceiptWriteCommand[],
    provenance: RepairSourceProvenance,
    assertWriteAllowed: () => Promise<void>,
  ) {
    return this.postgres.withTransaction((tx) => new ReceiptRepairSourceStore()
      .stage(tx, userId, generation, receipts, provenance, assertWriteAllowed));
  }

  async getLatestCsvReceiptDates(userId: string): Promise<Partial<Record<ReceiptType, Date>>> {
    const result = await this.postgres.query<ReceiptCutoffRow>(
      `SELECT receipt_type, MAX(order_date) AS latest
       FROM receipts r
       WHERE user_id = $1 AND ${receiptHasSourceSql('r', 'csv')}
         AND NOT ${receiptOrderPredicates('r').adjustment}
       GROUP BY receipt_type`,
      [userId],
    );
    const cutoffs: Partial<Record<ReceiptType, Date>> = {};
    for (const value of result.rows) {
      const row = databaseRow(value, 'receipt cutoff');
      const receiptType = databaseString(row, 'receipt_type');
      if (!isReceiptTypeValue(receiptType)) {
        throw new DatabaseError('Invalid receipt cutoff row: receipt_type');
      }
      const latest = databaseTimestamp(row, 'latest');
      if (latest === null) continue;
      cutoffs[receiptType] = new Date(latest);
    }
    return cutoffs;
  }

}

const isReceiptTypeValue = (value: string): value is ReceiptType =>
  Object.values(ReceiptType).some((receiptType) => receiptType === value);

const databaseNumber = (
  value: unknown,
  field: string,
  options: { integer?: boolean } = {},
): number => {
  const candidate = typeof value === 'number' ? value : Number(value);
  if (
    !Number.isFinite(candidate) ||
    candidate < 0 ||
    (options.integer === true && !Number.isInteger(candidate))
  ) {
    throw new DatabaseError(`Invalid receipt aggregate row: ${field}`);
  }
  return candidate;
};
