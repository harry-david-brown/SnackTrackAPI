/**
 * Redis Configuration
 * 
 * Manages Redis connection for caching
 * Optional in development, recommended for production
 */

import { createClient, RedisClientType } from 'redis';

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
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const password = process.env.REDIS_PASSWORD;
    const enabled = process.env.REDIS_ENABLED !== 'false'; // Enabled by default if URL is set

    return {
      url,
      password,
      enabled,
      defaultTTL: 300, // 5 minutes default cache
    };
  }

  /**
   * Initialize Redis connection
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      console.log('ℹ️  Redis caching disabled (set REDIS_URL to enable)');
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
              console.error('❌ Redis connection failed after 10 retries');
              return new Error('Redis connection failed');
            }
            return Math.min(retries * 100, 3000); // Exponential backoff, max 3s
          }
        }
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err);
      });

      this.client.on('connect', () => {
        console.log('✅ Redis connected');
      });

      this.client.on('reconnecting', () => {
        console.log('🔄 Redis reconnecting...');
      });

      await this.client.connect();
      
      // Test connection
      await this.client.ping();
      
      console.log(`✅ Redis cache initialized (${this.config.url})`);
      console.log(`   Default TTL: ${this.config.defaultTTL}s`);
      
    } catch (error) {
      console.error('❌ Failed to connect to Redis:', error);
      console.log('ℹ️  Continuing without caching (degraded performance)');
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
      console.error(`Redis GET error for key ${key}:`, error);
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
      console.error(`Redis SET error for key ${key}:`, error);
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
      console.error(`Redis DEL error for key ${key}:`, error);
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
      const keys = await this.client!.keys(pattern);
      if (keys.length === 0) {
        return 0;
      }
      await this.client!.del(keys);
      return keys.length;
    } catch (error) {
      console.error(`Redis DEL pattern error for ${pattern}:`, error);
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
        memory: this.parseMemoryUsage(info)
      };
    } catch (error) {
      console.error('Redis stats error:', error);
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
      console.log('🔌 Closing Redis connection...');
      await this.client.quit();
      console.log('✅ Redis connection closed');
    }
  }
}

// Export singleton instance
export const redisConfig = new RedisConfigManager();

