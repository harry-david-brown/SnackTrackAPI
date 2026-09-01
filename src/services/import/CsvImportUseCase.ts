import { AppError, ApplicationErrorCode, ConflictError } from '../../core/errors';
import type {
  ImportLifecyclePort,
  MailboxUserPort,
  ReceiptWriterLockPort,
} from '../ports/ImportPorts';
import type { ReceiptWritePort, UserCacheInvalidationPort } from '../ports/ReceiptPorts';
import type { ExportProvider } from './ImportLifecycleTypes';
import { CsvImportService } from './CsvImportService';

export interface CsvImportCommand {
  userId: string;
  csvBuffer: Buffer;
  fileType: 'csv' | 'zip';
}

export interface CsvImportOperationResult {
  message: string;
  importedCount: number;
  totalAmount: number;
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
    private readonly receipts: Pick<ReceiptWritePort, 'replaceProviderExport'>,
    private readonly users: Pick<MailboxUserPort, 'findById'>,
    private readonly preferences: Pick<ImportLifecyclePort, 'setExportStatus'>,
    private readonly cache: UserCacheInvalidationPort,
    private readonly locks: ReceiptWriterLockPort,
  ) {}

  async execute(command: CsvImportCommand): Promise<CsvImportOperationResult> {
    const lock = await this.locks.acquireLock(command.userId);
    if (!lock) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'Another import or account reset is already in progress',
      );
    }

    let lifecycleStarted = false;
    let completed = false;
    let provider: ExportProvider | undefined;
    try {
      const validation = this.csv.validateCsvFormat(command.csvBuffer);
      if (!validation.valid) {
        throw invalidImport('INVALID_CSV_FORMAT', 'Invalid CSV format', {
          errors: validation.errors,
        });
      }

      const format = this.csv.detectCsvFormat(command.csvBuffer);
      if (format === 'unknown') {
        throw invalidImport(
          'UNKNOWN_EXPORT_PROVIDER',
          'Could not determine whether this export is from Uber Eats or DoorDash.',
        );
      }
      provider = format === 'uber' ? 'uber_eats' : 'doordash';
      lifecycleStarted = await this.preferences.setExportStatus(
        command.userId,
        provider,
        'import_processing',
      );

      const user = await this.users.findById(command.userId);
      const parsed = await this.csv.parseCsvFile(command.csvBuffer, command.userId, user?.timezone);
      if (parsed.receipts.length === 0) {
        throw invalidImport('NO_VALID_EXPORT_ORDERS', 'No valid orders found in file', {
          errors: parsed.errors.length > 0 ? parsed.errors : ['File contains no valid order data'],
        });
      }

      await this.receipts.replaceProviderExport(command.userId, parsed.receipts, () =>
        this.locks.assertLockOwned(lock),
      );
      await this.preferences.setExportStatus(command.userId, provider, 'completed');
      completed = true;
      await this.cache.invalidateAllUserCaches(command.userId);

      return {
        message:
          command.fileType === 'zip'
            ? 'ZIP file processed and receipts imported successfully'
            : 'CSV imported successfully',
        importedCount: parsed.totalReceipts,
        totalAmount: parsed.totalAmount,
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
    } finally {
      await this.locks.releaseLock(lock);
    }
  }
}
