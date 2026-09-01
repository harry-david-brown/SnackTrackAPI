import type { User } from '../../models/User';
import { Receipt, ReceiptType } from '../../models/Receipt';
import type { StructuredLogger } from '../core/StructuredLogger';
import { silentStructuredLogger } from '../core/StructuredLogger';
import type { ImportLockHandle } from './ImportLockService';
import type {
  ExportCutoffsByReceiptType,
  GmailImportAcquisitionService,
} from './GmailImportAcquisitionService';
import type { GmailImportLifecycleService } from './GmailImportLifecycleService';
import type { ReceiptEmailBatchExtractor } from './ReceiptEmailBatchExtractor';
import { deduplicateReceipts } from './ReceiptDeduplicator';
import type { ReceiptImportPersistenceService } from './ReceiptImportPersistenceService';

export { resolveIncrementalGmailSearchAfter } from './GmailImportAcquisitionService';
export type { ExportCutoffsByReceiptType } from './GmailImportAcquisitionService';

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
type LifecyclePort = Pick<
  GmailImportLifecycleService,
  'start' | 'complete' | 'fail' | 'markReconnectRequired'
>;

export const isGmailReconnectError = (error: unknown): boolean => {
  const candidate =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const response =
    typeof candidate.response === 'object' && candidate.response !== null
      ? (candidate.response as Record<string, unknown>)
      : {};
  const responseData =
    typeof response.data === 'object' && response.data !== null
      ? (response.data as Record<string, unknown>)
      : {};
  return [
    candidate.message,
    candidate.code,
    responseData.error,
    responseData.error_description,
  ].some((value) =>
    String(value || '')
      .toLowerCase()
      .includes('invalid_grant'),
  );
};

export const gmailImportErrorCode = (error: unknown): string => {
  if (isGmailReconnectError(error)) return 'GMAIL_RECONNECT_REQUIRED';
  const candidate = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const response =
    candidate.response && typeof candidate.response === 'object'
      ? (candidate.response as Record<string, unknown>)
      : {};
  if (candidate.code) return String(candidate.code).substring(0, 80);
  if (response.status) return `HTTP_${response.status}`;
  return 'GMAIL_SYNC_FAILED';
};

export const filterReceiptsAfterExportCutoffs = (
  receipts: readonly Receipt[],
  cutoffs: ExportCutoffsByReceiptType,
): Receipt[] =>
  receipts.filter((receipt) => {
    const cutoff = cutoffs[receipt.receiptType];
    return !cutoff || Boolean(receipt.orderDate && receipt.orderDate > cutoff);
  });

const emptyFailure = (error: unknown, errorCode: string): GmailImportResult => ({
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
  errors: [error instanceof Error ? error.message : 'Unknown error'],
  receipts: [],
  newOrders: 0,
  updatedOrders: 0,
  unchangedOrders: 0,
  errorCode,
});

/** Coordinates a Gmail import through focused acquisition, extraction, write, and lifecycle ports. */
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
  ): Promise<GmailImportResult> {
    const syncRunId = await this.lifecycle.start(user.id, trigger);
    try {
      const acquired = await this.acquisition.acquire(user, trigger);
      const extracted = await this.extraction.extract(acquired.emails, user.timezone, {
        userId: user.id,
        trigger,
      });
      this.logExtraction(user.id, syncRunId, trigger, acquired.emails.length, extracted);

      const eligibleReceipts = filterReceiptsAfterExportCutoffs(
        extracted.supportedReceipts,
        acquired.exportCutoffs,
      );
      const exportCoveredReceipts = extracted.supportedReceipts.length - eligibleReceipts.length;
      const deduplicated = deduplicateReceipts(eligibleReceipts);
      this.logDeduplication(user.id, syncRunId, eligibleReceipts, deduplicated);

      let persisted;
      try {
        persisted = await this.persistence.persist(user.id, deduplicated.receipts, lock);
      } catch (error) {
        const message = `Batch insert failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        this.logger.error('Gmail receipt persistence failed', {
          userId: user.id,
          importId: syncRunId,
          operation: 'gmail_receipt_persistence',
          provider: 'gmail',
          outcome: 'failure',
          error,
        });
        await this.lifecycle.fail(syncRunId, user.id, 'GMAIL_IMPORT_WRITE_FAILED', trigger);
        return {
          ...this.resultForBatch(
            acquired.emails.length,
            extracted.extractedReceipts.length,
            extracted.supportedReceipts.length,
            exportCoveredReceipts,
            eligibleReceipts.length,
            deduplicated.receipts,
            extracted.errors.concat(message),
          ),
          success: false,
          errorCode: 'GMAIL_IMPORT_WRITE_FAILED',
        };
      }

      await this.lifecycle.complete(
        syncRunId,
        user.id,
        extracted.errors.length ? 'partial' : 'success',
        {
          emailsScanned: acquired.emails.length,
          receiptsProcessed: extracted.extractedReceipts.length,
          supportedReceiptsFound: extracted.supportedReceipts.length,
          exportCoveredReceipts,
          eligibleReceipts: eligibleReceipts.length,
          deduplicatedReceipts: deduplicated.receipts.length,
          newOrders: persisted.newOrders,
          updatedOrders: persisted.updatedOrders,
          unchangedOrders: persisted.unchangedOrders,
        },
        trigger,
      );
      this.logger.info('Gmail receipt persistence completed', {
        userId: user.id,
        importId: syncRunId,
        operation: 'gmail_receipt_persistence',
        provider: 'gmail',
        outcome: 'success',
        ...persisted,
      });
      return {
        ...this.resultForBatch(
          acquired.emails.length,
          extracted.extractedReceipts.length,
          extracted.supportedReceipts.length,
          exportCoveredReceipts,
          eligibleReceipts.length,
          deduplicated.receipts,
          extracted.errors,
        ),
        totalReceiptsImported: persisted.totalReceiptsImported,
        newOrders: persisted.newOrders,
        updatedOrders: persisted.updatedOrders,
        unchangedOrders: persisted.unchangedOrders,
      };
    } catch (error) {
      const errorCode = gmailImportErrorCode(error);
      this.logger.error('Gmail import orchestration failed', {
        userId: user.id,
        importId: syncRunId,
        operation: 'gmail_import',
        provider: 'gmail',
        outcome: 'failure',
        errorCode,
        error,
      });
      await this.lifecycle.fail(syncRunId, user.id, errorCode, trigger);
      if (errorCode === 'GMAIL_RECONNECT_REQUIRED') {
        await this.lifecycle.markReconnectRequired(user.id);
      }
      return emptyFailure(error, errorCode);
    }
  }

  private resultForBatch(
    emailsExamined: number,
    receiptsProcessed: number,
    supportedReceiptsFound: number,
    exportCoveredReceipts: number,
    eligibleReceipts: number,
    receipts: Receipt[],
    errors: string[],
  ): GmailImportResult {
    return {
      success: true,
      totalEmailsFound: emailsExamined,
      totalReceiptsProcessed: receiptsProcessed,
      emailsExamined,
      supportedReceiptsFound,
      exportCoveredReceipts,
      eligibleReceipts,
      deduplicatedReceipts: receipts.length,
      totalReceiptsImported: 0,
      totalAmount: receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0),
      errors,
      receipts,
      newOrders: 0,
      updatedOrders: 0,
      unchangedOrders: 0,
      errorCode: null,
    };
  }

  private logExtraction(
    userId: string,
    syncRunId: string,
    trigger: 'manual' | 'background',
    emailsExamined: number,
    batch: Awaited<ReturnType<ExtractionPort['extract']>>,
  ): void {
    this.logger.info('Gmail receipt extraction completed', {
      userId,
      importId: syncRunId,
      operation: 'gmail_receipt_extraction',
      provider: 'gmail',
      outcome: 'success',
      triggerType: trigger,
      emailsExamined,
      receiptsExtracted: batch.extractedReceipts.length,
      nonReceiptCount: batch.nonReceiptCount,
      nonFoodCount: batch.nonFoodCount,
      durationMs: batch.durationMs,
    });
  }

  private logDeduplication(
    userId: string,
    syncRunId: string,
    eligible: readonly Receipt[],
    result: ReturnType<typeof deduplicateReceipts>,
  ): void {
    const uberCandidates = eligible.filter(
      (receipt) =>
        receipt.receiptType === ReceiptType.UBER_EATS ||
        receipt.restaurantName?.toLowerCase().includes('uber'),
    ).length;
    if (!result.totalWithIdentity && uberCandidates) {
      this.logger.warn('Gmail receipt identity extraction coverage is empty', {
        userId,
        importId: syncRunId,
        operation: 'gmail_receipt_deduplication',
        provider: 'gmail',
        outcome: 'identity_missing',
        candidateCount: uberCandidates,
      });
    }
    this.logger.info('Gmail receipt deduplication completed', {
      userId,
      importId: syncRunId,
      operation: 'gmail_receipt_deduplication',
      provider: 'gmail',
      outcome: 'success',
      originalCount: eligible.length,
      uniqueCount: result.receipts.length,
      duplicatesFound: result.duplicatesFound,
      higherAmountReplacements: result.higherAmountReplacements,
      totalWithIdentity: result.totalWithIdentity,
      totalBeforeDeduplication: result.totalBeforeDeduplication,
      totalAfterDeduplication: result.totalAfterDeduplication,
    });
  }
}
