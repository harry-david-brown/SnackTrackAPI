import { v4 as uuidv4 } from 'uuid';
import { DatabaseError } from '../../core/errors';
import { DataSource, Receipt, ReceiptType, ReceiptWriteCommand } from '../../models/Receipt';
import {
  DatabaseQueryExecutor,
  DatabaseRow,
  DatabaseTransactionRunner,
} from '../ports/DatabasePort';
import type { ReceiptListFilters, ReceiptPage, ReceiptUpsertResult } from '../ports/ReceiptPorts';
import { decodeReceiptItems, mapReceiptRow, ReceiptRow } from './receiptRowMapper';
import {
  databaseNullableString,
  databaseRow,
  databaseString,
  databaseTimestamp,
} from './DatabaseRowDecoder';

interface CountRow extends DatabaseRow {
  count: unknown;
}

interface ExistingEmailReceiptRow extends DatabaseRow {
  source_identity: unknown;
  amount_spent: unknown;
  restaurant_name: unknown;
  order_date: unknown;
  receipt_type: unknown;
  items: unknown;
  currency_code: unknown;
  subtotal_amount: unknown;
  tax_amount: unknown;
  tip_amount: unknown;
  delivery_fee_amount: unknown;
  service_fee_amount: unknown;
  savings_amount: unknown;
}

interface ReceiptCutoffRow extends DatabaseRow {
  receipt_type: unknown;
  latest: unknown;
}

interface ReceiptAggregateRow extends DatabaseRow {
  count: unknown;
  total: unknown;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

/** Canonical receipt persistence adapter. */
export class ReceiptRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  async findPage(filters: ReceiptListFilters, limit: number, offset: number): Promise<ReceiptPage> {
    const where = this.buildWhereClause(filters);
    const listParams = [...where.params, limit, offset];
    const [listResult, countResult] = await Promise.all([
      this.postgres.query<ReceiptRow>(
        `SELECT * FROM receipts
         ${where.sql}
         ORDER BY order_date DESC
         LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        listParams,
      ),
      this.postgres.query<CountRow>(
        `SELECT COUNT(*) AS count FROM receipts ${where.sql}`,
        where.params,
      ),
    ]);

    const total = databaseNumber(countResult.rows[0]?.count, 'receipt_count', {
      integer: true,
    });
    return {
      receipts: listResult.rows.map(mapReceiptRow),
      total,
    };
  }

  async findByUserId(userId: string): Promise<Receipt[]> {
    const result = await this.postgres.query<ReceiptRow>(
      'SELECT * FROM receipts WHERE user_id = $1 ORDER BY order_date DESC',
      [userId],
    );
    return result.rows.map(mapReceiptRow);
  }

  /** Incrementally merges Gmail receipts by stable provider/source identity. */
  async upsertEmailReceipts(
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
  ): Promise<ReceiptUpsertResult> {
    if (receipts.length === 0) {
      return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0 };
    }

    return this.postgres.withTransaction(async (transaction) => {
      const result = await this.upsertEmailReceiptsInTransaction(
        transaction,
        receipts,
        assertWriteAllowed,
      );
      await assertWriteAllowed();
      return result;
    });
  }

  private async upsertEmailReceiptsInTransaction(
    transaction: DatabaseQueryExecutor,
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
  ): Promise<ReceiptUpsertResult> {
    await assertWriteAllowed();
    const identified = receipts
      .map((receipt) => ({ receipt, identity: this.emailSourceIdentity(receipt) }))
      .filter((entry): entry is { receipt: ReceiptWriteCommand; identity: string } =>
        Boolean(entry.identity),
      );
    if (identified.length === 0) {
      return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0 };
    }

    const userId = identified[0].receipt.userId;
    const existingResult = await transaction.query<ExistingEmailReceiptRow>(
      `SELECT source_identity, amount_spent, restaurant_name, order_date, receipt_type, items,
         currency_code, subtotal_amount, tax_amount, tip_amount,
         delivery_fee_amount, service_fee_amount, savings_amount
       FROM receipts
       WHERE user_id = $1 AND data_source = 'email' AND source_identity = ANY($2::TEXT[])`,
      [userId, identified.map((entry) => entry.identity)],
    );
    const existing = new Map(
      existingResult.rows.map((value) => {
        const row = databaseRow(value, 'existing email receipt');
        const receiptType = databaseString(row, 'receipt_type');
        if (!isReceiptTypeValue(receiptType)) {
          throw new DatabaseError('Invalid existing email receipt row: receipt_type');
        }
        const orderDate = databaseTimestamp(row, 'order_date');
        if (!orderDate) throw new DatabaseError('Invalid existing email receipt row: order_date');
        const decoded = {
          sourceIdentity: databaseString(row, 'source_identity'),
          amountSpent: databaseNumber(row.amount_spent, 'existing_email_amount'),
          restaurantName: databaseNullableString(row, 'restaurant_name'),
          orderDate: new Date(orderDate),
          receiptType,
          items: decodeReceiptItems(row.items),
          monetaryDetails: {
            currencyCode: databaseNullableString(row, 'currency_code'),
            subtotal: nullableDatabaseNumber(row.subtotal_amount),
            tax: nullableDatabaseNumber(row.tax_amount),
            tip: nullableDatabaseNumber(row.tip_amount),
            deliveryFee: nullableDatabaseNumber(row.delivery_fee_amount),
            serviceFee: nullableDatabaseNumber(row.service_fee_amount),
            savings: nullableDatabaseNumber(row.savings_amount),
          },
        };
        return [decoded.sourceIdentity, decoded] as const;
      }),
    );
    let newOrders = 0;
    let updatedOrders = 0;
    let unchangedOrders = 0;

    for (const { receipt, identity } of identified) {
      const previous = existing.get(identity);
      if (!previous) {
        newOrders++;
        continue;
      }
      const changed =
        previous.amountSpent !== receipt.amountSpent ||
        (previous.restaurantName ?? '') !== (receipt.restaurantName ?? '') ||
        previous.orderDate.getTime() !== receipt.orderDate?.getTime() ||
        previous.receiptType !== receipt.receiptType ||
        JSON.stringify(previous.items) !== JSON.stringify(receipt.items) ||
        JSON.stringify(previous.monetaryDetails) !== JSON.stringify({
          currencyCode: receipt.monetaryDetails?.currencyCode ?? null,
          subtotal: receipt.monetaryDetails?.subtotal ?? null,
          tax: receipt.monetaryDetails?.tax ?? null,
          tip: receipt.monetaryDetails?.tip ?? null,
          deliveryFee: receipt.monetaryDetails?.deliveryFee ?? null,
          serviceFee: receipt.monetaryDetails?.serviceFee ?? null,
          savings: receipt.monetaryDetails?.savings ?? null,
        });
      if (changed) updatedOrders++;
      else unchangedOrders++;
    }

    const batchSize = 100;
    for (let offset = 0; offset < identified.length; offset += batchSize) {
      await assertWriteAllowed();
      const batch = identified.slice(offset, offset + batchSize);
      const values: unknown[] = [];
      const placeholders = batch.map(({ receipt, identity }, index) => {
        const parameter = index * 18 + 1;
        values.push(
          uuidv4(),
          receipt.userId,
          receipt.receiptType,
          DataSource.EMAIL,
          receipt.restaurantName?.substring(0, 255) ?? null,
          receipt.orderDate,
          receipt.amountSpent,
          JSON.stringify(receipt.items),
          receipt.deliveryTime ?? null,
          receipt.externalId ?? null,
          identity,
          receipt.monetaryDetails?.currencyCode ?? null,
          receipt.monetaryDetails?.subtotal ?? null,
          receipt.monetaryDetails?.tax ?? null,
          receipt.monetaryDetails?.tip ?? null,
          receipt.monetaryDetails?.deliveryFee ?? null,
          receipt.monetaryDetails?.serviceFee ?? null,
          receipt.monetaryDetails?.savings ?? null,
        );
        return `(${Array.from({ length: 18 }, (_, value) => `$${parameter + value}`).join(', ')})`;
      });

      await transaction.query(
        `INSERT INTO receipts (
           id, user_id, receipt_type, data_source, restaurant_name, order_date,
           amount_spent, items, delivery_time, external_id, source_identity,
           currency_code, subtotal_amount, tax_amount, tip_amount,
           delivery_fee_amount, service_fee_amount, savings_amount
         ) VALUES ${placeholders.join(', ')}
         ON CONFLICT (user_id, data_source, source_identity)
           WHERE source_identity IS NOT NULL
         DO UPDATE SET
           receipt_type = EXCLUDED.receipt_type,
           restaurant_name = EXCLUDED.restaurant_name,
           order_date = EXCLUDED.order_date,
           amount_spent = EXCLUDED.amount_spent,
           items = EXCLUDED.items,
           delivery_time = EXCLUDED.delivery_time,
           external_id = COALESCE(EXCLUDED.external_id, receipts.external_id),
           currency_code = COALESCE(EXCLUDED.currency_code, receipts.currency_code),
           subtotal_amount = COALESCE(EXCLUDED.subtotal_amount, receipts.subtotal_amount),
           tax_amount = COALESCE(EXCLUDED.tax_amount, receipts.tax_amount),
           tip_amount = COALESCE(EXCLUDED.tip_amount, receipts.tip_amount),
           delivery_fee_amount = COALESCE(EXCLUDED.delivery_fee_amount, receipts.delivery_fee_amount),
           service_fee_amount = COALESCE(EXCLUDED.service_fee_amount, receipts.service_fee_amount),
           savings_amount = COALESCE(EXCLUDED.savings_amount, receipts.savings_amount),
           last_seen_at = NOW(),
           updated_at = CASE WHEN
             receipts.receipt_type IS DISTINCT FROM EXCLUDED.receipt_type OR
             receipts.restaurant_name IS DISTINCT FROM EXCLUDED.restaurant_name OR
             receipts.order_date IS DISTINCT FROM EXCLUDED.order_date OR
             receipts.amount_spent IS DISTINCT FROM EXCLUDED.amount_spent OR
             receipts.items IS DISTINCT FROM EXCLUDED.items OR
             receipts.delivery_time IS DISTINCT FROM EXCLUDED.delivery_time OR
             (EXCLUDED.currency_code IS NOT NULL AND receipts.currency_code IS DISTINCT FROM EXCLUDED.currency_code) OR
             (EXCLUDED.subtotal_amount IS NOT NULL AND receipts.subtotal_amount IS DISTINCT FROM EXCLUDED.subtotal_amount) OR
             (EXCLUDED.tax_amount IS NOT NULL AND receipts.tax_amount IS DISTINCT FROM EXCLUDED.tax_amount) OR
             (EXCLUDED.tip_amount IS NOT NULL AND receipts.tip_amount IS DISTINCT FROM EXCLUDED.tip_amount) OR
             (EXCLUDED.delivery_fee_amount IS NOT NULL AND receipts.delivery_fee_amount IS DISTINCT FROM EXCLUDED.delivery_fee_amount) OR
             (EXCLUDED.service_fee_amount IS NOT NULL AND receipts.service_fee_amount IS DISTINCT FROM EXCLUDED.service_fee_amount) OR
             (EXCLUDED.savings_amount IS NOT NULL AND receipts.savings_amount IS DISTINCT FROM EXCLUDED.savings_amount)
           THEN CURRENT_TIMESTAMP ELSE receipts.updated_at END`,
        values,
      );
    }

    await transaction.query(
      `INSERT INTO user_experience_state (user_id, setup_completed_at, setup_completion_method)
       VALUES ($1, NOW(), 'email_receipts')
       ON CONFLICT (user_id) DO UPDATE SET
         setup_completed_at=COALESCE(user_experience_state.setup_completed_at, NOW()),
         setup_completion_method=COALESCE(user_experience_state.setup_completion_method, 'email_receipts'),
         updated_at=NOW()`,
      [userId],
    );

    return { newOrders, updatedOrders, unchangedOrders };
  }

  /** Atomically replaces one provider export while preserving newer mailbox receipts. */
  async replaceProviderExport(
    userId: string,
    receipts: readonly ReceiptWriteCommand[],
    assertWriteAllowed: () => Promise<void>,
  ): Promise<void> {
    if (receipts.length === 0) return;

    const receiptTypes = [...new Set(receipts.map((receipt) => receipt.receiptType))];
    if (receiptTypes.length !== 1) {
      throw new Error('Export must contain receipts from exactly one provider');
    }
    const receiptType = receiptTypes[0];
    const datedReceipts = receipts
      .map((receipt) => receipt.orderDate)
      .filter((date): date is Date => Boolean(date));
    if (datedReceipts.length === 0) throw new Error('Export contains no valid order dates');
    const latestExportDate = new Date(Math.max(...datedReceipts.map((date) => date.getTime())));

    await this.postgres.withTransaction(async (transaction) => {
      await assertWriteAllowed();
      await transaction.query(
        `DELETE FROM receipts
         WHERE user_id = $1
           AND receipt_type = $2
           AND (data_source = 'csv' OR (data_source = 'email' AND order_date <= $3))`,
        [userId, receiptType, latestExportDate],
      );

      const batchSize = 50;
      for (let offset = 0; offset < receipts.length; offset += batchSize) {
        const batch = receipts.slice(offset, offset + batchSize);
        const values: unknown[] = [];
        const placeholders = batch.map((receipt, index) => {
          const parameter = index * 15 + 1;
          values.push(
            userId,
            receipt.receiptType,
            receipt.dataSource,
            receipt.restaurantName?.substring(0, 255) ?? null,
            receipt.orderDate,
            receipt.amountSpent,
            JSON.stringify(receipt.items),
            receipt.deliveryTime ?? null,
            receipt.monetaryDetails?.currencyCode ?? null,
            receipt.monetaryDetails?.subtotal ?? null,
            receipt.monetaryDetails?.tax ?? null,
            receipt.monetaryDetails?.tip ?? null,
            receipt.monetaryDetails?.deliveryFee ?? null,
            receipt.monetaryDetails?.serviceFee ?? null,
            receipt.monetaryDetails?.savings ?? null,
          );
          return `(${Array.from({ length: 15 }, (_, value) => `$${parameter + value}`).join(', ')})`;
        });
        await transaction.query(
          `INSERT INTO receipts (
             user_id, receipt_type, data_source, restaurant_name, order_date,
             amount_spent, items, delivery_time, currency_code, subtotal_amount,
             tax_amount, tip_amount, delivery_fee_amount, service_fee_amount, savings_amount
           ) VALUES ${placeholders.join(', ')}`,
          values,
        );
      }
      await transaction.query(
        `INSERT INTO user_experience_state (user_id, setup_completed_at, setup_completion_method)
         VALUES ($1, NOW(), 'provider_archive')
         ON CONFLICT (user_id) DO UPDATE SET
           setup_completed_at=COALESCE(user_experience_state.setup_completed_at, NOW()),
           setup_completion_method=COALESCE(user_experience_state.setup_completion_method, 'provider_archive'),
           updated_at=NOW()`,
        [userId],
      );
      await assertWriteAllowed();
    });
  }

  async stageProviderExport(jobId: string, receipts: readonly ReceiptWriteCommand[]): Promise<void> {
    await this.postgres.query('DELETE FROM import_receipt_staging WHERE job_id=$1', [jobId]);
    const batchSize = 100;
    for (let offset = 0; offset < receipts.length; offset += batchSize) {
      const batch = receipts.slice(offset, offset + batchSize);
      const values: unknown[] = [];
      const placeholders = batch.map((receipt, index) => {
        values.push(jobId, offset + index, JSON.stringify(receipt));
        const parameter = index * 3 + 1;
        return `($${parameter},$${parameter + 1},$${parameter + 2}::jsonb)`;
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
  ): Promise<void> {
    await this.postgres.withTransaction(async (transaction) => {
      const metadata = await transaction.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS count,
           ARRAY_AGG(DISTINCT receipt->>'receiptType') AS receipt_types,
           MAX(NULLIF(receipt->>'orderDate','')::timestamptz) AS latest_export_date
         FROM import_receipt_staging s JOIN import_jobs j ON j.id=s.job_id
         WHERE s.job_id=$1 AND j.user_id=$2`,
        [jobId, userId],
      );
      const row = metadata.rows[0] ?? {};
      const receiptTypes = Array.isArray(row.receipt_types) ? row.receipt_types : [];
      if (Number(row.count ?? 0) <= 0 || receiptTypes.length !== 1 || typeof receiptTypes[0] !== 'string' || !row.latest_export_date) {
        throw new Error('Staged export must contain dated receipts from exactly one provider');
      }
      await assertWriteAllowed();
      await transaction.query(
        `DELETE FROM receipts WHERE user_id=$1 AND receipt_type=$2
         AND (data_source='csv' OR (data_source='email' AND order_date<=$3))`,
        [userId, receiptTypes[0], row.latest_export_date],
      );
      await transaction.query(
        `INSERT INTO receipts(user_id,receipt_type,data_source,restaurant_name,order_date,amount_spent,items,delivery_time,external_id,
           currency_code,subtotal_amount,tax_amount,tip_amount,delivery_fee_amount,service_fee_amount,savings_amount)
         SELECT $2,(receipt->>'receiptType')::varchar,(receipt->>'dataSource')::varchar,
           NULLIF(receipt->>'restaurantName',''),NULLIF(receipt->>'orderDate','')::timestamptz,
           (receipt->>'amountSpent')::numeric,COALESCE(receipt->'items','[]'::jsonb),
           NULLIF(receipt->>'deliveryTime','')::timestamptz,NULLIF(receipt->>'externalId',''),
           NULLIF(receipt->'monetaryDetails'->>'currencyCode',''),
           NULLIF(receipt->'monetaryDetails'->>'subtotal','')::numeric,
           NULLIF(receipt->'monetaryDetails'->>'tax','')::numeric,
           NULLIF(receipt->'monetaryDetails'->>'tip','')::numeric,
           NULLIF(receipt->'monetaryDetails'->>'deliveryFee','')::numeric,
           NULLIF(receipt->'monetaryDetails'->>'serviceFee','')::numeric,
           NULLIF(receipt->'monetaryDetails'->>'savings','')::numeric
         FROM import_receipt_staging WHERE job_id=$1 ORDER BY sequence_number`,
        [jobId,userId],
      );
      await transaction.query(
        `INSERT INTO user_experience_state (user_id, setup_completed_at, setup_completion_method)
         VALUES ($1, NOW(), 'provider_archive')
         ON CONFLICT (user_id) DO UPDATE SET
           setup_completed_at=COALESCE(user_experience_state.setup_completed_at, NOW()),
           setup_completion_method=COALESCE(user_experience_state.setup_completion_method, 'provider_archive'),
           updated_at=NOW()`,
        [userId],
      );
      await assertWriteAllowed();
      await transaction.query('DELETE FROM import_receipt_staging WHERE job_id=$1', [jobId]);
    });
  }

  async getLatestCsvReceiptDates(userId: string): Promise<Partial<Record<ReceiptType, Date>>> {
    const result = await this.postgres.query<ReceiptCutoffRow>(
      `SELECT receipt_type, MAX(order_date) AS latest
       FROM receipts
       WHERE user_id = $1 AND data_source = 'csv'
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

  async getEmailReceiptStats(userId: string): Promise<{ count: number; total: number }> {
    const result = await this.postgres.query<ReceiptAggregateRow>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_spent), 0) AS total
       FROM receipts WHERE user_id = $1 AND data_source = 'email'`,
      [userId],
    );
    return {
      count: databaseNumber(result.rows[0]?.count, 'email_receipt_count', { integer: true }),
      total: databaseNumber(result.rows[0]?.total, 'email_receipt_total'),
    };
  }

  private buildWhereClause(filters: ReceiptListFilters): WhereClause {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: (index: number) => string, value: unknown): void => {
      params.push(value);
      conditions.push(sql(params.length));
    };

    add((index) => `user_id = $${index}`, filters.userId);
    if (filters.receiptType) add((index) => `receipt_type = $${index}`, filters.receiptType);
    if (filters.restaurantName) {
      add((index) => `restaurant_name ILIKE $${index}`, `%${filters.restaurantName}%`);
    }
    if (filters.startDate) add((index) => `order_date >= $${index}`, filters.startDate);
    if (filters.endDate) add((index) => `order_date <= $${index}`, filters.endDate);
    if (filters.minAmount !== undefined) {
      add((index) => `amount_spent >= $${index}`, filters.minAmount);
    }
    if (filters.maxAmount !== undefined) {
      add((index) => `amount_spent <= $${index}`, filters.maxAmount);
    }

    return { sql: `WHERE ${conditions.join(' AND ')}`, params };
  }

  private emailSourceIdentity(receipt: ReceiptWriteCommand): string | null {
    if (receipt.externalId) return `external:${receipt.externalId}`;
    if (!receipt.orderDate) return null;
    const restaurant = receipt.restaurantName?.trim().toLowerCase() || 'unknown';
    return `fallback:${restaurant}|${receipt.orderDate.toISOString().slice(0, 16)}`;
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

const nullableDatabaseNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  return databaseNumber(value, 'receipt monetary detail');
};
