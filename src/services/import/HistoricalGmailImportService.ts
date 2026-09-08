import { AppError, ConflictError, ValidationError } from '../../core/errors';
import type { GmailImportResult, GmailImportService } from './GmailImportService';
import type { ImportLockHandle, ImportLockService } from './ImportLockService';
import type { ImportStatusService } from './ImportStatusService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';

type StatusPort = Pick<ImportStatusService, 'getConnection'>;
type ImportPort = Pick<GmailImportService, 'importFromGmail'>;
type LockPort = Pick<typeof ImportLockService, 'acquireLock' | 'releaseLock' | 'isLocked'>;
interface ImportLoggerPort {
  info(message: string, metadata: Readonly<Record<string, unknown>>): void;
}

/** Owns preflight, user-scoped locking, execution, and failure mapping for a manual Gmail import. */
export class HistoricalGmailImportService {
  constructor(
    private readonly status: StatusPort,
    private readonly gmailImport: ImportPort,
    private readonly locks: LockPort,
    private readonly logger: ImportLoggerPort,
  ) {}

  isInProgress(userId: string): Promise<boolean> {
    return this.locks.isLocked(userId);
  }

  async execute(userId: string): Promise<GmailImportResult> {
    const lock = await this.locks.acquireLock(userId);
    if (!lock) {
      throw new ConflictError(
        'IMPORT_IN_PROGRESS',
        'A receipt import is already running for your account. Please wait for it to complete.',
      );
    }
    try {
      return await this.executeWithLock(userId, lock);
    } finally {
      await this.locks.releaseLock(lock);
    }
  }

  async executeWithLock(userId: string, lock: ImportLockHandle, execution?: ImportExecutionCheckpoint): Promise<GmailImportResult> {
    const { user, health, status } = await this.status.getConnection(userId, true);
    if (health.status === 'reconnect_required' || status.needsReconnect) {
      throw new ConflictError(
        'GMAIL_RECONNECT_REQUIRED',
        'Your Gmail authorization is no longer valid. Reconnect Gmail to continue.',
      );
    }
    if (health.status === 'unavailable') {
      throw new AppError({
        code: 'GMAIL_VALIDATION_UNAVAILABLE',
        message: 'Gmail could not be reached to verify the connection. Please try again shortly.',
      });
    }
    if (!status.canImport) {
      throw new ValidationError('Gmail account is not connected for receipt imports.');
    }

    return this.runLocked(userId, lock, user, execution);
  }

  private async runLocked(
    userId: string,
    lock: ImportLockHandle,
    user: Parameters<ImportPort['importFromGmail']>[0],
    execution?: ImportExecutionCheckpoint,
  ): Promise<GmailImportResult> {
    this.logger.info('Gmail import started', {
        userId,
        operation: 'gmail_historical_import',
        outcome: 'started',
      });
      const result = await this.gmailImport.importFromGmail(user, lock, 'manual', execution);
      this.logger.info('Gmail import finished', {
        userId,
        operation: 'gmail_historical_import',
        outcome: result.success ? 'success' : 'failure',
        emailsFound: result.totalEmailsFound,
        receiptsProcessed: result.totalReceiptsProcessed,
        receiptsImported: result.totalReceiptsImported,
        errorCode: result.errorCode,
      });
      if (!result.success) {
        if (result.errorCode === 'GMAIL_RECONNECT_REQUIRED') {
          throw new ConflictError(
            'GMAIL_RECONNECT_REQUIRED',
            'Your Gmail authorization is no longer valid. Reconnect Gmail to continue.',
          );
        }
        if (result.errorCode === 'GMAIL_RATE_LIMITED' || result.errorCode === 'GMAIL_ACCESS_BLOCKED') {
          throw new AppError({
            code: result.errorCode,
            message: 'Gmail message access failed',
            publicMessage: result.errorCode === 'GMAIL_RATE_LIMITED'
              ? 'Your receipt import couldn’t finish right now. Please wait a little before trying again. Your email connection is still active.'
              : 'Google blocked access to receipt messages. This may be an account policy or app configuration issue. Your Gmail connection has been kept.',
            details: result.failureDetails ?? undefined,
          });
        }
        throw new AppError({
          code: 'GMAIL_IMPORT_FAILED',
          message: 'Gmail import failed',
          publicMessage: 'Gmail import failed. Please try again.',
          details: result.errorCode ? { providerCode: result.errorCode } : undefined,
        });
      }
    return result;
  }
}
