import type { User } from '../../models/User';
import type { Receipt } from '../../models/Receipt';
import { AppError } from '../../core/errors';
import type { StructuredLogger } from '../core/StructuredLogger';
import { silentStructuredLogger } from '../core/StructuredLogger';
import type { ImportLockHandle } from './ImportLockService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';
import type { GmailImportAcquisitionService } from './GmailImportAcquisitionService';
import type { GmailImportLifecycleService } from './GmailImportLifecycleService';
import type { ReceiptEmailBatchExtractor } from './ReceiptEmailBatchExtractor';
import { deduplicateReceipts } from './ReceiptDeduplicator';
import type { ReceiptImportPersistenceService } from './ReceiptImportPersistenceService';
import {
  restoreMailboxCheckpoint,
  saveMailboxCheckpoint,
  type MailboxImportState,
} from './MailboxImportCheckpoint';

export { resolveIncrementalGmailSearchAfter } from './GmailImportAcquisitionService';
export type { ExportCutoffsByReceiptType } from './GmailImportAcquisitionService';
import type { ExportCutoffsByReceiptType } from './GmailImportAcquisitionService';

const MAX_IMPORT_MESSAGES = 20_000;
const MAX_IMPORT_PAGES = 1_000;
const HISTORICAL_BYTE_BUDGET = 500 * 1024 * 1024;
const TRACKING_BYTE_BUDGET = 100 * 1024 * 1024;

export interface GmailImportResult {
  success: boolean;
  totalEmailsFound: number;
  totalReceiptsProcessed: number;
  emailsExamined: number;
  supportedReceiptsFound: number;
  exportCoveredReceipts: number;
  eligibleReceipts: number;
  deduplicatedReceipts: number;
  totalReceiptsImported: number;
  totalAmount: number;
  errors: string[];
  receipts: Receipt[];
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
  errorCode: string | null;
}

type AcquisitionPort = Pick<GmailImportAcquisitionService, 'acquire'>;
type ExtractionPort = Pick<ReceiptEmailBatchExtractor, 'extract'>;
type PersistencePort = Pick<ReceiptImportPersistenceService, 'persist'>;
type LifecyclePort = Pick<GmailImportLifecycleService, 'start' | 'complete' | 'fail' | 'markReconnectRequired'>;

export const isGmailReconnectError = (error: unknown): boolean => {
  const candidate = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const response = typeof candidate.response === 'object' && candidate.response !== null ? candidate.response as Record<string, unknown> : {};
  const data = typeof response.data === 'object' && response.data !== null ? response.data as Record<string, unknown> : {};
  return [candidate.message, candidate.code, data.error, data.error_description]
    .some((value) => String(value || '').toLowerCase().includes('invalid_grant'));
};

export const gmailImportErrorCode = (error: unknown): string => {
  if (isGmailReconnectError(error)) return 'GMAIL_RECONNECT_REQUIRED';
  const candidate = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const response = candidate.response && typeof candidate.response === 'object' ? candidate.response as Record<string, unknown> : {};
  if (candidate.code) return String(candidate.code).substring(0, 80);
  if (response.status) return `HTTP_${response.status}`;
  return 'GMAIL_SYNC_FAILED';
};

export const filterReceiptsAfterExportCutoffs = (
  receipts: readonly Receipt[],
  cutoffs: ExportCutoffsByReceiptType,
): Receipt[] => receipts.filter((receipt) => {
  const cutoff = cutoffs[receipt.receiptType];
  return !cutoff || Boolean(receipt.orderDate && receipt.orderDate > cutoff);
});

const resultFromState = (state: MailboxImportState, success = true, errorCode: string | null = null, errors: string[] = []): GmailImportResult => ({
  success,
  totalEmailsFound: state.counters.matchedMessages,
  totalReceiptsProcessed: state.counters.receiptsProcessed,
  emailsExamined: state.counters.emailsExamined,
  supportedReceiptsFound: state.counters.supportedReceiptsFound,
  exportCoveredReceipts: state.counters.exportCoveredReceipts,
  eligibleReceipts: state.counters.eligibleReceipts,
  deduplicatedReceipts: state.counters.deduplicatedReceipts,
  totalReceiptsImported: state.counters.totalReceiptsImported,
  totalAmount: state.counters.totalAmount,
  errors,
  receipts: [],
  newOrders: state.counters.newOrders,
  updatedOrders: state.counters.updatedOrders,
  unchangedOrders: state.counters.unchangedOrders,
  errorCode,
});

/** Processes and commits one mailbox page at a time, checkpointing only after durable writes. */
export class GmailImportService {
  constructor(
    private readonly acquisition: AcquisitionPort,
    private readonly extraction: ExtractionPort,
    private readonly persistence: PersistencePort,
    private readonly lifecycle: LifecyclePort,
    private readonly logger: StructuredLogger = silentStructuredLogger,
  ) {}

  async importFromGmail(
    user: User,
    lock: ImportLockHandle,
    trigger: 'manual' | 'background' = 'manual',
    execution?: ImportExecutionCheckpoint,
  ): Promise<GmailImportResult> {
    const syncRunId = await this.lifecycle.start(user.id, trigger);
    let state = restoreMailboxCheckpoint(execution, 'gmail');
    try {
      if (!state.done) {
        const acquired = await this.acquisition.acquire(user, trigger, state.cursor ?? undefined);
        for await (const page of acquired.pages) {
          const byteBudget = trigger === 'manual' ? HISTORICAL_BYTE_BUDGET : TRACKING_BYTE_BUDGET;
          if (state.counters.pages >= MAX_IMPORT_PAGES || state.counters.matchedMessages + page.matchedCount > MAX_IMPORT_MESSAGES) {
            throw new AppError({
              code: 'MAILBOX_IMPORT_LIMIT_REACHED',
              message: 'Gmail import exceeded its cumulative page or message budget',
              publicMessage: 'This mailbox has too many matching messages to import safely in one operation.',
            });
          }
          if (state.counters.decodedBytesExamined + (page.decodedBytes ?? 0) > byteBudget) {
            throw new AppError({ code: 'MAILBOX_IMPORT_LIMIT_REACHED', message: 'Gmail import exceeded its decoded byte budget', publicMessage: 'This mailbox is too large to import safely in one operation.' });
          }
          const extracted = await this.extraction.extract(page.messages, user.timezone, { userId: user.id, trigger });
          const eligible = filterReceiptsAfterExportCutoffs(extracted.supportedReceipts, acquired.exportCutoffs);
          const deduplicated = deduplicateReceipts(eligible);
          const persisted = await this.persistence.persist(user.id, deduplicated.receipts, lock);
          const counters = state.counters;
          counters.pages += 1;
          counters.matchedMessages += page.matchedCount;
          counters.emailsExamined += page.messages.length;
          counters.receiptsProcessed += extracted.extractedReceipts.length;
          counters.supportedReceiptsFound += extracted.supportedReceipts.length;
          counters.exportCoveredReceipts += extracted.supportedReceipts.length - eligible.length;
          counters.eligibleReceipts += eligible.length;
          counters.deduplicatedReceipts += deduplicated.receipts.length;
          counters.totalReceiptsImported += persisted.totalReceiptsImported;
          counters.totalAmount += deduplicated.receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);
          counters.errorCount += extracted.errors.length;
          counters.newOrders += persisted.newOrders;
          counters.updatedOrders += persisted.updatedOrders;
          counters.unchangedOrders += persisted.unchangedOrders;
          counters.rejectedMessages += page.rejectedCount ?? 0;
          counters.decodedBytesExamined += page.decodedBytes ?? 0;
          counters.errorCount += page.rejectedCount ?? 0;
          state = { ...state, cursor: page.nextCursor, done: page.nextCursor === null };
          await saveMailboxCheckpoint(execution, state);
        }
      }
      await this.lifecycle.complete(syncRunId, user.id, state.counters.errorCount ? 'partial' : 'success', {
        emailsScanned: state.counters.emailsExamined,
        receiptsProcessed: state.counters.receiptsProcessed,
        supportedReceiptsFound: state.counters.supportedReceiptsFound,
        exportCoveredReceipts: state.counters.exportCoveredReceipts,
        eligibleReceipts: state.counters.eligibleReceipts,
        deduplicatedReceipts: state.counters.deduplicatedReceipts,
        newOrders: state.counters.newOrders,
        updatedOrders: state.counters.updatedOrders,
        unchangedOrders: state.counters.unchangedOrders,
        rejectedMessages: state.counters.rejectedMessages,
        decodedBytesExamined: state.counters.decodedBytesExamined,
      }, trigger);
      this.logger.info('Gmail paged import completed', { userId: user.id, importId: syncRunId, provider: 'gmail', operation: 'gmail_import', outcome: 'success', pages: state.counters.pages, emailsExamined: state.counters.emailsExamined });
      return resultFromState(state);
    } catch (error) {
      const errorCode = gmailImportErrorCode(error);
      await this.lifecycle.fail(syncRunId, user.id, errorCode, trigger);
      if (errorCode === 'GMAIL_RECONNECT_REQUIRED') await this.lifecycle.markReconnectRequired(user.id);
      this.logger.error('Gmail paged import failed', { userId: user.id, importId: syncRunId, provider: 'gmail', operation: 'gmail_import', outcome: 'failure', errorCode, error });
      return resultFromState(state, false, errorCode, [error instanceof Error ? error.message : 'Unknown error']);
    }
  }
}
