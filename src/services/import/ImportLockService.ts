import { randomUUID } from 'crypto';
import { logger } from '../../config/logger';
import { redisLockStore } from '../../config/redis';
import { AppError } from '../../core/errors';

export type ImportLockBackend = 'redis' | 'memory';

export interface ImportLockHandle {
  readonly userId: string;
  readonly ownerToken: string;
  readonly backend: ImportLockBackend;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

interface InMemoryLock {
  ownerToken: string;
  expiresAt: number;
}

interface RenewalState {
  timer: NodeJS.Timeout;
  lostOwnership: boolean;
}

export class ImportLockOwnershipLostError extends Error {
  readonly code = 'LOCK_OWNERSHIP_LOST';

  constructor() {
    super('The user receipt writer lock lease was lost.');
    this.name = 'ImportLockOwnershipLostError';
  }
}

/** Coordinates every receipt/import-lifecycle writer for one user. */
export class ImportLockService {
  private static readonly LOCK_PREFIX = 'import_lock:';
  private static readonly LOCK_TTL_SECONDS = 600;
  private static readonly RENEWAL_INTERVAL_MS = 200000;
  private static readonly inMemoryLocks = new Map<string, InMemoryLock>();
  private static readonly renewalStates = new Map<string, RenewalState>();

  static async acquireLock(userId: string): Promise<ImportLockHandle | null> {
    const ownerToken = randomUUID();
    const acquiredAt = Date.now();
    const expiresAt = acquiredAt + this.LOCK_TTL_SECONDS * 1000;
    const lockKey = this.lockKey(userId);

    if (redisLockStore.isAvailable()) {
      const acquired = await redisLockStore.setNX(lockKey, ownerToken, this.LOCK_TTL_SECONDS);
      if (!acquired) return null;

      logger.info('User receipt writer lock acquired', { userId, backend: 'redis' });
      const handle = { userId, ownerToken, backend: 'redis' as const, acquiredAt, expiresAt };
      this.startRenewal(handle);
      return handle;
    }

    // Production must fail closed when Redis was configured but is unavailable.
    // The fallback coordinates only this Node process and is safe solely for a
    // deliberately Redis-free deployment or local/test execution.
    if (redisLockStore.isEnabled()) {
      logger.error('User receipt writer lock unavailable', {
        userId,
        backend: 'redis',
        errorCode: 'LOCK_BACKEND_UNAVAILABLE',
      });
      throw new AppError({
        code: 'LOCK_BACKEND_UNAVAILABLE',
        message: 'The distributed receipt-writer lock is unavailable.',
        publicMessage: 'Imports are temporarily delayed. Please try again shortly.',
      });
    }

    this.cleanupExpiredInMemoryLocks();
    const existing = this.inMemoryLocks.get(userId);
    if (existing && existing.expiresAt > acquiredAt) return null;

    this.inMemoryLocks.set(userId, { ownerToken, expiresAt });
    logger.warn('User receipt writer lock acquired with single-process fallback', {
      userId,
      backend: 'memory',
    });
    const handle = { userId, ownerToken, backend: 'memory' as const, acquiredAt, expiresAt };
    this.startRenewal(handle);
    return handle;
  }

  static async acquireLockWithWait(
    userId: string,
    timeoutMs = 300000,
    pollIntervalMs = 250,
    signal?: AbortSignal,
  ): Promise<ImportLockHandle | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);

    do {
      if (signal?.aborted) return null;
      const handle = await this.acquireLock(userId);
      if (handle) return handle;
      if (Date.now() >= deadline) return null;
      if (!(await this.waitForRetry(pollIntervalMs, signal))) return null;
    } while (Date.now() < deadline);

    return null;
  }

  static async renewLock(handle: ImportLockHandle): Promise<boolean> {
    if (handle.backend === 'redis') {
      return redisLockStore.expireIfValueMatches(
        this.lockKey(handle.userId),
        handle.ownerToken,
        this.LOCK_TTL_SECONDS,
      );
    }

    const current = this.inMemoryLocks.get(handle.userId);
    if (!current || current.ownerToken !== handle.ownerToken) return false;
    current.expiresAt = Date.now() + this.LOCK_TTL_SECONDS * 1000;
    return true;
  }

  static async assertLockOwned(handle: ImportLockHandle): Promise<void> {
    const state = this.renewalStates.get(handle.ownerToken);
    if (!state || state.lostOwnership || !(await this.renewLock(handle))) {
      if (state) state.lostOwnership = true;
      throw new ImportLockOwnershipLostError();
    }
  }

  static async releaseLock(handle: ImportLockHandle): Promise<boolean> {
    this.stopRenewal(handle.ownerToken);
    let released = false;
    if (handle.backend === 'redis') {
      released = await redisLockStore.deleteIfValueMatches(
        this.lockKey(handle.userId),
        handle.ownerToken,
      );
    } else {
      const current = this.inMemoryLocks.get(handle.userId);
      if (current?.ownerToken === handle.ownerToken) {
        released = this.inMemoryLocks.delete(handle.userId);
      }
    }

    logger.info('User receipt writer lock release attempted', {
      userId: handle.userId,
      backend: handle.backend,
      outcome: released ? 'released' : 'ownership_lost',
    });
    return released;
  }

  static async isLocked(userId: string): Promise<boolean> {
    if (redisLockStore.isAvailable()) {
      return redisLockStore.exists(this.lockKey(userId));
    }
    if (redisLockStore.isEnabled()) {
      throw new AppError({
        code: 'LOCK_BACKEND_UNAVAILABLE',
        message: 'The distributed receipt-writer lock is unavailable.',
        publicMessage: 'Import status is temporarily unavailable. Please try again.',
      });
    }
    return this.isInMemoryLocked(userId);
  }

  static getInMemoryLockCount(): number {
    this.cleanupExpiredInMemoryLocks();
    return this.inMemoryLocks.size;
  }

  private static lockKey(userId: string): string {
    return `${this.LOCK_PREFIX}${userId}`;
  }

  private static isInMemoryLocked(userId: string): boolean {
    const existing = this.inMemoryLocks.get(userId);
    if (!existing) return false;
    if (existing.expiresAt <= Date.now()) {
      this.inMemoryLocks.delete(userId);
      return false;
    }
    return true;
  }

  private static cleanupExpiredInMemoryLocks(): void {
    const now = Date.now();
    for (const [userId, lock] of this.inMemoryLocks.entries()) {
      if (lock.expiresAt <= now) this.inMemoryLocks.delete(userId);
    }
  }

  private static waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (shouldRetry: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(shouldRetry);
      };
      const abort = (): void => finish(false);
      const timer = setTimeout(() => finish(true), Math.max(0, delayMs));
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private static startRenewal(handle: ImportLockHandle): void {
    const state: RenewalState = {
      lostOwnership: false,
      timer: setInterval(() => {
        void this.renewLock(handle).then((renewed) => {
          if (renewed) return;
          state.lostOwnership = true;
          clearInterval(state.timer);
          logger.error('User receipt writer lock lease lost', {
            userId: handle.userId,
            backend: handle.backend,
            errorCode: 'LOCK_OWNERSHIP_LOST',
          });
        });
      }, this.RENEWAL_INTERVAL_MS),
    };
    state.timer.unref();
    this.renewalStates.set(handle.ownerToken, state);
  }

  private static stopRenewal(ownerToken: string): void {
    const state = this.renewalStates.get(ownerToken);
    if (state) clearInterval(state.timer);
    this.renewalStates.delete(ownerToken);
  }
}
