import { QueryResultRow } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { DataSource, Receipt, ReceiptType } from '../../models/Receipt';
import { PostgresService } from './PostgresService';
import { mapReceiptRow, ReceiptRow } from './receiptRowMapper';

export interface ReceiptListFilters {
  userId: string;
  receiptType?: ReceiptType;
  restaurantName?: string;
  startDate?: Date;
  endDate?: Date;
  minAmount?: number;
  maxAmount?: number;
}

export interface ReceiptPage {
  receipts: Receipt[];
  total: number;
}

interface TotalSpentRow extends QueryResultRow {
  total: string | number;
}

interface CountRow extends QueryResultRow {
  count: string | number;
}

interface ExistingEmailReceiptRow extends QueryResultRow {
  source_identity: string;
  amount_spent: string | number;
  restaurant_name: string | null;
  order_date: Date | string;
  receipt_type: string;
  items: unknown;
}

interface ReceiptCutoffRow extends QueryResultRow {
  receipt_type: string;
  latest: Date | string | null;
}

interface ReceiptAggregateRow extends QueryResultRow {
  count: string | number;
  total: string | number;
}

export interface ReceiptUpsertResult {
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

/** Canonical receipt persistence adapter. */
export class ReceiptRepository {
  constructor(private readonly postgres: PostgresService) {}

  async findPage(
    filters: ReceiptListFilters,
    limit: number,
    offset: number
  ): Promise<ReceiptPage> {
    const where = this.buildWhereClause(filters);
    const listParams = [...where.params, limit, offset];
    const [listResult, countResult] = await Promise.all([
      this.postgres.query<ReceiptRow>(
        `SELECT * FROM receipts
         ${where.sql}
         ORDER BY order_date DESC
         LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        listParams
      ),
      this.postgres.query<CountRow>(
        `SELECT COUNT(*) AS count FROM receipts ${where.sql}`,
        where.params
      ),
    ]);

    const total = Number(countResult.rows[0]?.count ?? 0);
    return {
      receipts: listResult.rows.map(mapReceiptRow),
      total: Number.isFinite(total) ? total : 0,
    };
  }

  async findByUserId(userId: string): Promise<Receipt[]> {
    const result = await this.postgres.query<ReceiptRow>(
      'SELECT * FROM receipts WHERE user_id = $1 ORDER BY order_date DESC',
      [userId]
    );
    return result.rows.map(mapReceiptRow);
  }

  async getTotalSpentByUserId(userId: string): Promise<number> {
    const result = await this.postgres.query<TotalSpentRow>(
      'SELECT COALESCE(SUM(amount_spent), 0) AS total FROM receipts WHERE user_id = $1',
      [userId]
    );
    const total = Number(result.rows[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  async save(receipt: Receipt): Promise<void> {
    const truncatedRestaurantName = receipt.restaurantName?.substring(0, 255);
    await this.postgres.query(
      `INSERT INTO receipts (
         user_id, receipt_type, data_source, restaurant_name, order_date,
         amount_spent, items, delivery_time
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        receipt.userId,
        receipt.receiptType,
        receipt.dataSource,
        truncatedRestaurantName,
        receipt.orderDate,
        receipt.amountSpent,
        JSON.stringify(receipt.items),
        receipt.deliveryTime ?? null,
      ]
    );
  }

  async saveMany(receipts: readonly Receipt[]): Promise<void> {
    for (const receipt of receipts) await this.save(receipt);
  }

  /** Incrementally merges Gmail receipts by stable provider/source identity. */
  async upsertEmailReceipts(
    receipts: readonly Receipt[],
    assertWriteAllowed: () => Promise<void>
  ): Promise<ReceiptUpsertResult> {
    if (receipts.length === 0) {
      return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0 };
    }

    await assertWriteAllowed();
    const identified = receipts
      .map((receipt) => ({ receipt, identity: this.emailSourceIdentity(receipt) }))
      .filter((entry): entry is { receipt: Receipt; identity: string } => Boolean(entry.identity));
    if (identified.length === 0) {
      return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0 };
    }

    const userId = identified[0].receipt.userId;
    const existingResult = await this.postgres.query<ExistingEmailReceiptRow>(
      `SELECT source_identity, amount_spent, restaurant_name, order_date, receipt_type, items
       FROM receipts
       WHERE user_id = $1 AND data_source = 'email' AND source_identity = ANY($2::TEXT[])`,
      [userId, identified.map((entry) => entry.identity)]
    );
    const existing = new Map(existingResult.rows.map((row) => [row.source_identity, row]));
    let newOrders = 0;
    let updatedOrders = 0;
    let unchangedOrders = 0;

    for (const { receipt, identity } of identified) {
      const previous = existing.get(identity);
      if (!previous) {
        newOrders++;
        continue;
      }
      const changed = Number(previous.amount_spent) !== receipt.amountSpent
        || (previous.restaurant_name ?? '') !== (receipt.restaurantName ?? '')
        || new Date(previous.order_date).getTime() !== receipt.orderDate?.getTime()
        || previous.receipt_type !== receipt.receiptType
        || JSON.stringify(previous.items ?? []) !== JSON.stringify(receipt.items);
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
          identity
        );
        return `($${parameter}, $${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4}, $${parameter + 5}, $${parameter + 6}, $${parameter + 7}, $${parameter + 8}, $${parameter + 9}, $${parameter + 10})`;
      });

      await this.postgres.query(
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
        values
      );
    }

    return { newOrders, updatedOrders, unchangedOrders };
  }

  async findByDateRange(userId: string, startDate: Date, endDate: Date): Promise<Receipt[]> {
    const result = await this.postgres.query<ReceiptRow>(
      `SELECT * FROM receipts
       WHERE user_id = $1 AND order_date BETWEEN $2 AND $3
       ORDER BY order_date DESC`,
      [userId, startDate, endDate]
    );
    return result.rows.map(mapReceiptRow);
  }

  async getLatestCsvReceiptDates(userId: string): Promise<Partial<Record<ReceiptType, Date>>> {
    const result = await this.postgres.query<ReceiptCutoffRow>(
      `SELECT receipt_type, MAX(order_date) AS latest
       FROM receipts
       WHERE user_id = $1 AND data_source = 'csv'
       GROUP BY receipt_type`,
      [userId]
    );
    const cutoffs: Partial<Record<ReceiptType, Date>> = {};
    for (const row of result.rows) {
      if (!isReceiptTypeValue(row.receipt_type) || row.latest === null) continue;
      const date = row.latest instanceof Date ? row.latest : new Date(row.latest);
      if (!Number.isNaN(date.getTime())) cutoffs[row.receipt_type] = date;
    }
    return cutoffs;
  }

  async getEmailReceiptStats(userId: string): Promise<{ count: number; total: number }> {
    const result = await this.postgres.query<ReceiptAggregateRow>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_spent), 0) AS total
       FROM receipts WHERE user_id = $1 AND data_source = 'email'`,
      [userId]
    );
    const count = Number(result.rows[0]?.count ?? 0);
    const total = Number(result.rows[0]?.total ?? 0);
    return {
      count: Number.isFinite(count) ? count : 0,
      total: Number.isFinite(total) ? total : 0,
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

  private emailSourceIdentity(receipt: Receipt): string | null {
    if (receipt.externalId) return `external:${receipt.externalId}`;
    if (!receipt.orderDate) return null;
    const restaurant = receipt.restaurantName?.trim().toLowerCase() || 'unknown';
    return `fallback:${restaurant}|${receipt.orderDate.toISOString().slice(0, 16)}`;
  }
}

const isReceiptTypeValue = (value: string): value is ReceiptType => (
  Object.values(ReceiptType).some((receiptType) => receiptType === value)
);
