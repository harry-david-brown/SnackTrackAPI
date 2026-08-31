import { QueryResultRow } from 'pg';
import { PostgresService } from '../data/PostgresService';
import { ReceiptForAnalytics } from './WrappedAnalyticsTypes';
import { LATE_NIGHT_END_HOUR, LATE_NIGHT_START_HOUR } from './shared/timeWindows';

interface TimezoneRow extends QueryResultRow { timezone: unknown }
interface AnalyticsReceiptRow extends QueryResultRow {
  id: unknown; userId: unknown; restaurantName: unknown; orderDate: unknown;
  amountSpent: unknown; items: unknown; receiptType: unknown; dataSource: unknown;
  deliveryTime: unknown;
}
interface PercentileRow extends QueryResultRow {
  spent_rank: unknown; orders_rank: unknown; night_owl_rank: unknown; sample_size: unknown;
}

export interface WrappedPercentileRanks {
  spentRank: number;
  ordersRank: number;
  nightOwlRank: number;
  sampleSize: number;
}

const parseDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseItems = (value: unknown): ReceiptForAnalytics['items'] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') return [];
    return [{
      name: record.name,
      quantity: Number.isFinite(Number(record.quantity)) ? Number(record.quantity) : 1,
      price: Number.isFinite(Number(record.price)) ? Number(record.price) : 0,
    }];
  });
};

/** Typed SQL adapter for wrapped analytics read projections. */
export class WrappedAnalyticsQueryRepository {
  constructor(private readonly postgres: PostgresService) {}

  async getUserTimezone(userId: string): Promise<string> {
    const result = await this.postgres.query<TimezoneRow>(
      'SELECT timezone FROM users WHERE id = $1',
      [userId],
    );
    return typeof result.rows[0]?.timezone === 'string'
      ? result.rows[0].timezone
      : 'America/New_York';
  }

  async getUserReceipts(userId: string): Promise<ReceiptForAnalytics[]> {
    const result = await this.postgres.query<AnalyticsReceiptRow>(`
      SELECT id, user_id as "userId", restaurant_name as "restaurantName",
        order_date as "orderDate", amount_spent as "amountSpent", items,
        receipt_type as "receiptType", data_source as "dataSource",
        delivery_time as "deliveryTime"
      FROM receipts
      WHERE user_id = $1
      ORDER BY order_date DESC
    `, [userId]);

    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.userId),
      restaurantName: row.restaurantName == null ? null : String(row.restaurantName),
      orderDate: parseDate(row.orderDate),
      amountSpent: Number.isFinite(Number(row.amountSpent)) ? Number(row.amountSpent) : 0,
      items: parseItems(row.items),
      receiptType: String(row.receiptType ?? 'unknown'),
      dataSource: String(row.dataSource ?? 'unknown'),
      deliveryTime: parseDate(row.deliveryTime),
    }));
  }

  async getPercentileRanks(userId: string, minimumReceipts: number): Promise<WrappedPercentileRanks | null> {
    const result = await this.postgres.query<PercentileRow>(`
      WITH per_user AS (
        SELECT r.user_id, SUM(r.amount_spent) AS total_spent, COUNT(*)::int AS order_count,
          AVG(CASE WHEN r.order_date IS NULL THEN NULL
            WHEN EXTRACT(HOUR FROM r.order_date AT TIME ZONE COALESCE(u.timezone, 'America/New_York')) >= ${LATE_NIGHT_START_HOUR}
              OR EXTRACT(HOUR FROM r.order_date AT TIME ZONE COALESCE(u.timezone, 'America/New_York')) < ${LATE_NIGHT_END_HOUR}
            THEN 1.0 ELSE 0.0 END) * 100 AS night_owl_pct
        FROM receipts r JOIN users u ON u.id = r.user_id
        GROUP BY r.user_id HAVING COUNT(*) >= $2
      ), ranked AS (
        SELECT user_id,
          PERCENT_RANK() OVER (ORDER BY total_spent) AS spent_rank,
          PERCENT_RANK() OVER (ORDER BY order_count) AS orders_rank,
          PERCENT_RANK() OVER (ORDER BY night_owl_pct) AS night_owl_rank,
          COUNT(*) OVER ()::int AS sample_size
        FROM per_user
      ) SELECT * FROM ranked WHERE user_id = $1
    `, [userId, minimumReceipts]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      spentRank: Number(row.spent_rank),
      ordersRank: Number(row.orders_rank),
      nightOwlRank: Number(row.night_owl_rank),
      sampleSize: Number(row.sample_size),
    };
  }
}
