/**
 * Cache Service
 *
 * High-level caching operations for user data
 * Wraps Redis with domain-specific logic
 */

import { redisCacheStore } from '../../config/redis';
import logger from '../../config/logger';
import type { DashboardInsightEdition } from '../analytics/dashboard';
import type { RedisLifecycleSnapshot } from '../../config/redis';
import {
  CacheCodec,
  dashboardInsightEditionCacheCodec,
  UserSummaryProjection,
  userSummaryCacheCodec,
} from './cacheProjections';

export type { UserSummaryProjection } from './cacheProjections';

export interface CacheStats {
  enabled: boolean;
  stats: { keys: number; memory: string } | null;
  redis: RedisLifecycleSnapshot;
}

export class CacheService {
  private readonly USER_SUMMARY_PREFIX = 'user_summary:';
  private readonly ANALYTICS_PREFIX = 'analytics:';
  private readonly DASHBOARD_INSIGHTS_PREFIX = 'dashboard_insights:';

  // TTL constants (in seconds)
  private readonly USER_SUMMARY_TTL = 300; // 5 minutes
  private readonly ANALYTICS_TTL = 300; // 5 minutes (for Wrapped analytics)

  async cacheDashboardInsightEdition(
    cacheKey: string,
    edition: DashboardInsightEdition,
    ttlSeconds: number,
  ): Promise<void> {
    await redisCacheStore.set(
      `${this.DASHBOARD_INSIGHTS_PREFIX}${cacheKey}`,
      dashboardInsightEditionCacheCodec.encode(edition),
      Math.max(60, Math.ceil(ttlSeconds)),
    );
  }

  async getDashboardInsightEdition(cacheKey: string): Promise<DashboardInsightEdition | null> {
    return this.readProjection(
      `${this.DASHBOARD_INSIGHTS_PREFIX}${cacheKey}`,
      dashboardInsightEditionCacheCodec,
    );
  }

  /**
   * Cache user summary
   */
  async cacheUserSummary(userId: string, summary: UserSummaryProjection): Promise<void> {
    const key = `${this.USER_SUMMARY_PREFIX}${userId}`;
    const value = userSummaryCacheCodec.encode(summary);

    const cached = await redisCacheStore.set(key, value, this.USER_SUMMARY_TTL);

    if (cached) logger.debug('User summary cached', { ttlSeconds: this.USER_SUMMARY_TTL });
  }

  /**
   * Get cached user summary
   */
  async getUserSummary(userId: string): Promise<UserSummaryProjection | null> {
    const key = `${this.USER_SUMMARY_PREFIX}${userId}`;
    return this.readProjection(key, userSummaryCacheCodec);
  }

  /**
   * Invalidate user summary cache (call after data changes)
   */
  async invalidateUserSummary(userId: string): Promise<void> {
    const key = `${this.USER_SUMMARY_PREFIX}${userId}`;
    const deleted = await redisCacheStore.del(key);

    if (deleted) logger.debug('User summary cache invalidated');
  }

  /**
   * Invalidate all caches for a user
   * This includes both regular and wrapped analytics cache keys
   */
  async invalidateAllUserCaches(userId: string): Promise<void> {
    // Use patterns to match both base cache and wrapped cache keys
    // user_summary:userId* matches: user_summary:userId and user_summary:userId-wrapped
    const patterns = [
      `${this.USER_SUMMARY_PREFIX}${userId}*`, // Pattern to catch both base and -wrapped keys
      `${this.ANALYTICS_PREFIX}${userId}*`,
      `${this.DASHBOARD_INSIGHTS_PREFIX}${userId}*`,
    ];

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await redisCacheStore.delPattern(pattern);
      totalDeleted += deleted;
    }

    if (totalDeleted > 0) logger.debug('User cache entries invalidated', { count: totalDeleted });
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const stats = await redisCacheStore.getStats();
    return { enabled: redisCacheStore.isAvailable(), stats, redis: redisCacheStore.snapshot() };
  }

  /**
   * Check if caching is available
   */
  isAvailable(): boolean {
    return redisCacheStore.isAvailable();
  }

  private async readProjection<Value>(
    key: string,
    codec: CacheCodec<Value>,
  ): Promise<Value | null> {
    const cached = await redisCacheStore.get(key);
    if (!cached) return null;

    const value = codec.decode(cached);
    if (value !== null) return value;

    await redisCacheStore.del(key);
    logger.warn('Invalid cached projection evicted');
    return null;
  }
}
