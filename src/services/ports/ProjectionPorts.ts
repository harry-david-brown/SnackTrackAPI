import type { Receipt } from '../../models/Receipt';
import type { DashboardInsightEdition } from '../analytics/dashboard';
import type { WrappedAnalytics } from '../analytics/WrappedAnalyticsTypes';
import type { UserSummaryProjection } from '../core/cacheProjections';

/** Internal projection inputs read atomically; the revision is never exposed in login/profile DTOs. */
export interface UserProjectionProfile {
  id: string;
  email: string;
  timezone: string;
  receiptProjectionRevision: string;
}

export interface UserProfilePort {
  findProjectionProfileById(userId: string): Promise<UserProjectionProfile | undefined>;
  updateTimezone(userId: string, timezone: string): Promise<void>;
}

export interface UserSummaryCachePort {
  getUserSummary(cacheKey: string): Promise<UserSummaryProjection | null>;
  cacheUserSummary(cacheKey: string, summary: UserSummaryProjection): Promise<void>;
  invalidateAllUserCaches(userId: string): Promise<void>;
}

export interface DashboardCachePort {
  getDashboardInsightEdition(cacheKey: string): Promise<DashboardInsightEdition | null>;
  cacheDashboardInsightEdition(
    cacheKey: string,
    edition: DashboardInsightEdition,
    ttlSeconds: number,
  ): Promise<void>;
  invalidateAllUserCaches(userId: string): Promise<void>;
}

export interface WrappedAnalyticsPort {
  calculateWrappedAnalytics(
    userId: string,
    snapshot?: WrappedReceiptSnapshot,
  ): Promise<WrappedAnalytics>;
}

export interface WrappedReceiptSnapshot {
  market?: import('../analytics/shared/historicalInvestment').InvestmentContext;
  displayCurrency?: import('./RecapExchangeRatesPort').RecapCurrency;
  rates?: import('./RecapExchangeRatesPort').RecapRateSnapshot;
  receipts: readonly Receipt[];
  timezone: string;
}
