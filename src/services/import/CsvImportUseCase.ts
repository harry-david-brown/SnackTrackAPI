import { AppError, ConflictError } from '../../core/errors';
import { CacheService } from '../core/CacheService';
import { ExportProvider, ImportPreferencesRepository } from '../data/ImportPreferencesRepository';
import { CsvImportService } from './CsvImportService';
import { ImportLockService } from './ImportLockService';

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
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError => new AppError({ code, message, publicMessage: message, details });

/** Owns CSV validation, writer locking, lifecycle state, persistence, and cache effects. */
export class CsvImportUseCase {
  constructor(
    private readonly csv: CsvImportService,
    private readonly preferences: ImportPreferencesRepository,
    private readonly cache: CacheService,
    private readonly locks: Pick<
      typeof ImportLockService,
      'acquireLock' | 'assertLockOwned' | 'releaseLock'
    >,
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

      const parsed = await this.csv.parseCsvFile(command.csvBuffer, command.userId);
      if (parsed.receipts.length === 0) {
        throw invalidImport('NO_VALID_EXPORT_ORDERS', 'No valid orders found in file', {
          errors: parsed.errors.length > 0 ? parsed.errors : ['File contains no valid order data'],
        });
      }

      await this.csv.importReceipts(
        parsed.receipts,
        command.userId,
        () => this.locks.assertLockOwned(lock),
      );
      await this.preferences.setExportStatus(command.userId, provider, 'completed');
      completed = true;
      await this.cache.invalidateAllUserCaches(command.userId);

      return {
        message: command.fileType === 'zip'
          ? 'ZIP file processed and receipts imported successfully'
          : 'CSV imported successfully',
        importedCount: parsed.totalReceipts,
        totalAmount: parsed.totalAmount,
        fileType: command.fileType,
        provider,
      };
    } catch (error) {
      if (lifecycleStarted && !completed && provider) {
        await this.preferences
          .setExportStatus(command.userId, provider, 'failed', 'EXPORT_IMPORT_FAILED')
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await this.locks.releaseLock(lock);
    }
  }
}
