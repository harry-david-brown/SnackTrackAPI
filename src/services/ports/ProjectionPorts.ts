import type { User } from '../../models/User';
import type { DashboardInsightEdition } from '../analytics/dashboard';
import type { WrappedAnalytics } from '../analytics/WrappedAnalyticsTypes';
import type { UserSummaryProjection } from '../core/cacheProjections';

export interface UserProfilePort {
  findById(userId: string): Promise<User | undefined>;
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
  calculateWrappedAnalytics(userId: string): Promise<WrappedAnalytics>;
}
