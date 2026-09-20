import { DatabaseError } from '../../core/errors';
import { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';
import { mapReceiptRow, ReceiptRow } from '../data/receiptRowMapper';
import { ReceiptForAnalytics } from './WrappedAnalyticsTypes';
import { LATE_NIGHT_END_HOUR, LATE_NIGHT_START_HOUR } from './shared/timeWindows';
import { ORDER_COMPARISON_RANKS_SQL } from './OrderComparisonSql';
import type {
  OrderComparisonProfile,
  OrderComparisonRanks,
  WrappedPercentileRanks,
} from './shared/orderComparisons';
import { projectReceiptForAnalytics } from './ReceiptAnalyticsProjection';

interface TimezoneRow extends DatabaseRow {
  timezone: unknown;
}
interface PercentileRow extends DatabaseRow {
  spent_rank: unknown;
  orders_rank: unknown;
  night_owl_rank: unknown;
  sample_size: unknown;
}

const finiteNumber = (value: unknown, field: string): number => {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    throw new DatabaseError(`Invalid analytics row: ${field}`);
  const candidate = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(candidate)) throw new DatabaseError(`Invalid analytics row: ${field}`);
  return candidate;
};

/** Typed SQL adapter for wrapped analytics read projections. */
export class WrappedAnalyticsQueryRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor) {}

  async getRecapCoverage(userId: string): Promise<import('./shared/recapStories').RecapCoverageInterval[]> {
    const result = await this.postgres.query<DatabaseRow>(
      `SELECT provider, declared_start, declared_end FROM receipt_import_batches
       WHERE user_id=$1 AND association_enabled AND successful_completion=true AND rejected_records=0
         AND declared_start IS NOT NULL AND declared_end IS NOT NULL`, [userId]);
    return result.rows.flatMap(row => {
      const start = new Date(String(row.declared_start)), end = new Date(String(row.declared_end));
      if (typeof row.provider !== 'string' || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
      return [{ provider: row.provider, start: start.toISOString(), end: end.toISOString() }];
    });
  }

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
        delivery_fee_amount, service_fee_amount, savings_amount, resolution
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
      return projectReceiptForAnalytics(receipt);
    });
  }

  async getPercentileRanks(
    userId: string,
    minimumReceipts: number,
    target?: OrderComparisonProfile,
  ): Promise<WrappedPercentileRanks | null> {
    if (!Number.isSafeInteger(minimumReceipts) || minimumReceipts < 1)
      throw new DatabaseError('Invalid comparison minimum');
    if (target) return this.getOrderComparisonRanks(userId, minimumReceipts, target);
    const result = await this.postgres.query<PercentileRow>(
      `
      WITH target_currency AS (
        SELECT currency_code FROM receipts WHERE user_id=$1 AND currency_code IS NOT NULL AND currency_code<>'UNKNOWN'
        GROUP BY currency_code ORDER BY COUNT(*) DESC,currency_code LIMIT 1
      ), per_user AS (
        SELECT r.user_id, SUM(r.amount_spent) AS total_spent, COUNT(*)::int AS order_count,
          AVG(CASE WHEN r.order_date IS NULL THEN NULL
            WHEN EXTRACT(HOUR FROM r.order_date AT TIME ZONE COALESCE(u.timezone, 'America/New_York')) >= ${LATE_NIGHT_START_HOUR}
              OR EXTRACT(HOUR FROM r.order_date AT TIME ZONE COALESCE(u.timezone, 'America/New_York')) < ${LATE_NIGHT_END_HOUR}
            THEN 1.0 ELSE 0.0 END) * 100 AS night_owl_pct
        FROM receipts r JOIN users u ON u.id = r.user_id
        WHERE r.currency_code=(SELECT currency_code FROM target_currency)
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

  private async getOrderComparisonRanks(
    userId: string,
    minimumOrders: number,
    target: OrderComparisonProfile,
  ): Promise<OrderComparisonRanks> {
    const result = await this.postgres.query(ORDER_COMPARISON_RANKS_SQL, [
      userId,
      minimumOrders,
      JSON.stringify({
        currency_code: target.currencyCode,
        net_spend: target.netSpend,
        priced_orders: target.pricedOrders,
        estimated_net_cost: target.estimatedNetCost,
        deliveries: target.deliveries,
        timed_deliveries: target.timedDeliveries,
        night_owl_share: target.nightOwlShare,
      }),
    ]);
    const ranks: OrderComparisonRanks = {
      policyVersion: 3,
      currencyCode: target.currencyCode,
      totalSpent: null,
      orderCount: null,
      nightOwl: null,
      estimatedNetCost: false,
    };
    const seen = new Set<string>();
    for (const row of result.rows) {
      if (row.metric !== 'spent' && row.metric !== 'orders' && row.metric !== 'night')
        throw new DatabaseError('Invalid comparison metric');
      if (seen.has(row.metric)) throw new DatabaseError('Duplicate comparison metric');
      seen.add(row.metric);
      const lowerCount = finiteNumber(row.lower_count, 'lower_count');
      const sampleSize = finiteNumber(row.sample_size, 'sample_size');
      if (
        !Number.isSafeInteger(lowerCount) ||
        !Number.isSafeInteger(sampleSize) ||
        lowerCount < 0 ||
        sampleSize < 1 ||
        lowerCount >= sampleSize ||
        typeof row.estimated_net_cost !== 'boolean'
      )
        throw new DatabaseError('Invalid order comparison row');
      const key =
        row.metric === 'spent' ? 'totalSpent' : row.metric === 'orders' ? 'orderCount' : 'nightOwl';
      ranks[key] = { lowerCount, sampleSize };
      if (key === 'totalSpent') ranks.estimatedNetCost = row.estimated_net_cost;
    }
    return ranks;
  }
}
