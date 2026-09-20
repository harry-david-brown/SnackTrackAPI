import { LATE_NIGHT_END_HOUR, LATE_NIGHT_START_HOUR } from './shared/timeWindows';
import { receiptMetricSql } from '../data/ReceiptMetricSql';
const receiptFacts = receiptMetricSql('r');

/** PostgreSQL adapter of buildOrderComparisonProfile, verified against domain fixtures.
 * No source observations are counted: every input row is a canonical receipt projection.
 */
export const ORDER_COMPARISON_PROFILES_SQL = `
  WITH facts AS (
    SELECT r.user_id, ${receiptFacts.currency} AS currency_code, r.order_date,
      COALESCE(r.resolution->'orderOutcome'->>'version' = '3', FALSE) AS policy_three,
      COALESCE(r.order_kind = 'unlinked_adjustment', FALSE) AS adjustment,
      COALESCE(r.order_kind = 'unlinked_adjustment', FALSE) = FALSE
        AND COALESCE(r.resolution->'reconciliation'->>'status'='unresolved', FALSE) AS possible,
      COALESCE(r.order_fulfillment, 'unknown') AS fulfillment,
      ${receiptFacts.net} AS net,
      ${receiptFacts.estimated} AS estimated,
      CASE WHEN r.order_date IS NOT NULL AND r.resolution->'timestamp'->>'role'='placed'
        AND r.resolution->'timestamp'->>'precision'='minute' AND z.name IS NOT NULL
        THEN EXTRACT(HOUR FROM r.order_date AT TIME ZONE z.name) END AS placed_hour
    FROM receipts r JOIN users u ON u.id=r.user_id
    LEFT JOIN pg_timezone_names z ON LOWER(z.name)=LOWER(COALESCE(r.resolution->'timestamp'->>'timezone',u.timezone,'America/New_York'))
  ), currency_counts AS (
    SELECT user_id, COALESCE(currency_code,'UNKNOWN') AS currency_code,
      COUNT(*) FILTER(WHERE net IS NOT NULL)::int AS priced_orders,
      COUNT(*) FILTER(WHERE net IS NULL)::int AS unknown_prices,
      COALESCE(SUM(net),0) AS net_spend, BOOL_OR(estimated) AS estimated_net_cost
    FROM facts WHERE NOT adjustment AND NOT possible
    GROUP BY user_id, COALESCE(currency_code,'UNKNOWN')
  ), primary_currency AS (
    SELECT *, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY (currency_code='UNKNOWN'),priced_orders DESC,currency_code) AS position
    FROM currency_counts
  ), user_counts AS (
    SELECT user_id, BOOL_OR(possible) AS possible, BOOL_OR(adjustment) AS adjustment,
      BOOL_OR(NOT policy_three AND NOT adjustment AND NOT possible) AS legacy,
      BOOL_OR(fulfillment='unknown' AND NOT adjustment AND NOT possible) AS unknown_fulfillment,
      COUNT(*) FILTER(WHERE fulfillment='completed' AND NOT adjustment AND NOT possible)::int AS deliveries,
      COUNT(*) FILTER(WHERE fulfillment='completed' AND NOT adjustment AND NOT possible AND placed_hour IS NOT NULL)::int AS timed_deliveries,
      AVG(CASE WHEN fulfillment='completed' AND NOT adjustment AND NOT possible AND placed_hour IS NOT NULL
        THEN CASE WHEN placed_hour >= ${LATE_NIGHT_START_HOUR} OR placed_hour < ${LATE_NIGHT_END_HOUR} THEN 1.0 ELSE 0.0 END END) AS night_owl_share
    FROM facts GROUP BY user_id
  ) SELECT u.user_id, COALESCE(c.currency_code,'UNKNOWN') AS currency_code,
      CASE WHEN NOT u.possible AND NOT u.legacy AND NOT u.adjustment AND c.currency_code<>'UNKNOWN' AND c.unknown_prices=0 THEN c.net_spend END AS net_spend,
      COALESCE(c.priced_orders,0) AS priced_orders, COALESCE(c.estimated_net_cost,FALSE) AS estimated_net_cost,
      CASE WHEN NOT u.possible AND NOT u.legacy AND NOT u.unknown_fulfillment THEN u.deliveries END AS deliveries,
      u.timed_deliveries,
      CASE WHEN NOT u.possible AND NOT u.legacy AND NOT u.unknown_fulfillment THEN u.night_owl_share END AS night_owl_share
    FROM user_counts u LEFT JOIN primary_currency c ON c.user_id=u.user_id AND c.position=1
`;

/** The target comes from the same read snapshot as Summary/Wrapped, never a second receipt read. */
export const ORDER_COMPARISON_RANKS_SQL = `
  WITH peer_profiles AS (${ORDER_COMPARISON_PROFILES_SQL}), target AS (
    SELECT $1::uuid AS user_id, x.* FROM jsonb_to_record($3::jsonb) AS x(
      currency_code text, net_spend numeric, priced_orders int, estimated_net_cost boolean,
      deliveries int, timed_deliveries int, night_owl_share numeric)
  ), profiles AS (
    SELECT * FROM peer_profiles WHERE user_id<>$1::uuid
    UNION ALL SELECT * FROM target
  ), measures AS (
    SELECT user_id, 'spent' AS metric, net_spend AS value, estimated_net_cost
      FROM profiles WHERE net_spend IS NOT NULL AND priced_orders >= $2
        AND currency_code=(SELECT currency_code FROM target)
    UNION ALL SELECT user_id, 'orders', deliveries, FALSE
      FROM profiles WHERE deliveries IS NOT NULL AND deliveries >= $2
    UNION ALL SELECT user_id, 'night', night_owl_share, FALSE
      FROM profiles WHERE night_owl_share IS NOT NULL AND timed_deliveries >= $2
  ), ranked AS (
    -- Match JavaScript's ratio representation so e.g. 5/6 and 10/12 tie with the target.
    -- Currency values retain exact numeric ordering, independently of this ratio conversion.
    SELECT user_id, metric, (RANK() OVER(PARTITION BY metric ORDER BY
      CASE WHEN metric='night' THEN value::double precision END,
      CASE WHEN metric<>'night' THEN value END)-1)::int AS lower_count,
      (COUNT(*) OVER(PARTITION BY metric))::int AS sample_size,
      BOOL_OR(estimated_net_cost) OVER(PARTITION BY metric) AS estimated_net_cost
    FROM measures
  ) SELECT metric, lower_count, sample_size, estimated_net_cost FROM ranked WHERE user_id=$1::uuid
`;
