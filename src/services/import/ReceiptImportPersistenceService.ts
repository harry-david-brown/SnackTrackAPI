import type { Receipt } from '../../models/Receipt';
import type { ReceiptWritePort, UserCacheInvalidationPort } from '../ports/ReceiptPorts';
import type { ReceiptWriterLockPort } from '../ports/ImportPorts';
import type { ImportLockHandle } from './ImportLockService';

type ReceiptWriter = Pick<ReceiptWritePort, 'upsertEmailReceipts'>;
type CacheInvalidator = UserCacheInvalidationPort;

export interface ReceiptPersistenceResult {
  readonly newOrders: number;
  readonly updatedOrders: number;
  readonly unchangedOrders: number;
  readonly totalReceiptsImported: number;
}

/** Owns the shared writer-policy assertion, receipt upsert, and post-commit cache boundary. */
export class ReceiptImportPersistenceService {
  constructor(
    private readonly receipts: ReceiptWriter,
    private readonly cache: CacheInvalidator,
    private readonly locks: Pick<ReceiptWriterLockPort, 'assertLockOwned'>,
  ) {}

  async persist(
    userId: string,
    receipts: readonly Receipt[],
    lock: ImportLockHandle,
  ): Promise<ReceiptPersistenceResult> {
    if (!receipts.length) {
      return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0, totalReceiptsImported: 0 };
    }
    const result = await this.receipts.upsertEmailReceipts([...receipts], () =>
      this.locks.assertLockOwned(lock),
    );
    await this.cache.invalidateAllUserCaches(userId);
    return {
      ...result,
      totalReceiptsImported: result.newOrders + result.updatedOrders + result.unchangedOrders,
    };
  }
}
