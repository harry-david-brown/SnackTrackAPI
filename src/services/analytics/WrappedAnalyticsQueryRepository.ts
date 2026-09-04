import { DatabaseError } from '../../core/errors';
import { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';
import { mapReceiptRow, ReceiptRow } from '../data/receiptRowMapper';
import { ReceiptForAnalytics } from './WrappedAnalyticsTypes';
import { LATE_NIGHT_END_HOUR, LATE_NIGHT_START_HOUR } from './shared/timeWindows';

interface TimezoneRow extends DatabaseRow {
  timezone: unknown;
}
interface PercentileRow extends DatabaseRow {
  spent_rank: unknown;
  orders_rank: unknown;
  night_owl_rank: unknown;
  sample_size: unknown;
}

export interface WrappedPercentileRanks {
  spentRank: number;
  ordersRank: number;
  nightOwlRank: number;
  sampleSize: number;
}

const finiteNumber = (value: unknown, field: string): number => {
  const candidate = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(candidate)) throw new DatabaseError(`Invalid analytics row: ${field}`);
  return candidate;
};

/** Typed SQL adapter for wrapped analytics read projections. */
export class WrappedAnalyticsQueryRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor) {}

  async getUserTimezone(userId: string): Promise<string> {
    const result = await this.postgres.query<TimezoneRow>(
      'SELECT timezone FROM users WHERE id = $1',
      [userId],
    );
    const timezone = result.rows[0]?.timezone;
    if (typeof timezone !== 'string' || timezone.trim().length === 0) {
      throw new DatabaseError('Invalid analytics row: timezone');
    }
    return timezone;
  }

  async getUserReceipts(userId: string): Promise<ReceiptForAnalytics[]> {
    const result = await this.postgres.query<ReceiptRow>(
      `
      SELECT id, user_id, restaurant_name, order_date, amount_spent, items,
        receipt_type, data_source, delivery_time, external_id,
        currency_code, subtotal_amount, tax_amount, tip_amount,
        delivery_fee_amount, service_fee_amount, savings_amount
      FROM receipts
      WHERE user_id = $1
      ORDER BY order_date DESC
    `,
      [userId],
    );

    return result.rows.map((row) => {
      const receipt = mapReceiptRow(row);
      const id = receipt.id;
      if (!id) throw new DatabaseError('Invalid analytics receipt identity');
      return {
        id,
        userId: receipt.userId,
        restaurantName: receipt.restaurantName ?? null,
        orderDate: receipt.orderDate ?? null,
        amountSpent: receipt.amountSpent,
        items: receipt.items,
        receiptType: receipt.receiptType,
        dataSource: receipt.dataSource,
        deliveryTime: receipt.deliveryTime ?? null,
        currencyCode: receipt.monetaryDetails?.currencyCode ?? null,
        subtotal: receipt.monetaryDetails?.subtotal ?? null,
        tax: receipt.monetaryDetails?.tax ?? null,
        tip: receipt.monetaryDetails?.tip ?? null,
        deliveryFee: receipt.monetaryDetails?.deliveryFee ?? null,
        serviceFee: receipt.monetaryDetails?.serviceFee ?? null,
        savings: receipt.monetaryDetails?.savings ?? null,
      };
    });
  }

  async getPercentileRanks(
    userId: string,
    minimumReceipts: number,
  ): Promise<WrappedPercentileRanks | null> {
    const result = await this.postgres.query<PercentileRow>(
      `
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
    `,
      [userId, minimumReceipts],
    );
    const row = result.rows[0];
    if (!row) return null;
    const spentRank = finiteNumber(row.spent_rank, 'spent_rank');
    const ordersRank = finiteNumber(row.orders_rank, 'orders_rank');
    const nightOwlRank = finiteNumber(row.night_owl_rank, 'night_owl_rank');
    const sampleSize = finiteNumber(row.sample_size, 'sample_size');
    if (
      spentRank < 0 ||
      spentRank > 1 ||
      ordersRank < 0 ||
      ordersRank > 1 ||
      nightOwlRank < 0 ||
      nightOwlRank > 1 ||
      !Number.isInteger(sampleSize) ||
      sampleSize < 0
    ) {
      throw new DatabaseError('Invalid analytics percentile row');
    }
    return { spentRank, ordersRank, nightOwlRank, sampleSize };
  }
}
