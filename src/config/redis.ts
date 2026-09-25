import { createClient, type RedisClientType } from 'redis';
import { config as appConfig } from './AppConfig';
import logger from './logger';
import { AppError } from '../core/errors';
import type { AuthAbuseBudgetPort } from '../services/ports/AuthAbuseBudgetPort';

export type RedisLifecycleState = 'connecting' | 'ready' | 'recovering' | 'unavailable' | 'closed';
export interface RedisLifecycleSnapshot {
  readonly enabled: boolean;
  readonly state: RedisLifecycleState;
  readonly reconnectCount: number;
  readonly outageStartedAt: string | null;
  readonly readyAt: string | null;
}
type StateListener = (snapshot: RedisLifecycleSnapshot) => void;
const PROJECTION_CACHE_PATTERNS = ['user_summary:*', 'analytics:*', 'dashboard_insights:*'] as const;

/** Owns the process-wide Redis connection and its recovery lifecycle. */
class RedisConnectionManager {
  private readonly settings = appConfig.getRedisConfig();
  private client: RedisClientType | null = null;
  private state: RedisLifecycleState = 'closed';
  private reconnectCount = 0;
  private outageStartedAt: Date | null = null;
  private readyAt: Date | null = null;
  private initializationStarted = false;
  private closing = false;
  private recovery: Promise<void> | null = null;
  private readonly listeners = new Set<StateListener>();
  private readonly readyWaiters = new Set<() => void>();

  initialize(): Promise<void> {
    if (!this.settings.enabled || this.initializationStarted || this.closing) return Promise.resolve();
    this.initializationStarted = true;
    this.transition('connecting');
    this.client = createClient({
      url: this.settings.url,
      password: this.settings.password,
      socket: {
        reconnectStrategy: (retries) => {
          const base = Math.min(30_000, 250 * 2 ** Math.min(retries, 7));
          return Math.max(250, Math.round(base * (0.8 + Math.random() * 0.4)));
        },
      },
    });
    this.client.on('error', (error: unknown) => {
      if (this.closing) return;
      this.markUnavailable();
      logger.warn('Redis unavailable', { operation: 'redis_connection', state: this.state, error: error instanceof Error ? error.message : String(error) });
    });
    this.client.on('reconnecting', () => {
      if (this.closing) return;
      this.reconnectCount += 1;
      this.transition('recovering');
    });
    this.client.on('ready', () => void this.recoverProjectionCaches());
    this.client.on('end', () => { if (!this.closing) this.markUnavailable(); });
    void this.client.connect().catch((error: unknown) => {
      if (this.closing) return;
      this.markUnavailable();
      logger.error('Redis connection loop stopped unexpectedly', { operation: 'redis_connection', error: error instanceof Error ? error.message : String(error) });
    });
    return Promise.resolve();
  }

  private async recoverProjectionCaches(): Promise<void> {
    if (this.recovery || this.closing || !this.client?.isReady) return this.recovery ?? Promise.resolve();
    this.transition('recovering');
    this.recovery = (async () => {
      let deleted = 0;
      try {
        for (const pattern of PROJECTION_CACHE_PATTERNS) {
          for await (const keys of this.client!.scanIterator({ MATCH: pattern, COUNT: 100 })) {
            if (keys.length > 0) deleted += await this.client!.del(keys);
          }
        }
        this.outageStartedAt = null;
        this.readyAt = new Date();
        this.transition('ready');
        for (const resolve of this.readyWaiters) resolve();
        this.readyWaiters.clear();
        logger.info('Redis ready after projection-cache reconciliation', { operation: 'redis_recovery', reconnectCount: this.reconnectCount, deletedProjectionKeys: deleted });
      } catch (error) {
        this.markUnavailable();
        logger.warn('Redis cache reconciliation failed', { operation: 'redis_recovery', error: error instanceof Error ? error.message : String(error) });
        const retry = setTimeout(() => void this.recoverProjectionCaches(), 1_000);
        retry.unref();
      } finally {
        this.recovery = null;
      }
    })();
    return this.recovery;
  }

  snapshot(): RedisLifecycleSnapshot {
    return { enabled: this.settings.enabled, state: this.settings.enabled ? this.state : 'closed', reconnectCount: this.reconnectCount, outageStartedAt: this.outageStartedAt?.toISOString() ?? null, readyAt: this.readyAt?.toISOString() ?? null };
  }
  isEnabled(): boolean { return this.settings.enabled; }
  isReady(): boolean { return Boolean(this.client?.isReady && this.state === 'ready'); }
  getDefaultTtlSeconds(): number { return this.settings.defaultTTLSeconds; }
  rawReadyClient(): RedisClientType | null { return this.isReady() ? this.client : null; }
  requireReady(code: 'LOCK_BACKEND_UNAVAILABLE' | 'SESSION_STORE_UNAVAILABLE'): RedisClientType {
    const client = this.rawReadyClient();
    if (client) return client;
    throw new AppError({ code, message: code === 'LOCK_BACKEND_UNAVAILABLE' ? 'The distributed lock service is unavailable.' : 'The session store is unavailable.', publicMessage: 'This service is temporarily unavailable. Please try again.' });
  }
  onStateChange(listener: StateListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  waitUntilReady(): Promise<void> {
    if (!this.settings.enabled || this.isReady()) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.add(resolve));
  }
  private markUnavailable(): void { if (!this.outageStartedAt) this.outageStartedAt = new Date(); this.transition('unavailable'); }
  private transition(next: RedisLifecycleState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    const snapshot = this.snapshot();
    logger.info('Redis lifecycle transition', { operation: 'redis_connection', previousState: previous, state: next, reconnectCount: snapshot.reconnectCount });
    for (const listener of this.listeners) listener(snapshot);
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.transition('closed');
    this.readyWaiters.clear();
    const client = this.client;
    this.client = null;
    if (client?.isReady) {
      try {
        await client.quit();
      } catch {
        await client.disconnect();
      }
    } else if (client?.isOpen) {
      await client.disconnect();
    }
  }
}

export class RedisCacheStore {
  constructor(private readonly connection: RedisConnectionManager) {}
  isAvailable(): boolean { return this.connection.isReady(); }
  isEnabled(): boolean { return this.connection.isEnabled(); }
  snapshot(): RedisLifecycleSnapshot { return this.connection.snapshot(); }
  async get(key: string): Promise<string | null> { const client = this.connection.rawReadyClient(); if (!client) return null; try { return await client.get(key); } catch (error) { logger.warn('Redis cache read failed', { operation: 'cache_get', error }); return null; } }
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> { const client = this.connection.rawReadyClient(); if (!client) return false; try { await client.setEx(key, ttlSeconds ?? this.connection.getDefaultTtlSeconds(), value); return true; } catch (error) { logger.warn('Redis cache write failed', { operation: 'cache_set', error }); return false; } }
  async del(key: string): Promise<boolean> { const client = this.connection.rawReadyClient(); if (!client) return false; try { return (await client.del(key)) > 0; } catch (error) { logger.warn('Redis cache delete failed', { operation: 'cache_delete', error }); return false; } }
  async delPattern(pattern: string): Promise<number> { const client = this.connection.rawReadyClient(); if (!client) return 0; try { let deleted = 0; for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 100 })) { if (keys.length > 0) deleted += await client.del(keys); } return deleted; } catch (error) { logger.warn('Redis cache pattern delete failed', { operation: 'cache_delete_pattern', error }); return 0; } }
  async getStats(): Promise<{ keys: number; memory: string } | null> { const client = this.connection.rawReadyClient(); if (!client) return null; try { const [info, keys] = await Promise.all([client.info('memory'), client.dbSize()]); return { keys, memory: info.match(/used_memory_human:([^\r\n]+)/)?.[1] ?? 'unknown' }; } catch (error) { logger.warn('Redis cache stats failed', { operation: 'cache_stats', error }); return null; } }
}

export class RedisLockStore {
  constructor(private readonly connection: RedisConnectionManager) {}
  isAvailable(): boolean { return this.connection.isReady(); }
  isEnabled(): boolean { return this.connection.isEnabled(); }
  snapshot(): RedisLifecycleSnapshot { return this.connection.snapshot(); }
  onStateChange(listener: StateListener): () => void { return this.connection.onStateChange(listener); }
  waitUntilReady(): Promise<void> { return this.connection.waitUntilReady(); }
  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> { return (await this.connection.requireReady('LOCK_BACKEND_UNAVAILABLE').set(key, value, { NX: true, EX: ttlSeconds })) === 'OK'; }
  async exists(key: string): Promise<boolean> { return (await this.connection.requireReady('LOCK_BACKEND_UNAVAILABLE').exists(key)) > 0; }
  async deleteIfValueMatches(key: string, value: string): Promise<boolean> { return Number(await this.connection.requireReady('LOCK_BACKEND_UNAVAILABLE').eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", { keys: [key], arguments: [value] })) === 1; }
  async expireIfValueMatches(key: string, value: string, ttlSeconds: number): Promise<boolean> { return Number(await this.connection.requireReady('LOCK_BACKEND_UNAVAILABLE').eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end return 0", { keys: [key], arguments: [value, String(ttlSeconds)] })) === 1; }
}

export class RedisRefreshTokenStore {
  constructor(private readonly connection: RedisConnectionManager) {}
  isAvailable(): boolean { return this.connection.isReady(); }
  async exists(key: string): Promise<boolean> { return (await this.connection.requireReady('SESSION_STORE_UNAVAILABLE').exists(key)) > 0; }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> { await this.connection.requireReady('SESSION_STORE_UNAVAILABLE').setEx(key, ttlSeconds, value); }
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> { return (await this.connection.requireReady('SESSION_STORE_UNAVAILABLE').set(key, value, { NX: true, EX: ttlSeconds })) === 'OK'; }
}

export class RedisAuthAbuseBudgetStore implements AuthAbuseBudgetPort {
  constructor(private readonly connection: RedisConnectionManager) {}
  async consume(key: string, maximum: number, windowSeconds: number): Promise<number> {
    const client = this.connection.requireReady('SESSION_STORE_UNAVAILABLE');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.eval(`local count = redis.call('INCR', KEYS[1])
          local ttl = redis.call('TTL', KEYS[1])
          if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]); ttl = tonumber(ARGV[2]) end
          if count > tonumber(ARGV[1]) then return math.max(1, ttl) end
          return 0`, { keys: [key], arguments: [String(maximum), String(windowSeconds)] }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Auth budget unavailable')), 2000); }),
      ]);
      return Number(result);
    } finally { if (timeout) clearTimeout(timeout); }
  }
}

export const redisConfig = new RedisConnectionManager();
export const redisCacheStore = new RedisCacheStore(redisConfig);
export const redisLockStore = new RedisLockStore(redisConfig);
export const refreshTokenStore = new RedisRefreshTokenStore(redisConfig);
export const authAbuseBudgetStore = new RedisAuthAbuseBudgetStore(redisConfig);
