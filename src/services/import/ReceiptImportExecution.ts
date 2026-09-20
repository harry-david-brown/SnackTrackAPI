import { AppError } from '../../core/errors';
import type { ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';
import type { ReceiptImportAccounting, ReceiptImportScope } from './ReceiptImportOutcome';

/** Policy-3 import results require a durable ledger across pages, revisions and retries. */
export function receiptImportAccounting(
  policy: ReceiptPolicyVersion,
  jobId: string | undefined,
  scope: ReceiptImportScope,
): ReceiptImportAccounting | undefined {
  if (jobId !== undefined && (typeof jobId !== 'string' || !jobId.trim()))
    throw new AppError({
      code: 'IMPORT_CHECKPOINT_INVALID',
      message: 'Invalid import accounting identity',
    });
  if (policy === 3 && !jobId)
    throw new AppError({
      code: 'IMPORT_DURABLE_CONTEXT_REQUIRED',
      message: 'Receipt policy 3 requires durable import accounting',
      publicMessage:
        'Start this import through the app so its progress and order totals can be tracked safely.',
    });
  return jobId ? { jobId, scope } : undefined;
}
