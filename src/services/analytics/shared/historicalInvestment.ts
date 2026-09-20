export const INVESTMENT_MODEL_VERSION = 'historical-v1' as const;
export const BENCHMARK_NAMES = { sp500: 'S&P 500', nasdaq: 'Nasdaq' } as const;
export type InvestmentBenchmark = keyof typeof BENCHMARK_NAMES;
export interface MarketPoint {
  date: string;
  close: number;
}
export interface MarketSnapshot {
  id: string;
  provider: 'finazon';
  adjustment: 'all';
  retrievedAt: string;
  valuationDate: string;
  series: Record<InvestmentBenchmark, MarketPoint[]>;
}
export interface InvestmentContext {
  mode: 'fixed' | 'historical';
  snapshot: MarketSnapshot | null;
  freshness: 'fixed' | 'ready' | 'unavailable' | 'stale';
  cacheToken: string;
}
export interface HistoricalInvestmentResult {
  modelVersion: typeof INVESTMENT_MODEL_VERSION;
  snapshotId: string;
  valuationDate: string;
  currencyCode: string;
  contributionCount: number;
  contributed: number;
  selectedBenchmark: InvestmentBenchmark;
  outcomes: Record<InvestmentBenchmark, { value: number; gain: number }>;
}
export const INVESTMENT_METHODOLOGY =
  'Based on index-tracking funds with reinvested dividends. Nasdaq refers to the Nasdaq-100. Fund expenses are reflected; excludes exchange-rate effects, personal taxes, and trading costs. Higher of the two historical scenarios; hypothetical, not financial advice.';
export const investmentMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;
export const isMarketDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export function investmentContext(
  mode: 'fixed' | 'historical',
  snapshot: MarketSnapshot | null,
  now: Date,
): InvestmentContext {
  const freshness =
    mode === 'fixed'
      ? 'fixed'
      : !snapshot
        ? 'unavailable'
        : now.getTime() - Date.parse(snapshot.valuationDate) > 62 * 86400000 ||
            snapshot.valuationDate > now.toISOString().slice(0, 10)
          ? 'stale'
          : 'ready';
  return {
    mode,
    snapshot,
    freshness,
    cacheToken: `${INVESTMENT_MODEL_VERSION}:${mode}:${snapshot?.id ?? 'none'}:${freshness}`,
  };
}
export function calculateHistoricalInvestment(
  contributions: readonly { amount: number; date: string }[],
  currencyCode: string,
  context: InvestmentContext,
): HistoricalInvestmentResult | undefined {
  if (context.freshness !== 'ready' || !context.snapshot || currencyCode === 'UNKNOWN') return;
  const snapshot = context.snapshot;
  const valid = contributions.filter((c) => Number.isFinite(c.amount) && c.amount > 0);
  if (valid.some((c) => !isMarketDate(c.date))) return;
  const included = valid.filter((c) => c.date <= snapshot.valuationDate);
  if (!included.length) return;
  const contributed = included.reduce((sum, c) => sum + c.amount, 0);
  const values = { sp500: 0, nasdaq: 0 };
  for (const benchmark of ['sp500', 'nasdaq'] as const) {
    const points = snapshot.series[benchmark];
    const ending = points[points.length - 1];
    if (!ending || ending.date !== snapshot.valuationDate) return;
    for (const contribution of included) {
      if (contribution.date < points[0].date) return;
      let low = 0,
        high = points.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (points[mid].date < contribution.date) low = mid + 1;
        else high = mid;
      }
      const purchase = points[low];
      if (!purchase || purchase.date > snapshot.valuationDate) return;
      values[benchmark] += (contribution.amount * ending.close) / purchase.close;
    }
  }
  const selectedBenchmark = values.nasdaq > values.sp500 ? 'nasdaq' : 'sp500';
  if (
    !Number.isFinite(values[selectedBenchmark]) ||
    investmentMoney(values[selectedBenchmark] - contributed) <= 0
  )
    return;
  return {
    modelVersion: INVESTMENT_MODEL_VERSION,
    snapshotId: snapshot.id,
    valuationDate: snapshot.valuationDate,
    currencyCode,
    contributionCount: included.length,
    contributed: investmentMoney(contributed),
    selectedBenchmark,
    outcomes: {
      sp500: {
        value: investmentMoney(values.sp500),
        gain: investmentMoney(values.sp500 - contributed),
      },
      nasdaq: {
        value: investmentMoney(values.nasdaq),
        gain: investmentMoney(values.nasdaq - contributed),
      },
    },
  };
}
