import { AppError, ApplicationErrorCode, ConflictError } from '../../core/errors';
import { randomUUID } from 'crypto';
import type { ReceiptUpsertResult, ReceiptImportOutcomePort } from '../ports/ReceiptPorts';
import { receiptImportOutcomeFields, type ReceiptImportOutcome } from './ReceiptImportOutcome';
import type {
  ImportLifecyclePort,
  MailboxUserPort,
  ReceiptWriterLockPort,
} from '../ports/ImportPorts';
import type { ReceiptWritePort, UserCacheInvalidationPort } from '../ports/ReceiptPorts';
import type { ExportProvider } from './ImportLifecycleTypes';
import { CsvImportService } from './CsvImportService';
import type { ImportLockHandle } from './ImportLockService';
import { receiptImportAccounting } from './ReceiptImportExecution';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';

export type CsvImportCommand = {
  userId: string;
  provider: ExportProvider;
  fileType: 'csv' | 'zip';
  jobId?: string;
  accountingJobId?: string;
  assertActive?: () => Promise<void>;
} & ({ csvBuffer: Buffer; csvPath?: never } | { csvPath: string; csvBuffer?: never });

export interface CsvImportOperationResult {
  newOrders?: number;
  updatedOrders?: number;
  unresolvedOrders?: number;
  message: string;
  importedCount: number;
  totalAmount: number | null;
  currencyCode?: string | null;
  receiptOutcome?: ReceiptImportOutcome;
  fileType: 'csv' | 'zip';
  provider: ExportProvider;
}

const invalidImport = (
  code: ApplicationErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError => new AppError({ code, message, publicMessage: message, details });

/** Owns CSV validation, writer locking, lifecycle state, persistence, and cache effects. */
export class CsvImportUseCase {
  constructor(
    private readonly csv: CsvImportService,
    private readonly receipts: Pick<ReceiptWritePort, 'replaceProviderExport' | 'stageProviderExport' | 'replaceStagedProviderExport'>,
    private readonly users: Pick<MailboxUserPort, 'findById'>,
    private readonly preferences: Pick<ImportLifecyclePort, 'setExportStatus'>,
    private readonly cache: UserCacheInvalidationPort,
    private readonly locks: ReceiptWriterLockPort,
    private readonly outcomes?: ReceiptImportOutcomePort,
    private readonly receiptPolicy: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY,
  ) {}

  async execute(command: CsvImportCommand): Promise<CsvImportOperationResult> {
    const lock = await this.locks.acquireLock(command.userId);
    if (!lock) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'Another import or account reset is already in progress',
      );
    }

    try {
      return await this.executeWithLock(command, lock);
    } finally {
      await this.locks.releaseLock(lock);
    }
  }

  async executeWithLock(command: CsvImportCommand, lock: ImportLockHandle): Promise<CsvImportOperationResult> {
    await command.assertActive?.();
    const assertWritable = async () => {
      await command.assertActive?.();
      await this.locks.assertLockOwned(lock);
    };
    const accounting = receiptImportAccounting(this.receiptPolicy, command.accountingJobId, 'export');
    if (command.jobId && accounting && command.jobId !== accounting.jobId)
      throw new AppError({ code: 'IMPORT_CHECKPOINT_INVALID', message: 'Staged export and accounting belong to different import operations' });
    if (accounting && !this.outcomes) throw new Error('Canonical import outcome service is unavailable');
    let lifecycleStarted = false;
    let completed = false;
    let provider: ExportProvider | undefined;
    try {
      const validation = command.csvPath
        ? await this.csv.validateCsvPathForProvider(command.csvPath, command.provider)
        : this.csv.validateCsvFormat(command.csvBuffer!);
      if (!validation.valid) {
        throw invalidImport('INVALID_CSV_FORMAT', 'Invalid CSV format', {
          errors: validation.errors,
        });
      }

      const format = command.csvPath
        ? await this.csv.detectCsvFormatFromFile(command.csvPath)
        : this.csv.detectCsvFormat(command.csvBuffer!);
      if (format === 'unknown') {
        throw invalidImport(
          'UNKNOWN_EXPORT_PROVIDER',
          'Could not determine whether this export is from Uber Eats or DoorDash.',
        );
      }
      provider = format === 'uber' ? 'uber_eats' : 'doordash';
      if (provider !== command.provider) {
        throw invalidImport('UPLOAD_PROVIDER_MISMATCH', 'The selected file belongs to a different delivery provider.');
      }
      lifecycleStarted = await this.preferences.setExportStatus(
        command.userId,
        provider,
        'import_processing',
      );

      const user = await this.users.findById(command.userId);
      const parsed = command.csvPath
        ? await this.csv.parseCsvPathForProvider(command.csvPath, command.provider, command.userId, user?.timezone, this.receiptPolicy)
        : await this.csv.parseCsvFile(command.csvBuffer!, command.userId, user?.timezone, this.receiptPolicy);
      if (parsed.receipts.length === 0) {
        throw invalidImport('NO_VALID_EXPORT_ORDERS', 'No valid orders found in file', {
          errors: parsed.errors.length > 0 ? parsed.errors : ['File contains no valid order data'],
        });
      }

      await command.assertActive?.();
      const batch={id:command.jobId ?? randomUUID(),rejected:parsed.rejectedRecords ?? parsed.errors.length};
      let persisted:ReceiptUpsertResult | void;
      if (command.jobId) {
        await this.receipts.stageProviderExport(command.jobId, parsed.receipts);
        persisted=await this.receipts.replaceStagedProviderExport(command.jobId, command.userId, assertWritable,batch,accounting);
      } else {
        persisted=await this.receipts.replaceProviderExport(command.userId, parsed.receipts, assertWritable,batch,accounting);
      }
      const receiptOutcome = accounting && this.outcomes
        ? await this.outcomes.getImportOutcome(command.userId, accounting.jobId, assertWritable, accounting.scope)
        : undefined;
      const result = {
        ...(persisted ? {newOrders:persisted.newOrders,updatedOrders:persisted.updatedOrders,unresolvedOrders:persisted.unresolvedOrders ?? 0} : {}),
        importedCount: parsed.totalReceipts, totalAmount: parsed.totalAmount,
        ...(receiptOutcome ? receiptImportOutcomeFields(receiptOutcome) : {}),
      };
      if (receiptOutcome?.sourceDocuments === 0)
        throw new AppError({ code: 'IMPORT_CHECKPOINT_INVALID', message: 'Export persistence did not record canonical accounting evidence', publicMessage: 'This import could not be finalized safely. Your existing history is preserved.' });
      await this.preferences.setExportStatus(
        command.userId,
        provider,
        'completed',
        undefined,
        undefined,
        { importedCount: result.importedCount, totalAmount: result.totalAmount, fileType: command.fileType,
          ...(receiptOutcome ? { policyVersion: 3, newOrders: receiptOutcome.newOrders, updatedOrders: receiptOutcome.updatedOrders,
            unresolvedOrders: receiptOutcome.unresolvedOrders, unlinkedAdjustments: receiptOutcome.unlinkedAdjustments,
            adjustedOrders: receiptOutcome.adjustedOrders, cancellationsRecovered: receiptOutcome.cancellationsRecovered,
            currencyCode: result.currencyCode ?? null } : {}),
        },
      );
      completed = true;
      await this.cache.invalidateAllUserCaches(command.userId);

      return {
        ...result,
        message:
          command.fileType === 'zip'
            ? 'ZIP file processed and receipts imported successfully'
            : 'CSV imported successfully',
        fileType: command.fileType,
        provider,
      };
    } catch (error) {
      const failure =
        error instanceof AppError
          ? error
          : new AppError({
              code: 'EXPORT_IMPORT_FAILED',
              message: 'Export import failed',
              publicMessage: 'Export import failed. Please try again.',
              details: provider ? { provider } : undefined,
              cause: error,
            });
      if (lifecycleStarted && !completed && provider) {
        await this.preferences
          .setExportStatus(command.userId, provider, 'failed', failure.code)
          .catch(() => undefined);
      }
      throw failure;
    }
  }
}
