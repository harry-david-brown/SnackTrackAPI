/**
 * Cache Service
 * 
 * High-level caching operations for user data
 * Wraps Redis with domain-specific logic
 */

import { redisConfig } from '../../config/redis';

export class CacheService {
  private readonly USER_SUMMARY_PREFIX = 'user_summary:';
  private readonly ANALYTICS_PREFIX = 'analytics:';
  
  // TTL constants (in seconds)
  private readonly USER_SUMMARY_TTL = 300; // 5 minutes
  private readonly ANALYTICS_TTL = 300; // 5 minutes (for Wrapped analytics)

  /**
   * Cache user summary
   */
  async cacheUserSummary(userId: string, summary: any): Promise<void> {
    const key = `${this.USER_SUMMARY_PREFIX}${userId}`;
    const value = JSON.stringify(summary);
    
    const cached = await redisConfig.set(key, value, this.USER_SUMMARY_TTL);
    
    if (cached) {
      console.log(`✅ Cached user summary for ${userId} (TTL: ${this.USER_SUMMARY_TTL}s)`);
    }
  }

  /**
   * Get cached user summary
   */
  async getUserSummary(userId: string): Promise<any | null> {
    const key = `${this.USER_SUMMARY_PREFIX}${userId}`;
    const cached = await redisConfig.get(key);
    
    if (cached) {
      console.log(`✅ Cache HIT for user summary: ${userId}`);
      return JSON.parse(cached);
    }
    
    console.log(`❌ Cache MISS for user summary: ${userId}`);
    return null;
  }

  /**
   * Invalidate user summary cache (call after data changes)
   */
  async invalidateUserSummary(userId: string): Promise<void> {
    const key = `${this.USER_SUMMARY_PREFIX}${userId}`;
    const deleted = await redisConfig.del(key);
    
    if (deleted) {
      console.log(`🗑️  Invalidated cache for user: ${userId}`);
    }
  }

  /**
   * Invalidate all caches for a user
   */
  async invalidateAllUserCaches(userId: string): Promise<void> {
    const patterns = [
      `${this.USER_SUMMARY_PREFIX}${userId}`,
      `${this.ANALYTICS_PREFIX}${userId}*`
    ];

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await redisConfig.delPattern(pattern);
      totalDeleted += deleted;
    }

    if (totalDeleted > 0) {
      console.log(`🗑️  Invalidated ${totalDeleted} cache entries for user: ${userId}`);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ enabled: boolean; stats: any }> {
    if (!redisConfig.isAvailable()) {
      return { enabled: false, stats: null };
    }

    const stats = await redisConfig.getStats();
    return { enabled: true, stats };
  }

  /**
   * Check if caching is available
   */
  isAvailable(): boolean {
    return redisConfig.isAvailable();
  }
}

// Export singleton instance
export const cacheService = new CacheService();

