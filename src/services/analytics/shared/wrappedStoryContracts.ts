import { isCurrencyOrderMetrics } from './orderMetricContracts';
import type { CurrencyOrderMetrics } from './orderMetrics';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableMoney = (value: unknown): boolean =>
  value === null ||
  (typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.00001);

function currencies(value: unknown): value is CurrencyOrderMetrics[] {
  return (
    Array.isArray(value) &&
    value.every(isCurrencyOrderMetrics) &&
    new Set(value.map((c) => c.currencyCode)).size === value.length
  );
}

/** Scalar cost may not conceal an unknown price or add different currencies. */
function spending(total: unknown, values: unknown): boolean {
  if (!nullableMoney(total) || !currencies(values)) return false;
  const one = values.length === 1 ? values[0] : undefined;
  const expected =
    one && one.currencyCode !== 'UNKNOWN' && one.unknownPriceOrders === 0 ? one.netSpend : null;
  return total === expected;
}

/** Validates the new evidence-bearing fields without redefining legacy stories. */
export function isWrappedStoryEvidence(value: Record<string, unknown>): boolean {
  if (value.orderMetrics === undefined) return true;
  if (
    value.behaviorPolicyVersion !== 1 ||
    !record(value.shame) ||
    !record(value.flex) ||
    !record(value.comparative) ||
    !record(value.patterns)
  )
    return false;
  const stories = [
    value.shame.lateNightOrders,
    value.shame.laziestDay,
    value.shame.longestStreak,
    value.shame.singleItemOrders,
    value.shame.chainDependency,
    value.flex.nightOwl,
    value.comparative.spentThisYear,
  ];
  if (
    !stories.every(
      (story) =>
        story === undefined || (record(story) && spending(story.totalSpent, story.spending)),
    )
  )
    return false;
  const chain = value.shame.chainDependency;
  if (
    record(chain) &&
    (!Array.isArray(chain.allChains) ||
      !chain.allChains.every((c) => record(c) && spending(c.spent, c.spending)))
  )
    return false;
  const coffee = value.flex.coffeeAddiction;
  if (
    coffee !== undefined &&
    (!record(coffee) || coffee.totalSpent !== null || coffee.averagePrice !== null)
  )
    return false;
  const weekend = value.patterns.weekendWarrior;
  if (
    weekend !== undefined &&
    (!record(weekend) ||
      weekend.ratioBasis !== 'deliveries_per_day' ||
      !nullableMoney(weekend.ratio) ||
      !spending(weekend.weekendSpending, weekend.weekendCosts) ||
      !spending(weekend.weekdaySpending, weekend.weekdayCosts))
  )
    return false;
  return true;
}
