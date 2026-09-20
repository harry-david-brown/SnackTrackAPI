import type { ReceiptListFilters } from '../ports/ReceiptPorts';
import type { ReceiptOutcomeFilter } from '../receipt/ReceiptHistoryFilters';
import { receiptOrderPredicates } from './ReceiptReadPredicates';

const established = 'NOT adjustment AND NOT possible';
/** SQL adapter of matchesReceiptOutcome and orderMetricEligibility, over canonical rows only. */
const outcomePredicates: Record<ReceiptOutcomeFilter, string> = {
  delivered: `(${established}) AND order_fulfillment='completed'`,
  canceled: `(${established}) AND order_fulfillment='canceled'`,
  failed: `(${established}) AND order_fulfillment='failed'`,
  unfulfilled: `(${established}) AND order_fulfillment='unfulfilled'`,
  refunded: `(${established}) AND resolution->'orderOutcome'->>'refundConfidence'='confirmed'`,
  possible_refund: `(${established}) AND order_refund_status='probable_full'`,
  unknown_cost: 'NOT adjustment AND net IS NULL',
  needs_review: `(adjustment OR COALESCE(resolution->'reconciliation'->>'status'='unresolved',FALSE)
    OR COALESCE(resolution->'orderOutcome'->>'financialConfidence'='conflicted',FALSE)
    OR COALESCE(resolution->'orderOutcome'->>'fulfillmentConfidence'='conflicted',FALSE)
    OR COALESCE(order_refund_status='conflicted',FALSE))`,
};

export function receiptHistoryQuery(filters: ReceiptListFilters, limit: number, offset: number) {
  const order = receiptOrderPredicates('r');
  const params: unknown[] = [filters.userId];
  const conditions: string[] = [];
  const add = (sql: (index: number) => string, value: unknown) => {
    params.push(value);
    conditions.push(sql(params.length));
  };
  if (filters.receiptType) add((i) => `receipt_type=$${i}`, filters.receiptType);
  if (filters.restaurantName)
    add(
      (i) => `restaurant_name ILIKE $${i}`,
      `%${filters.restaurantName.replace(/[\\%_]/g, '\\$&')}%`,
    );
  if (filters.currencyCode) add((i) => `history_currency=$${i}`, filters.currencyCode);
  if (filters.outcome) conditions.push(outcomePredicates[filters.outcome]);
  if (filters.startDay) add((i) => `history_day >= $${i}::date`, filters.startDay);
  if (filters.endDay) add((i) => `history_day <= $${i}::date`, filters.endDay);
  if (filters.startDate)
    add((i) => `NOT adjustment AND order_date >= $${i}::timestamptz`, filters.startDate);
  if (filters.endDate)
    add((i) => `NOT adjustment AND order_date <= $${i}::timestamptz`, filters.endDate);
  if (filters.minAmount !== undefined)
    add((i) => `NOT adjustment AND net >= $${i}::numeric`, filters.minAmount);
  if (filters.maxAmount !== undefined)
    add((i) => `NOT adjustment AND net <= $${i}::numeric`, filters.maxAmount);
  params.push(limit, offset);
  return {
    params,
    // One statement gives the list, count and account timezone the same database snapshot,
    // including an empty/out-of-range page. The aggregate contains only the requested page.
    sql: `WITH owner AS (SELECT id,COALESCE(timezone,'America/New_York') AS timezone FROM users WHERE id=$1),
    facts AS (
      SELECT r.*,
        ${order.adjustment} AS adjustment,
        ${order.possible} AS possible,
        CASE WHEN r.resolution->'orderOutcome' IS NOT NULL AND r.resolution->'orderOutcome'<>'null'::jsonb
          THEN CASE WHEN r.resolution->'orderOutcome'->>'financialConfidence'='conflicted' THEN NULL ELSE r.order_net_amount END
          WHEN r.resolution->>'amountBasis'='item_subtotal' THEN NULL ELSE r.amount_spent END AS net,
        CASE WHEN r.currency_code IN ('CAD','USD','EUR','GBP') THEN r.currency_code ELSE 'UNKNOWN' END AS history_currency,
        CASE WHEN NOT ${order.adjustment} AND z.name IS NOT NULL
          THEN (r.order_date AT TIME ZONE z.name)::date END AS history_day
      FROM receipts r JOIN owner u ON u.id=r.user_id
      LEFT JOIN pg_timezone_names z ON LOWER(z.name)=LOWER(COALESCE(r.resolution->'timestamp'->>'timezone',u.timezone))
    ), matching AS (SELECT * FROM facts ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}),
    page AS (SELECT * FROM matching ORDER BY history_day DESC NULLS LAST,order_date DESC NULLS LAST,id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length})
    SELECT (SELECT COUNT(*) FROM matching) AS count,
      (SELECT timezone FROM owner) AS timezone,
      COALESCE((SELECT jsonb_agg(page ORDER BY history_day DESC NULLS LAST,order_date DESC NULLS LAST,id DESC) FROM page),'[]'::jsonb) AS receipts`,
  };
}
