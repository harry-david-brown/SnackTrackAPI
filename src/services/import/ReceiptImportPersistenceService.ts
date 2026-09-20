import type { Receipt } from '../../models/Receipt';
import type { ReceiptWritePort, UserCacheInvalidationPort, ReceiptImportOutcomePort } from '../ports/ReceiptPorts';
import type { ReceiptImportAccounting } from './ReceiptImportOutcome';
import type { ReceiptWriterLockPort } from '../ports/ImportPorts';
import type { ImportLockHandle } from './ImportLockService';
import { receiptImportAccounting } from './ReceiptImportExecution';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';

type ReceiptWriter = Pick<ReceiptWritePort, 'upsertEmailReceipts'>;
type CacheInvalidator = UserCacheInvalidationPort;

export interface ReceiptPersistenceResult {
  readonly unresolvedOrders?: number;
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
    private readonly outcomes?: ReceiptImportOutcomePort,
    private readonly receiptPolicy: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY,
  ) {}

  async persist(
    userId: string,
    receipts: readonly Receipt[],
    lock: ImportLockHandle,
    accounting?: ReceiptImportAccounting,
  ): Promise<ReceiptPersistenceResult> {
    receiptImportAccounting(this.receiptPolicy, accounting?.jobId, accounting?.scope ?? 'gmail');
    if (accounting && !this.outcomes) throw new Error('Canonical import outcome service is unavailable');
    if (!receipts.length) {
      return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0, totalReceiptsImported: 0 };
    }
    const result = await this.receipts.upsertEmailReceipts([...receipts], () =>
      this.locks.assertLockOwned(lock), accounting,
    );
    await this.cache.invalidateAllUserCaches(userId);
    return {
      ...result,
      totalReceiptsImported: result.newOrders + result.updatedOrders + result.unchangedOrders,
    };
  }

  async getOutcome(userId: string, lock: ImportLockHandle, accounting: ReceiptImportAccounting) {
    if (!this.outcomes) throw new Error('Canonical import outcome service is unavailable');
    return this.outcomes.getImportOutcome(userId, accounting.jobId, () => this.locks.assertLockOwned(lock), accounting.scope);
  }
}
