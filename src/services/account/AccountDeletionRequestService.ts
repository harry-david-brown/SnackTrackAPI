import { AppError } from '../../core/errors';
import type { AccountDeletionRequestPort } from '../ports/AccountDeletionPort';
import type { StructuredLogger } from '../core/StructuredLogger';
import type { AccountDeletionService } from './AccountDeletionService';

export interface AccountDeletionAccepted {
  success: true;
  status: 'pending';
  message: string;
}

export class AccountDeletionRequestService {
  constructor(
    private readonly requests: AccountDeletionRequestPort,
    private readonly deletion: Pick<AccountDeletionService, 'deleteAccount'>,
    private readonly logger: StructuredLogger,
  ) {}

  async request(userId: string): Promise<AccountDeletionAccepted> {
    await this.requests.request(userId);
    return { success: true, status: 'pending',
      message: 'Your account deletion has been requested. Imports are cancelled and deletion will continue even if you close the app.' };
  }

  /** Multiple workers may scan the queue; the existing account lock serializes finalization. */
  async processPending(limit = 20): Promise<void> {
    for (const userId of await this.requests.due(limit)) {
      try {
        // Do not hold a worker slot waiting for an import to reach its cancellation boundary.
        await this.deletion.deleteAccount(userId, undefined, undefined, 0);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'ACCOUNT_DELETION_RETRY';
        await this.requests.defer(userId, code);
        this.logger.warn('Account deletion will retry', { userId, operation: 'account_deletion', errorCode: code });
      }
    }
  }
}
