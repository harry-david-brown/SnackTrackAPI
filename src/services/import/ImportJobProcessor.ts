import type { ExportReadyAlertService } from './ExportReadyAlertService';
import type { ReceiptRebuildService } from '../receipt/ReceiptRebuildService';
import { decodeReceiptReviewChanges } from '../receipt/ReceiptReviewDecisions';
import { DelayedError, type Job } from 'bullmq';
import { AppError } from '../../core/errors';
import type { ImportJobRepository } from '../data/ImportJobRepository';
import type { ImportObjectStorage } from '../storage/ImportObjectStorage';
import type { HistoricalGmailImportService } from './HistoricalGmailImportService';
import type { HistoricalOutlookImportService } from './HistoricalOutlookImportService';
import type { ManualTrackingCheckService } from './ManualTrackingCheckService';
import type { OngoingTrackingService } from './OngoingTrackingService';
import type { CsvImportUseCase } from './CsvImportUseCase';
import type { ZipExtractor } from './ZipExtractor';
import { EXPORT_IMPORT_RETRY_DELAY_MS, MAILBOX_IMPORT_RETRY_DELAY_MS, type QueuePayload } from '../queue/ImportQueues';
import { ImportLockService, type ImportLockHandle } from './ImportLockService';
import type { ImportJob } from './ImportJobTypes';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';
import type { ImportTestScenarioRepository } from '../data/ImportTestScenarioRepository';
import type { GmailPushTrackingService } from './GmailPushTrackingService';
import type { ReceiptImportOutcomePort } from '../ports/ReceiptPorts';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';
import { receiptImportOutcomeFields } from './ReceiptImportOutcome';

const permanentCodes = new Set([
  'VALIDATION_ERROR','INVALID_CSV_FORMAT','UNKNOWN_EXPORT_PROVIDER','NO_VALID_EXPORT_ORDERS',
  'GMAIL_ACCESS_BLOCKED','GMAIL_RECONNECT_REQUIRED','OUTLOOK_RECONNECT_REQUIRED','TRACKING_NOT_AVAILABLE',
  'MAILBOX_IMPORT_LIMIT_REACHED','OUTLOOK_RESULT_LIMIT',
  'IMPORT_CHECKPOINT_INVALID',
  'IMPORT_DURABLE_CONTEXT_REQUIRED',
  'IMPORT_OUTCOME_STALE',
  'RECEIPT_REVIEW_INVALID','RECEIPT_REVIEW_IDEMPOTENCY_CONFLICT','RECEIPT_REVIEW_SUPERSEDED',
  'RECEIPT_REVIEW_SOURCE_UNAVAILABLE','RECEIPT_REVIEW_HISTORY_CHANGED','RECEIPT_REVIEW_CONFLICT',
  'REPAIR_POLICY_STALE','REPAIR_GENERATION_STALE','REPAIR_MANIFEST_REQUIRED','REPAIR_LOCK_SCOPE_MISMATCH',
  'REPAIR_MANIFEST_INELIGIBLE','REPAIR_EVIDENCE_CHANGED','REPAIR_MANIFEST_EXPIRED','REPAIR_SOURCE_CHANGED',
  'UPLOAD_PROVIDER_REQUIRED','UPLOAD_PROVIDER_MISMATCH','UPLOAD_CHANGED','UPLOAD_SIZE_MISMATCH',
  'UPLOAD_TOO_LARGE','UPLOAD_INTEGRITY_FAILED','UNSUPPORTED_UPLOAD_TYPE',
  'ZIP_INVALID','ZIP_TOO_MANY_ENTRIES','ZIP_TOO_LARGE','ZIP_OUTPUT_TOO_LARGE',
  'ZIP_UNSAFE_ENTRY','ZIP_ENCRYPTED','ZIP_COMPRESSION_RATIO','ZIP_AMBIGUOUS_EXPORT',
  'ZIP_SIZE_MISMATCH','ZIP_INTEGRITY_FAILED','CSV_HEADER_TOO_LARGE','CSV_ROW_TOO_LARGE',
]);

export class ImportJobProcessor {
  constructor(
    private readonly jobs: ImportJobRepository,
    private readonly storage: ImportObjectStorage,
    private readonly zip: Pick<ZipExtractor, 'isZipFile'|'extractProviderCSVToFile'>,
    private readonly csv: Pick<CsvImportUseCase, 'executeWithLock'>,
    private readonly gmail: Pick<HistoricalGmailImportService, 'executeWithLock'>,
    private readonly outlook: Pick<HistoricalOutlookImportService, 'executeWithLock'>,
    private readonly manual: Pick<ManualTrackingCheckService, 'executeWithLock'>,
    private readonly tracking: Pick<OngoingTrackingService, 'checkUserWithLock'|'checkOutlookUserWithLock'>,
    private readonly testScenarios: Pick<ImportTestScenarioRepository, 'delayGmailImportIfEnabled'>,
    private readonly gmailPush: Pick<GmailPushTrackingService, 'executeWithLock'>,
    private readonly rebuild?: Pick<ReceiptRebuildService, 'executeWithLock'>,
    private readonly receiptOutcomes?: ReceiptImportOutcomePort,
    private readonly receiptPolicy: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY,
    private readonly exportAlerts?: Pick<ExportReadyAlertService, 'execute'>,
  ) {}

  async process(queueJob: Job<QueuePayload>): Promise<void> {
    const pending = await this.jobs.findById(queueJob.data.jobId);
    if (!pending || pending.status === 'cancelled') return;
    if (pending.kind==='export_ready_check' && await this.jobs.findActive(pending.userId)) {
      await queueJob.moveToDelayed(Date.now()+30_000,queueJob.token);
      throw new DelayedError();
    }
    let lock: ImportLockHandle | null;
    try {
      lock = await ImportLockService.acquireLockWithWait(pending.userId, 300_000);
    } catch (error) {
      if (error instanceof AppError && error.code === 'LOCK_BACKEND_UNAVAILABLE') {
        await queueJob.moveToDelayed(Date.now() + 30_000, queueJob.token);
        throw new DelayedError();
      }
      throw error;
    }
    if (!lock) throw new AppError({ code: 'IMPORT_IN_PROGRESS', message: 'Receipt writer remained busy.' });
    let operation: ImportJob | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      operation = await this.jobs.claimForRun(queueJob.data.jobId);
      if (!operation) return;
      if (operation.kind === 'gmail_historical' && operation.trigger === 'user') {
        const resumeAt = await this.testScenarios.delayGmailImportIfEnabled(operation.id, operation.userId);
        if (resumeAt) {
          await queueJob.moveToDelayed(resumeAt.getTime(), queueJob.token);
          throw new DelayedError();
        }
      }
      const accountReceipts = this.receiptPolicy === 3 && !['export_ready_check','receipt_rebuild','receipt_publish','receipt_rollback'].includes(operation.kind);
      if (accountReceipts && !this.receiptOutcomes) throw new Error('Canonical import outcome service is unavailable');
      const execution: ImportExecutionCheckpoint = {
        ...(accountReceipts ? { accountingJobId: operation.id } : {}),
        checkpoint: operation.checkpoint,
        save: (checkpoint, phase, progress) => this.jobs.saveCheckpoint(operation!.id, checkpoint, phase, progress),
      };
      heartbeat = setInterval(() => void this.jobs.heartbeat(operation!.id).catch(() => undefined), 30_000);
      heartbeat.unref();
      await this.jobs.progress(operation.id, 'processing', 10);
      let result: Readonly<Record<string, unknown>>;
      switch (operation.kind) {
        case 'export_ready_check':
          if (!this.exportAlerts) throw new Error('Export alert service unavailable');
          result = await this.exportAlerts.execute(operation, lock); break;
        case 'gmail_historical': result = this.compactMailboxResult(await this.gmail.executeWithLock(operation.userId, lock, execution)); break;
        case 'outlook_historical': result = this.compactMailboxResult(await this.outlook.executeWithLock(operation.userId, lock, execution)); break;
        case 'manual_tracking': result = this.requireTrackingSuccess(await this.manual.executeWithLock(operation.userId, lock, execution) as unknown as Readonly<Record<string, unknown>>); break;
        case 'scheduled_tracking': result = this.requireTrackingSuccess((await this.tracking.checkOutlookUserWithLock(operation.userId, lock, execution) as unknown as Readonly<Record<string, unknown>> | null) ?? { success: true, newOrders: 0, updatedOrders: 0, skipped: true }); break;
        case 'gmail_push_tracking': result = await this.gmailPush.executeWithLock(operation.userId, lock, execution); break;
        case 'receipt_rebuild':
        case 'receipt_publish':
        case 'receipt_rollback':
          if (!this.rebuild) throw new Error('Receipt rebuild service is unavailable');
          if (operation.checkpoint.stagedBatchIds !== undefined &&
              (!Array.isArray(operation.checkpoint.stagedBatchIds) || !operation.checkpoint.stagedBatchIds.every((id) => typeof id === 'string')))
            throw new Error('Invalid staged repair batch checkpoint');
          result = await this.rebuild.executeWithLock(operation.userId, operation.importGeneration,
            operation.kind === 'receipt_rebuild' ? 'prepare' : operation.kind === 'receipt_publish' ? 'publish' : 'rollback',
            lock, typeof operation.checkpoint.manifestId === 'string' ? operation.checkpoint.manifestId : undefined,
            operation.checkpoint.stagedBatchIds,
            decodeReceiptReviewChanges(operation.checkpoint.reviewChanges === undefined ? [] : operation.checkpoint.reviewChanges));
          break;
        case 'export_file': result = await this.processExport(operation, lock); break;
      }
      await this.jobs.progress(operation.id, 'finalizing', 95);
      if (accountReceipts && this.receiptOutcomes) {
        const outcome = await this.receiptOutcomes.getImportOutcome(operation.userId, operation.id, () => ImportLockService.assertLockOwned(lock));
        result = { ...result, ...receiptImportOutcomeFields(outcome) };
      }
      await this.jobs.succeed(operation, result);
      if (operation.kind === 'export_file' && operation.objectKey) {
        await this.storage.delete(operation.objectKey).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      if (!operation) throw error;
      const code = error instanceof AppError ? error.code : 'IMPORT_WORKER_FAILED';
      const message = error instanceof AppError ? error.publicMessage : 'The import could not be completed.';
      if (code === 'LOCK_BACKEND_UNAVAILABLE' || code === 'LOCK_OWNERSHIP_LOST') {
        const retryAt = new Date(Date.now() + 30_000).toISOString();
        await this.jobs.delayForInfrastructure(operation.id, code, message, {
          ...(error instanceof AppError ? error.details : {}),
          retryNotBefore: retryAt,
          retryBy: retryAt,
        });
        await queueJob.moveToDelayed(Date.now() + 30_000, queueJob.token);
        throw new DelayedError();
      }
      const canRetry = !permanentCodes.has(code) && queueJob.attemptsMade + 1 < (queueJob.opts.attempts ?? 1);
      if (canRetry) {
        await this.jobs.retry(operation.id, code, message, this.retryDetails(operation, queueJob, error instanceof AppError ? error.details : undefined));
        throw error;
      }
      await this.jobs.fail(operation, code, message, error instanceof AppError ? error.details : undefined);
      if (operation.kind === 'export_file' && operation.objectKey) {
        await this.storage.delete(operation.objectKey).catch(() => undefined);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await ImportLockService.releaseLock(lock);
    }
  }

  private compactMailboxResult<T extends object>(result: T): Readonly<Record<string, unknown>> {
    const { receipts: _receipts, errors, failureDetails: _failureDetails, ...compact } = result as T & { receipts?: unknown; errors?: unknown; failureDetails?: unknown };
    return {
      ...compact,
      errorCount: Array.isArray(errors) ? errors.length : 0,
    };
  }

  private retryDetails(
    operation: ImportJob,
    queueJob: Job<QueuePayload>,
    details?: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const base = operation.kind === 'export_file' ? EXPORT_IMPORT_RETRY_DELAY_MS : MAILBOX_IMPORT_RETRY_DELAY_MS;
    const maximumMs = base * 2 ** Math.max(0, queueJob.attemptsMade);
    const minimumMs = Math.round(maximumMs * 0.8);
    const now = Date.now();
    return {
      ...(details ?? {}),
      retryNotBefore: new Date(now + minimumMs).toISOString(),
      retryBy: new Date(now + maximumMs).toISOString(),
    };
  }

  private requireTrackingSuccess(result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    if (result.success !== false) return result;
    const code = typeof result.errorCode === 'string' ? result.errorCode : 'MAILBOX_TRACKING_FAILED';
    throw new AppError({
      code,
      message: `Mailbox tracking failed: ${code}`,
      publicMessage: code.includes('RECONNECT_REQUIRED')
        ? 'Reconnect your mailbox to continue.'
        : 'Mailbox tracking could not be completed. Please try again.',
    });
  }

  private async processExport(operation: ImportJob, lock: ImportLockHandle): Promise<Readonly<Record<string, unknown>>> {
    if (!operation.objectKey) throw new AppError({ code: 'UPLOAD_NOT_FOUND', message: 'Import object key is missing.' });
    if (!operation.exportProvider) throw new AppError({ code: 'UPLOAD_PROVIDER_REQUIRED', message: 'Import provider is missing.' });
    if (!operation.objectEtag || !operation.submittedContentLength) throw new AppError({ code: 'UPLOAD_INTEGRITY_FAILED', message: 'Submitted upload integrity metadata is missing.' });
    await this.jobs.progress(operation.id, 'downloading', 20);
    const maximumBytes = operation.originalFilename?.toLowerCase().endsWith('.zip') ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
    const temporary = await this.storage.downloadToTemporaryFile(operation.objectKey, {
      contentLength: operation.submittedContentLength,
      etag: operation.objectEtag,
      maximumBytes,
    });
    try {
      const isZip = await this.zip.isZipFile(temporary.path);
      const expectedZip = operation.originalFilename?.toLowerCase().endsWith('.zip') ?? false;
      if (isZip !== expectedZip) throw new AppError({ code: 'UNSUPPORTED_UPLOAD_TYPE', message: 'The file contents do not match the selected file type.' });
      await this.jobs.progress(operation.id, isZip ? 'extracting' : 'parsing', 40);
      const extracted = isZip ? await this.zip.extractProviderCSVToFile(temporary.path, operation.exportProvider) : null;
      try {
        await this.jobs.progress(operation.id, 'importing', 70);
        return await this.csv.executeWithLock({ userId: operation.userId, provider: operation.exportProvider, csvPath: extracted?.path ?? temporary.path, fileType: isZip ? 'zip' : 'csv', jobId: operation.id,
          ...(this.receiptPolicy === 3 ? { accountingJobId: operation.id } : {}),
        }, lock) as unknown as Readonly<Record<string, unknown>>;
      } finally {
        await extracted?.remove();
      }
    } finally {
      await temporary.remove();
    }
  }
}
