/** SQL adapters over canonical receipts, never raw source-document rows.
 * Aliases are internal query identifiers, not request input.
 */
export function receiptHasSourceSql(alias: string, source: 'email' | 'csv'): string {
  return `(${alias}.data_source='${source}' OR COALESCE(${alias}.resolution->'sources' ? '${source}',FALSE))`;
}

/** Mirrors orderMetricEligibility; History and import activity must count alike. */
export function receiptOrderPredicates(alias: string) {
  const adjustment = `COALESCE(${alias}.order_kind='unlinked_adjustment',FALSE)`;
  const possible = `(NOT ${adjustment}
    AND COALESCE(${alias}.resolution->'reconciliation'->>'status'='unresolved',FALSE))`;
  return { adjustment, possible, established: `(NOT ${adjustment} AND NOT ${possible})` };
}
