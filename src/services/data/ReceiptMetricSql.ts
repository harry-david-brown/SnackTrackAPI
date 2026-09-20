import { receiptOrderPredicates } from './ReceiptReadPredicates';

/** SQL adapter of orderMetricEligibility/orderMetricCurrency. Aliases are internal, never request input. */
export function receiptMetricSql(alias: string) {
  const outcome = `${alias}.resolution->'orderOutcome'`;
  const hasOutcome = `(${outcome} IS NOT NULL AND ${outcome}<>'null'::jsonb)`;
  return {
    ...receiptOrderPredicates(alias),
    hasOutcome,
    currency: `CASE WHEN ${alias}.currency_code IN ('CAD','USD','EUR','GBP') THEN ${alias}.currency_code ELSE 'UNKNOWN' END`,
    fulfillment: `COALESCE(${alias}.order_fulfillment,'unknown')`,
    net: `CASE WHEN ${hasOutcome} THEN CASE WHEN ${outcome}->>'financialConfidence'='conflicted' THEN NULL ELSE ${alias}.order_net_amount END
      WHEN ${alias}.resolution->>'amountBasis'='item_subtotal' THEN NULL ELSE ${alias}.amount_spent END`,
    estimated: `CASE WHEN ${hasOutcome} THEN COALESCE(${outcome}->>'financialConfidence'='inferred',FALSE) ELSE TRUE END`,
  };
}
