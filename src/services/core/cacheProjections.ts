import type { DashboardInsightEdition } from '../analytics/dashboard';

export interface UserSummaryProjection {
  user: {
    id: string;
    email: string;
    dataSource: string;
  };
  statistics: {
    totalSpent: number;
    averageSpent: number;
    totalReceipts: number;
    dataSourceBreakdown: Record<string, number>;
    monthlyBreakdown: Record<string, { count: number; total: number }>;
    topRestaurants: Array<{ name: string; count: number; total: number }>;
  };
  validation: {
    issues: string[];
    zeroAmountReceipts: number;
    refundedReceipts: number;
  };
  recentReceipts: Array<{
    restaurantName?: string;
    amountSpent: number;
    orderDate?: Date | string;
    dataSource: string;
  }>;
  wrappedAnalytics?: unknown;
}

export interface CacheCodec<Value> {
  encode(value: Value): string;
  decode(serialized: string): Value | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number');

const isUserSummaryProjection = (value: unknown): value is UserSummaryProjection => {
  if (
    !isRecord(value) ||
    !isRecord(value.user) ||
    !isRecord(value.statistics) ||
    !isRecord(value.validation) ||
    !Array.isArray(value.recentReceipts)
  ) {
    return false;
  }

  const { user, statistics, validation, recentReceipts } = value;
  return (
    typeof user.id === 'string' &&
    typeof user.email === 'string' &&
    typeof user.dataSource === 'string' &&
    typeof statistics.totalSpent === 'number' &&
    typeof statistics.averageSpent === 'number' &&
    typeof statistics.totalReceipts === 'number' &&
    isNumberRecord(statistics.dataSourceBreakdown) &&
    isRecord(statistics.monthlyBreakdown) &&
    Object.values(statistics.monthlyBreakdown).every(
      (entry) =>
        isRecord(entry) && typeof entry.count === 'number' && typeof entry.total === 'number',
    ) &&
    Array.isArray(statistics.topRestaurants) &&
    statistics.topRestaurants.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.count === 'number' &&
        typeof entry.total === 'number',
    ) &&
    Array.isArray(validation.issues) &&
    validation.issues.every((issue) => typeof issue === 'string') &&
    typeof validation.zeroAmountReceipts === 'number' &&
    typeof validation.refundedReceipts === 'number' &&
    recentReceipts.every(
      (entry) =>
        isRecord(entry) &&
        (entry.restaurantName === undefined || typeof entry.restaurantName === 'string') &&
        typeof entry.amountSpent === 'number' &&
        (entry.orderDate === undefined || typeof entry.orderDate === 'string') &&
        typeof entry.dataSource === 'string',
    )
  );
};

const isDashboardInsightEdition = (value: unknown): value is DashboardInsightEdition => {
  if (!isRecord(value)) return false;

  return (
    typeof value.localDate === 'string' &&
    typeof value.timezone === 'string' &&
    typeof value.generatedAt === 'string' &&
    typeof value.nextRefreshAt === 'string' &&
    typeof value.metricVersion === 'string' &&
    typeof value.availableCandidateCount === 'number' &&
    (value.partialExportProvider === undefined ||
      value.partialExportProvider === 'uber_eats' ||
      value.partialExportProvider === 'doordash') &&
    Array.isArray(value.insights) &&
    value.insights.every(
      (insight) =>
        isRecord(insight) &&
        typeof insight.id === 'string' &&
        typeof insight.category === 'string' &&
        typeof insight.presentation === 'string' &&
        typeof insight.icon === 'string' &&
        typeof insight.eyebrow === 'string' &&
        typeof insight.title === 'string',
    )
  );
};

const jsonCodec = <Value>(validator: (value: unknown) => value is Value): CacheCodec<Value> => ({
  encode: (value) => JSON.stringify(value),
  decode: (serialized) => {
    try {
      const value: unknown = JSON.parse(serialized);
      return validator(value) ? value : null;
    } catch {
      return null;
    }
  },
});

export const userSummaryCacheCodec = jsonCodec(isUserSummaryProjection);
export const dashboardInsightEditionCacheCodec = jsonCodec(isDashboardInsightEdition);
