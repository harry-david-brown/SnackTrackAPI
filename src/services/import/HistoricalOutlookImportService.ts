import { AppError, ConflictError, ValidationError } from '../../core/errors';
import type { MailboxUserPort, MicrosoftMailboxHealthPort } from '../ports/ImportPorts';
import type { GmailImportResult } from './GmailImportService';
import type { ImportLockHandle, ImportLockService } from './ImportLockService';
import type { OutlookImportService } from './OutlookImportService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';

export class HistoricalOutlookImportService {
  constructor(
    private readonly users: Pick<MailboxUserPort, 'findById'>,
    private readonly health: MicrosoftMailboxHealthPort,
    private readonly outlookImport: Pick<OutlookImportService, 'importFromOutlook'>,
    private readonly locks: Pick<
      typeof ImportLockService,
      'acquireLock' | 'releaseLock' | 'isLocked'
    >,
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
    const user = await this.users.findById(userId);
    if (!user) throw new ValidationError('User not found');
    const { connection, health } = await this.health.validate(userId, true);
    const status = this.health.buildStatus(connection, health);
    if (status.needsReconnect) {
      throw new ConflictError(
        'OUTLOOK_RECONNECT_REQUIRED',
        'Your Outlook authorization is no longer valid. Reconnect Outlook to continue.',
      );
    }
    if (health.status === 'unavailable') {
      throw new AppError({
        code: 'OUTLOOK_VALIDATION_UNAVAILABLE',
        message: 'Outlook could not be reached to verify the connection',
        publicMessage: 'Outlook could not be reached. Please try again shortly.',
      });
    }
    if (!status.canImport) {
      throw new ValidationError('Outlook is not connected for receipt imports.');
    }
    const result = await this.outlookImport.importFromOutlook(user, lock, 'manual', execution);
      if (!result.success) {
        if (result.errorCode === 'OUTLOOK_RECONNECT_REQUIRED') {
          throw new ConflictError(
            'OUTLOOK_RECONNECT_REQUIRED',
            'Your Outlook authorization is no longer valid. Reconnect Outlook to continue.',
          );
        }
        throw new AppError({
          code: result.errorCode ?? 'OUTLOOK_IMPORT_FAILED',
          message: 'Outlook import failed',
          publicMessage: 'Outlook import failed. Please try again.',
          details: result.errorCode ? { providerCode: result.errorCode } : undefined,
        });
      }
    return result;
  }
}
