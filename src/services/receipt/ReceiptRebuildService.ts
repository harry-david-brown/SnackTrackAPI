import type { UserCacheInvalidationPort } from '../ports/ReceiptPorts';
import type { ReceiptWriterLockPort } from '../ports/ImportPorts';
import type { ImportLockHandle } from '../import/ImportLockService';
import { ConflictError } from '../../core/errors';
import type { ReceiptReviewChange } from './ReceiptReviewDecisions';
export interface ReceiptRebuildPort {
  rebuildProjection(
    userId: string,
    generation: number,
    mode: 'prepare' | 'publish' | 'rollback',
    assertWriteAllowed: () => Promise<void>,
    manifestId?: string,
    stagedBatchIds?: readonly string[],
    reviewChanges?: readonly ReceiptReviewChange[],
  ): Promise<{ orders: number; changed: number; legacy: number; mode: string }>;
}
/** Worker holds the shared writer lock; SQL checks the durable job's generation again. */
export class ReceiptRebuildService {
  constructor(
    private readonly repository: ReceiptRebuildPort,
    private readonly cache: UserCacheInvalidationPort,
    private readonly locks: Pick<ReceiptWriterLockPort, 'assertLockOwned'>,
  ) {}
  async executeWithLock(
    userId: string,
    generation: number,
    mode: 'prepare' | 'publish' | 'rollback',
    lock: ImportLockHandle,
    manifestId?: string,
    stagedBatchIds: readonly string[] = [],
    reviewChanges: readonly ReceiptReviewChange[] = [],
  ) {
    if (lock.userId !== userId)
      throw new ConflictError(
        'REPAIR_LOCK_SCOPE_MISMATCH',
        'The repair writer lock belongs to a different account',
      );
    if (mode !== 'prepare' && !manifestId)
      throw new Error('Publication and rollback require an explicit repair manifest');
    const result = await this.repository.rebuildProjection(
      userId,
      generation,
      mode,
      () => this.locks.assertLockOwned(lock),
      manifestId,
      stagedBatchIds,
      reviewChanges,
    );
    if (mode !== 'prepare') await this.cache.invalidateAllUserCaches(userId);
    return result;
  }
}
