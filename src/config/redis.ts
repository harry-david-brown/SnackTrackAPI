/**
 * Redis Configuration
 *
 * Manages Redis connection for caching
 * Optional in development, recommended for production
 */

import { createClient, RedisClientType } from 'redis';
import { config as appConfig } from './AppConfig';
import logger from './logger';

interface RedisConfig {
  url: string;
  password?: string;
  enabled: boolean;
  defaultTTL: number;
}

class RedisConfigManager {
  private config: RedisConfig;
  private client: RedisClientType | null = null;
  private connecting: boolean = false;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): RedisConfig {
    const redis = appConfig.getRedisConfig();

    return {
      url: redis.url,
      password: redis.password,
      enabled: redis.enabled,
      defaultTTL: redis.defaultTTLSeconds,
    };
  }

  /**
   * Initialize Redis connection
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Redis caching disabled');
      return;
    }

    if (this.client || this.connecting) {
      return; // Already initialized or connecting
    }

    this.connecting = true;

    try {
      this.client = createClient({
        url: this.config.url,
        password: this.config.password,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error('Redis connection retry limit reached', { retries });
              return new Error('Redis connection failed');
            }
            return Math.min(retries * 100, 3000); // Exponential backoff, max 3s
          },
        },
      });

      this.client.on('error', (err: unknown) => {
        logger.error('Redis client error', { error: err });
      });

      this.client.on('connect', () => {
        logger.info('Redis connected');
      });

      this.client.on('reconnecting', () => {
        logger.warn('Redis reconnecting');
      });

      await this.client.connect();

      // Test connection
      await this.client.ping();

      logger.info('Redis cache initialized', { defaultTtlSeconds: this.config.defaultTTL });
    } catch (error) {
      logger.error('Failed to connect to Redis; caching unavailable', { error });
      if (this.client?.isOpen) {
        await this.client.disconnect();
      }
      this.client = null;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Get Redis client (returns null if not connected)
   */
  getClient(): RedisClientType | null {
    return this.client;
  }

  /**
   * Check if Redis is available
   */
  isAvailable(): boolean {
    return this.client !== null && this.client.isOpen;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get a cached value
   */
  async get(key: string): Promise<string | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      return await this.client!.get(key);
    } catch (error) {
      logger.error('Redis get failed', { error });
      return null;
    }
  }

  /**
   * Set a cached value with TTL
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const ttl = ttlSeconds || this.config.defaultTTL;
      await this.client!.setEx(key, ttl, value);
      return true;
    } catch (error) {
      logger.error('Redis set failed', { error });
      return false;
    }
  }

  /**
   * Delete a cached value
   */
  async del(key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.client!.del(key);
      return true;
    } catch (error) {
      logger.error('Redis delete failed', { error });
      return false;
    }
  }

  /**
   * Set a value only if it doesn't exist (for distributed locking)
   * Returns true if the lock was acquired, false if already locked
   */
  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.isAvailable()) {
      // If Redis is not available, use in-memory fallback (see ImportLockService)
      return false;
    }

    try {
      // SET key value NX EX ttl - sets only if key doesn't exist, with expiry
      const result = await this.client!.set(key, value, {
        NX: true,
        EX: ttlSeconds,
      });
      return result === 'OK';
    } catch (error) {
      logger.error('Redis conditional set failed', { error });
      return false;
    }
  }

  /** Delete a distributed lock only when the caller still owns it. */
  async deleteIfValueMatches(key: string, expectedValue: string): Promise<boolean> {
    if (!this.isAvailable()) return false;

    try {
      const result = await this.client!.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then
           return redis.call('del', KEYS[1])
         end
         return 0`,
        { keys: [key], arguments: [expectedValue] },
      );
      return Number(result) === 1;
    } catch (error) {
      logger.error('Redis compare-and-delete failed', { error });
      return false;
    }
  }

  /** Extend a distributed lock lease only when the caller still owns it. */
  async expireIfValueMatches(
    key: string,
    expectedValue: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (!this.isAvailable()) return false;

    try {
      const result = await this.client!.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then
           return redis.call('expire', KEYS[1], ARGV[2])
         end
         return 0`,
        { keys: [key], arguments: [expectedValue, String(ttlSeconds)] },
      );
      return Number(result) === 1;
    } catch (error) {
      logger.error('Redis compare-and-expire failed', { error });
      return false;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const count = await this.client!.exists(key);
      return count > 0;
    } catch (error) {
      logger.error('Redis exists check failed', { error });
      return false;
    }
  }

  /**
   * Delete multiple keys by pattern
   */
  async delPattern(pattern: string): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      let deleted = 0;
      for await (const keys of this.client!.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (keys.length === 0) continue;
        deleted += await this.client!.del(keys);
      }
      return deleted;
    } catch (error) {
      logger.error('Redis pattern delete failed', { error });
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ keys: number; memory: string } | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const info = await this.client!.info('stats');
      const keys = await this.client!.dbSize();
      return {
        keys,
        memory: this.parseMemoryUsage(info),
      };
    } catch (error) {
      logger.error('Redis stats read failed', { error });
      return null;
    }
  }

  private parseMemoryUsage(info: string): string {
    const match = info.match(/used_memory_human:([^\r\n]+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    if (this.client && this.client.isOpen) {
      logger.info('Closing Redis connection');
      await this.client.quit();
      logger.info('Redis connection closed');
    }
  }
}

// Export singleton instance
export const redisConfig = new RedisConfigManager();
