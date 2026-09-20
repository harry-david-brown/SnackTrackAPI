import { receiptMetricSql } from '../data/ReceiptMetricSql';
import { receiptHasSourceSql } from '../data/ReceiptReadPredicates';
import { adminOrderCountFields } from './AdminReceiptSummary';

/** One SQL snapshot of canonical records; no raw observations, mailbox contents or item arrays. */
export function adminReceiptReportSql(userIdExpression?: '$1::uuid' | 'page.id') {
  const f = receiptMetricSql('r');
  const confirmed = "established AND refund_confidence='confirmed'";
  const countRules: Record<(typeof adminOrderCountFields)[number], string> = {
    attempts: 'established',
    deliveries: "established AND fulfillment='completed'",
    canceled: "established AND fulfillment='canceled'",
    chargedCancellations: "established AND fulfillment='canceled' AND net>0",
    zeroBalanceCancellations: "established AND fulfillment='canceled' AND net=0",
    failed: "established AND fulfillment='failed'",
    unfulfilled: "established AND fulfillment='unfulfilled'",
    unknownFulfillment: "established AND fulfillment='unknown'",
    confirmedRefunds: confirmed,
    fullyRefunded: `${confirmed} AND refund_status='full'`,
    partiallyRefunded: `${confirmed} AND refund_status='partial'`,
    unclassifiedRefunds: `${confirmed} AND refund_status IN ('confirmed_unclassified','conflicted')`,
    reversedRefunds: `${confirmed} AND refund_status='reversed'`,
    likelyRefunds: "established AND refund_status='probable_full'",
    possibleAdditionalOrders: 'possible',
    unlinkedAdjustments: 'adjustment',
    legacyOrders: 'established AND NOT has_outcome',
  };
  const sums = {
    netSpend: ['net', 'established'],
    deliveredNetSpend: ['net', "established AND fulfillment='completed'"],
    cancellationCost: ['net', "established AND fulfillment='canceled'"],
    confirmedRefundAmount: ['refund_amount', confirmed],
    estimatedRefundAmount: ['estimated_refund', "established AND refund_status='probable_full'"],
    possibleAdditionalSpend: ['net', 'possible'],
  };
  const counts = {
    pricedOrders: 'established AND net IS NOT NULL',
    estimatedPriceOrders: 'established AND net IS NOT NULL AND estimated',
    unknownPriceOrders: 'established AND net IS NULL',
    unpricedPossibleOrders: 'possible AND net IS NULL',
    confirmedRefundsWithUnknownAmount: `${confirmed} AND refund_amount IS NULL`,
  };
  return `WITH facts AS (
    SELECT r.receipt_type, ${f.currency} AS currency, ${f.adjustment} AS adjustment, ${f.possible} AS possible,
      ${f.established} AS established, ${f.hasOutcome} AS has_outcome, ${f.fulfillment} AS fulfillment,
      ${f.net} AS net, ${f.estimated} AS estimated,
      r.resolution->'orderOutcome'->>'refundConfidence' AS refund_confidence, r.order_refund_status AS refund_status,
      (r.resolution->'orderOutcome'->>'confirmedRefundAmount')::numeric AS refund_amount,
      (r.resolution->'orderOutcome'->>'estimatedRefundAmount')::numeric AS estimated_refund,
      ${receiptHasSourceSql('r', 'email')} AS has_email, ${receiptHasSourceSql('r', 'csv')} AS has_export
    FROM receipts r ${userIdExpression ? `WHERE r.user_id=${userIdExpression}` : ''}
  ), currency_metrics AS (
    SELECT currency, jsonb_build_object('currencyCode',currency,
      ${Object.entries(sums)
        .map(
          ([key, [field, condition]]) =>
            `'${key}',COALESCE(SUM(${field}) FILTER(WHERE ${condition}),0)`,
        )
        .join(',')},
      ${Object.entries(counts)
        .map(([key, condition]) => `'${key}',COUNT(*) FILTER(WHERE ${condition})`)
        .join(',')}
    ) AS value FROM facts WHERE NOT adjustment GROUP BY currency
  ), sources AS (
    SELECT source, receipt_type, jsonb_build_object('dataSource',source,'receiptType',receipt_type,
      'count',COUNT(*),'establishedOrders',COUNT(*) FILTER(WHERE established),'unresolvedCount',COUNT(*) FILTER(WHERE possible)) AS value
    FROM facts CROSS JOIN LATERAL (VALUES ('email',has_email),('csv',has_export)) evidence(source,present)
    WHERE present GROUP BY source,receipt_type
  ) SELECT jsonb_build_object('policyVersion',3,'receiptRecords',COUNT(*),
      ${Object.entries(countRules)
        .map(([key, condition]) => `'${key}',COUNT(*) FILTER(WHERE ${condition})`)
        .join(',')},
      'currencies',COALESCE((SELECT jsonb_agg(value ORDER BY currency) FROM currency_metrics),'[]'::jsonb)
    ) AS receipt_summary,
    COALESCE((SELECT jsonb_agg(value ORDER BY source,receipt_type) FROM sources),'[]'::jsonb) AS receipt_sources
    FROM facts`;
}
