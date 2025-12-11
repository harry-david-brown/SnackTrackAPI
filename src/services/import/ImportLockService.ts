/**
 * Import Lock Service
 * 
 * Prevents concurrent import operations for the same user.
 * Uses Redis for distributed locking (works across multiple servers).
 * Falls back to in-memory locking if Redis is unavailable.
 * 
 * Features:
 * - Distributed lock via Redis SETNX
 * - Automatic lock expiry (prevents deadlocks if server crashes)
 * - In-memory fallback for single-server deployments
 */

import { redisConfig } from '../../config/redis';

export class ImportLockService {
  private static readonly LOCK_PREFIX = 'import_lock:';
  private static readonly LOCK_TTL_SECONDS = 600; // 10 minutes max import time
  
  // In-memory fallback for when Redis is unavailable
  private static inMemoryLocks = new Map<string, { expiresAt: number }>();

  /**
   * Try to acquire an import lock for a user
   * Returns true if lock acquired, false if already locked
   */
  static async acquireLock(userId: string): Promise<boolean> {
    const lockKey = `${this.LOCK_PREFIX}${userId}`;
    const lockValue = `${Date.now()}`; // Timestamp as lock value for debugging

    // Try Redis first
    if (redisConfig.isAvailable()) {
      const acquired = await redisConfig.setNX(lockKey, lockValue, this.LOCK_TTL_SECONDS);
      if (acquired) {
        console.log(`🔒 Acquired import lock for user ${userId} (Redis)`);
      } else {
        console.log(`⚠️  Import already in progress for user ${userId} (Redis lock exists)`);
      }
      return acquired;
    }

    // Fallback to in-memory locking
    return this.acquireInMemoryLock(userId);
  }

  /**
   * Release an import lock for a user
   */
  static async releaseLock(userId: string): Promise<void> {
    const lockKey = `${this.LOCK_PREFIX}${userId}`;

    // Release from Redis
    if (redisConfig.isAvailable()) {
      await redisConfig.del(lockKey);
      console.log(`🔓 Released import lock for user ${userId} (Redis)`);
    }

    // Also release from in-memory (in case Redis became unavailable mid-import)
    this.releaseInMemoryLock(userId);
  }

  /**
   * Check if a user has an active import lock
   */
  static async isLocked(userId: string): Promise<boolean> {
    const lockKey = `${this.LOCK_PREFIX}${userId}`;

    // Check Redis first
    if (redisConfig.isAvailable()) {
      return await redisConfig.exists(lockKey);
    }

    // Fallback to in-memory check
    return this.isInMemoryLocked(userId);
  }

  /**
   * In-memory lock acquisition (fallback)
   */
  private static acquireInMemoryLock(userId: string): boolean {
    // Clean up expired locks first
    this.cleanupExpiredInMemoryLocks();

    const existing = this.inMemoryLocks.get(userId);
    if (existing && existing.expiresAt > Date.now()) {
      console.log(`⚠️  Import already in progress for user ${userId} (in-memory lock exists)`);
      return false;
    }

    // Acquire the lock
    this.inMemoryLocks.set(userId, {
      expiresAt: Date.now() + (this.LOCK_TTL_SECONDS * 1000)
    });
    console.log(`🔒 Acquired import lock for user ${userId} (in-memory)`);
    return true;
  }

  /**
   * In-memory lock release (fallback)
   */
  private static releaseInMemoryLock(userId: string): void {
    if (this.inMemoryLocks.has(userId)) {
      this.inMemoryLocks.delete(userId);
      console.log(`🔓 Released import lock for user ${userId} (in-memory)`);
    }
  }

  /**
   * Check if user has in-memory lock
   */
  private static isInMemoryLocked(userId: string): boolean {
    const existing = this.inMemoryLocks.get(userId);
    if (!existing) return false;
    
    // Check if expired
    if (existing.expiresAt <= Date.now()) {
      this.inMemoryLocks.delete(userId);
      return false;
    }
    
    return true;
  }

  /**
   * Clean up expired in-memory locks
   */
  private static cleanupExpiredInMemoryLocks(): void {
    const now = Date.now();
    for (const [userId, lock] of this.inMemoryLocks.entries()) {
      if (lock.expiresAt <= now) {
        this.inMemoryLocks.delete(userId);
      }
    }
  }

  /**
   * Get current lock count (for monitoring/debugging)
   */
  static getInMemoryLockCount(): number {
    this.cleanupExpiredInMemoryLocks();
    return this.inMemoryLocks.size;
  }
}

