import type { InvestmentContext } from '../shared/historicalInvestment';
import { DataSource, Receipt, ReceiptType } from '../../../models/Receipt';
import {
  getLocalDateKey,
  getLocalDateTimeParts,
  zonedDateTimeToUtc,
} from '../../../utils/timezone';
import { buildCandidateCatalogue, CandidateCatalogue } from './candidates';
import { buildDashboardDataset } from './normalization';
import { selectDailyInsights } from './selector';
import { DASHBOARD_INSIGHT_METRIC_VERSION, DashboardInsightEdition } from './types';

export function getNextLocalMidnight(now: Date, timezone: string): Date {
  const parts = getLocalDateTimeParts(now, timezone);
  if (!parts) return new Date(now.getTime() + 60 * 60 * 1000);
  const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return (
    zonedDateTimeToUtc(
      {
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth() + 1,
        day: tomorrow.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      timezone,
    ) ?? new Date(now.getTime() + 24 * 60 * 60 * 1000)
  );
}

export const MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET = 365;

/**
 * Move a development preview by local calendar days while preserving the
 * current wall-clock time. Calendar arithmetic avoids DST transitions turning
 * a requested "+1 day" preview into the wrong local date.
 */
export function getDashboardInsightPreviewNow(
  now: Date,
  timezone: string,
  dayOffset: number,
): Date {
  if (
    !Number.isInteger(dayOffset) ||
    dayOffset < 0 ||
    dayOffset > MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET
  ) {
    throw new RangeError(
      `dayOffset must be an integer from 0 to ${MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET}`,
    );
  }
  if (dayOffset === 0) return now;
  const parts = getLocalDateTimeParts(now, timezone);
  if (!parts) return new Date(now.getTime() + dayOffset * 86_400_000);
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return (
    zonedDateTimeToUtc(
      {
        year: target.getUTCFullYear(),
        month: target.getUTCMonth() + 1,
        day: target.getUTCDate(),
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
      },
      timezone,
    ) ?? new Date(now.getTime() + dayOffset * 86_400_000)
  );
}

export function buildDashboardInsightCatalogue(
  receipts: Receipt[],
  timezone: string,
  now: Date = new Date(),
  market?: InvestmentContext,
): CandidateCatalogue {
  return buildCandidateCatalogue(buildDashboardDataset(receipts, timezone, now), market);
}

export function buildDashboardInsightEdition(
  receipts: Receipt[],
  timezone: string,
  userId: string,
  now: Date = new Date(),
  market?: InvestmentContext,
): DashboardInsightEdition {
  const dataset = buildDashboardDataset(receipts, timezone, now);
  const catalogue = buildCandidateCatalogue(dataset, market);
  const localDate = getLocalDateKey(now, timezone) ?? now.toISOString().slice(0, 10);
  const exportProviders = new Set(
    receipts
      .filter((receipt) =>
        (receipt.resolution?.sources ?? [receipt.dataSource]).includes(DataSource.CSV),
      )
      .map((receipt) => receipt.receiptType)
      .filter(
        (provider): provider is ReceiptType.UBER_EATS | ReceiptType.DOORDASH =>
          provider === ReceiptType.UBER_EATS || provider === ReceiptType.DOORDASH,
      ),
  );
  const partialExportProvider = exportProviders.size === 1 ? [...exportProviders][0] : undefined;
  return {
    localDate,
    timezone,
    generatedAt: now.toISOString(),
    nextRefreshAt: getNextLocalMidnight(now, timezone).toISOString(),
    metricVersion: DASHBOARD_INSIGHT_METRIC_VERSION,
    availableCandidateCount: catalogue.eligible.length,
    partialExportProvider,
    insights: selectDailyInsights(
      catalogue.eligible,
      userId,
      localDate,
      DASHBOARD_INSIGHT_METRIC_VERSION,
      7,
    ),
  };
}
