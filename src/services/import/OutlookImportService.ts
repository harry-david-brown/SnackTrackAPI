import { AppError } from '../../core/errors';
import type { User } from '../../models/User';
import type { StructuredLogger } from '../core/StructuredLogger';
import { silentStructuredLogger } from '../core/StructuredLogger';
import type {
  ImportLifecyclePort,
  MicrosoftMailboxConnectionPort,
  MicrosoftMailboxSyncRunPort,
} from '../ports/ImportPorts';
import type { ImportLockHandle } from './ImportLockService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';
import type { OutlookImportAcquisitionService } from './OutlookImportAcquisitionService';
import type { ReceiptEmailBatchExtractor } from './ReceiptEmailBatchExtractor';
import type { ReceiptImportPersistenceService } from './ReceiptImportPersistenceService';
import { deduplicateReceipts } from './ReceiptDeduplicator';
import { filterReceiptsAfterExportCutoffs, type GmailImportResult } from './GmailImportService';
import { restoreMailboxCheckpoint, saveMailboxCheckpoint, type MailboxImportState } from './MailboxImportCheckpoint';

const MAX_IMPORT_MESSAGES = 20_000;
const HISTORICAL_BYTE_BUDGET = 500 * 1024 * 1024;
const TRACKING_BYTE_BUDGET = 100 * 1024 * 1024;

const failureResult = (error: unknown, errorCode: string): GmailImportResult => ({
  success: false,
  totalEmailsFound: 0,
  totalReceiptsProcessed: 0,
  emailsExamined: 0,
  supportedReceiptsFound: 0,
  exportCoveredReceipts: 0,
  eligibleReceipts: 0,
  deduplicatedReceipts: 0,
  totalReceiptsImported: 0,
  totalAmount: 0,
  errors: [error instanceof Error ? error.message : 'Unknown Outlook import error'],
  receipts: [],
  newOrders: 0,
  updatedOrders: 0,
  unchangedOrders: 0,
  errorCode,
});

const errorCodeFor = (error: unknown): string => {
  if (error instanceof AppError) return String(error.code).substring(0, 80);
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  return record.code ? String(record.code).substring(0, 80) : 'OUTLOOK_SYNC_FAILED';
};

/** Runs Outlook messages through the shared extraction, dedupe, and persistence pipeline. */
export class OutlookImportService {
  constructor(
    private readonly acquisition: Pick<OutlookImportAcquisitionService, 'acquire'>,
    private readonly extraction: Pick<ReceiptEmailBatchExtractor, 'extract'>,
    private readonly persistence: Pick<ReceiptImportPersistenceService, 'persist'>,
    private readonly syncRuns: Pick<
      MicrosoftMailboxSyncRunPort,
      'startSyncRun' | 'completeSyncRun' | 'failSyncRun'
    >,
    private readonly connections: Pick<
      MicrosoftMailboxConnectionPort,
      'markMicrosoftReconnectRequired'
    >,
    private readonly lifecycle: Pick<ImportLifecyclePort, 'markTrackingReconnectRequired'>,
    private readonly logger: StructuredLogger = silentStructuredLogger,
  ) {}

  async importFromOutlook(
    user: User,
    lock: ImportLockHandle,
    trigger: 'manual' | 'background' = 'manual',
    execution?: ImportExecutionCheckpoint,
  ): Promise<GmailImportResult> {
    const syncRunId = await this.syncRuns.startSyncRun(user.id, trigger);
    let state = restoreMailboxCheckpoint(execution, 'microsoft');
    try {
      if (!state.done) {
        const acquired = await this.acquisition.acquire(user.id, trigger, state.cursor ?? undefined);
        for await (const page of acquired.pages) {
          if (state.counters.matchedMessages + page.matchedCount > MAX_IMPORT_MESSAGES) {
            throw new AppError({
              code: 'MAILBOX_IMPORT_LIMIT_REACHED',
              message: 'Outlook import exceeded its cumulative message budget',
              publicMessage: 'This mailbox has too many matching messages to import safely in one operation.',
            });
          }
          const byteBudget = trigger === 'manual' ? HISTORICAL_BYTE_BUDGET : TRACKING_BYTE_BUDGET;
          if (state.counters.decodedBytesExamined + (page.decodedBytes ?? 0) > byteBudget) {
            throw new AppError({ code: 'MAILBOX_IMPORT_LIMIT_REACHED', message: 'Outlook import exceeded its decoded byte budget', publicMessage: 'This mailbox is too large to import safely in one operation.' });
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
      await this.syncRuns.completeSyncRun(
        syncRunId,
        user.id,
        state.counters.errorCount ? 'partial' : 'success',
        {
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
        },
        trigger,
      );
      this.logger.info('Outlook receipt import completed', {
        userId: user.id,
        importId: syncRunId,
        operation: 'outlook_receipt_import',
        provider: 'microsoft',
        outcome: state.counters.errorCount ? 'partial' : 'success',
        emailsExamined: state.counters.emailsExamined,
        pages: state.counters.pages,
      });
      return this.successResult(state);
    } catch (error) {
      const errorCode = errorCodeFor(error);
      await this.syncRuns.failSyncRun(syncRunId, user.id, errorCode, trigger);
      if (errorCode === 'OUTLOOK_RECONNECT_REQUIRED') {
        await this.connections.markMicrosoftReconnectRequired(user.id);
        await this.lifecycle.markTrackingReconnectRequired(user.id);
      }
      this.logger.error('Outlook receipt import failed', {
        userId: user.id,
        importId: syncRunId,
        operation: 'outlook_receipt_import',
        provider: 'microsoft',
        outcome: 'failure',
        errorCode,
        error,
      });
      return { ...failureResult(error, errorCode), ...this.countsFromState(state), success: false, errorCode };
    }
  }

  private countsFromState(state: MailboxImportState): Pick<GmailImportResult,
    'totalEmailsFound'|'totalReceiptsProcessed'|'emailsExamined'|'supportedReceiptsFound'|
    'exportCoveredReceipts'|'eligibleReceipts'|'deduplicatedReceipts'|'totalReceiptsImported'|
    'totalAmount'|'newOrders'|'updatedOrders'|'unchangedOrders'> {
    return {
      totalEmailsFound: state.counters.matchedMessages,
      totalReceiptsProcessed: state.counters.receiptsProcessed,
      emailsExamined: state.counters.emailsExamined,
      supportedReceiptsFound: state.counters.supportedReceiptsFound,
      exportCoveredReceipts: state.counters.exportCoveredReceipts,
      eligibleReceipts: state.counters.eligibleReceipts,
      deduplicatedReceipts: state.counters.deduplicatedReceipts,
      totalReceiptsImported: state.counters.totalReceiptsImported,
      totalAmount: state.counters.totalAmount,
      newOrders: state.counters.newOrders,
      updatedOrders: state.counters.updatedOrders,
      unchangedOrders: state.counters.unchangedOrders,
    };
  }

  private successResult(state: MailboxImportState): GmailImportResult {
    return { success: true, ...this.countsFromState(state), errors: [], receipts: [], errorCode: null };
  }
}
