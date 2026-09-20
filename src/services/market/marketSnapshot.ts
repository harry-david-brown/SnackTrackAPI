import {
  isMarketDate,
  type MarketPoint,
  type MarketSnapshot,
} from '../analytics/shared/historicalInvestment';
import { isMarketSession, marketSessions } from './marketCalendar';
export const MARKET_HISTORY_START = '1999-03-10';
export function validateSeries(value: unknown, end: string): MarketPoint[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Empty market history');
  const points: MarketPoint[] = value.map((v: unknown) => {
    if (
      !v ||
      typeof v !== 'object' ||
      !('date' in v) ||
      !isMarketDate(v.date) ||
      !('close' in v) ||
      typeof v.close !== 'number' ||
      !Number.isFinite(v.close) ||
      v.close <= 0
    )
      throw new Error('Invalid market observation');
    return { date: v.date, close: v.close };
  });
  const dates = marketSessions(MARKET_HISTORY_START, end);
  if (points.length !== dates.length || points.some((p, i) => p.date !== dates[i]))
    throw new Error('Incomplete market history');
  return points;
}
export function decodeMarketSnapshot(value: unknown): MarketSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid market snapshot');
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.id) ||
    v.provider !== 'finazon' ||
    v.adjustment !== 'all' ||
    !isMarketDate(v.valuationDate) ||
    !isMarketSession(v.valuationDate) ||
    typeof v.retrievedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.retrievedAt)) ||
    !v.series ||
    typeof v.series !== 'object'
  )
    throw new Error('Invalid market snapshot');
  const series = v.series as Record<string, unknown>;
  return {
    id: v.id,
    provider: 'finazon',
    adjustment: 'all',
    valuationDate: v.valuationDate,
    retrievedAt: v.retrievedAt,
    series: {
      sp500: validateSeries(series.sp500, v.valuationDate),
      nasdaq: validateSeries(series.nasdaq, v.valuationDate),
    },
  };
}
