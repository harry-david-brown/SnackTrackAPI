import type { PercentileStanding, WrappedPercentiles } from '../WrappedAnalyticsTypes';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Both cache reads and pure calculation reject impossible/stale comparison contracts. */
export function isWrappedPercentiles(value: unknown): value is WrappedPercentiles {
  if (!record(value) || !integer(value.sampleSize, 100)) return false;
  if (value.policyVersion !== undefined && value.policyVersion !== 3) return false;
  const current = value.policyVersion === 3;
  const standing = (candidate: unknown): candidate is PercentileStanding =>
    record(candidate) &&
    integer(candidate.percentile, 0, current ? 99 : 100) &&
    integer(candidate.topPercent, 1, 100) &&
    (!current || candidate.topPercent === 100 - candidate.percentile) &&
    (current ? integer(candidate.sampleSize, 100) : candidate.sampleSize === undefined);
  const values = [value.totalSpent, value.orderCount, value.nightOwl].filter(
    (v) => v !== undefined,
  );
  if (!values.length || !values.every(standing)) return false;
  if (!current) return true;
  return (
    typeof value.methodology === 'string' &&
    value.methodology.trim().length > 0 &&
    ['CAD', 'USD', 'EUR', 'GBP', 'UNKNOWN'].includes(String(value.currencyCode)) &&
    (value.totalSpent === undefined || value.currencyCode !== 'UNKNOWN') &&
    value.sampleSize === Math.max(...values.map((v) => v.sampleSize!))
  );
}
