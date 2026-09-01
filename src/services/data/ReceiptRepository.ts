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
      `SELECT source_identity, amount_spent, restaurant_name, order_date, receipt_type, items
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
        JSON.stringify(previous.items) !== JSON.stringify(receipt.items);
      if (changed) updatedOrders++;
      else unchangedOrders++;
    }

    const batchSize = 100;
    for (let offset = 0; offset < identified.length; offset += batchSize) {
      await assertWriteAllowed();
      const batch = identified.slice(offset, offset + batchSize);
      const values: unknown[] = [];
      const placeholders = batch.map(({ receipt, identity }, index) => {
        const parameter = index * 11 + 1;
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
        );
        return `($${parameter}, $${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4}, $${parameter + 5}, $${parameter + 6}, $${parameter + 7}, $${parameter + 8}, $${parameter + 9}, $${parameter + 10})`;
      });

      await transaction.query(
        `INSERT INTO receipts (
           id, user_id, receipt_type, data_source, restaurant_name, order_date,
           amount_spent, items, delivery_time, external_id, source_identity
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
           last_seen_at = NOW(),
           updated_at = CASE WHEN
             receipts.receipt_type IS DISTINCT FROM EXCLUDED.receipt_type OR
             receipts.restaurant_name IS DISTINCT FROM EXCLUDED.restaurant_name OR
             receipts.order_date IS DISTINCT FROM EXCLUDED.order_date OR
             receipts.amount_spent IS DISTINCT FROM EXCLUDED.amount_spent OR
             receipts.items IS DISTINCT FROM EXCLUDED.items OR
             receipts.delivery_time IS DISTINCT FROM EXCLUDED.delivery_time
           THEN CURRENT_TIMESTAMP ELSE receipts.updated_at END`,
        values,
      );
    }

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
          const parameter = index * 8 + 1;
          values.push(
            userId,
            receipt.receiptType,
            receipt.dataSource,
            receipt.restaurantName?.substring(0, 255) ?? null,
            receipt.orderDate,
            receipt.amountSpent,
            JSON.stringify(receipt.items),
            receipt.deliveryTime ?? null,
          );
          return `($${parameter}, $${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4}, $${parameter + 5}, $${parameter + 6}, $${parameter + 7})`;
        });
        await transaction.query(
          `INSERT INTO receipts (
             user_id, receipt_type, data_source, restaurant_name, order_date,
             amount_spent, items, delivery_time
           ) VALUES ${placeholders.join(', ')}`,
          values,
        );
      }
      await assertWriteAllowed();
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
