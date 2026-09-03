import type {
  ImportLifecyclePort,
  ImportPreferencesQueryPort,
  MailboxUserPort,
  MicrosoftMailboxConnectionPort,
  ReceiptWriterLockPort,
} from '../ports/ImportPorts';
import { GmailImportService, GmailImportResult } from './GmailImportService';
import logger from '../../config/logger';
import type { OutlookImportService } from './OutlookImportService';
import type { ImportLockHandle } from './ImportLockService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';

export interface TrackingBatchResult {
  eligible: number;
  checked: number;
  skipped: number;
  failed: number;
  newOrders: number;
  updatedOrders: number;
}

/** Runs consented receipt checks from either the app or an external scheduler. */
export class OngoingTrackingService {
  private batchRunning = false;

  constructor(
    private readonly users: Pick<MailboxUserPort, 'findById' | 'findByIdWithGmailTokens'>,
    private readonly queries: Pick<
      ImportPreferencesQueryPort,
      'get' | 'getTrackingBaseline' | 'getEligibleTrackingUserIds'
    >,
    private readonly lifecycle: Pick<
      ImportLifecyclePort,
      'markTrackingReconnectRequired' | 'markTrackingError'
    >,
    private readonly gmailImport: GmailImportService,
    private readonly locks: Pick<ReceiptWriterLockPort, 'acquireLock' | 'releaseLock'>,
    private readonly mailboxConnections?: Pick<MicrosoftMailboxConnectionPort, 'findMicrosoft'>,
    private readonly outlookImport?: Pick<OutlookImportService, 'importFromOutlook'>,
  ) {}

  async checkUser(userId: string): Promise<GmailImportResult | null> {
    const lockHandle = await this.locks.acquireLock(userId);
    if (!lockHandle) return null;
    try {
      return await this.checkUserWithLock(userId, lockHandle);
    } finally {
      await this.locks.releaseLock(lockHandle);
    }
  }

  async checkUserWithLock(userId: string, lockHandle: ImportLockHandle, execution?: ImportExecutionCheckpoint): Promise<GmailImportResult | null> {
    const [user, preferences, microsoft] = await Promise.all([
      this.users.findByIdWithGmailTokens(userId),
      this.queries.get(userId),
      this.mailboxConnections?.findMicrosoft(userId),
    ]);
    if (!user || preferences.ongoingTrackingConsentState !== 'granted') return null;
    const baseline = await this.queries.getTrackingBaseline(userId);
    if (!baseline.eligible) return null;

    const durableGmail = Boolean(
      user.gmailConnected && user.gmailConnectionMode === 'offline' && user.gmailRefreshToken,
    );
    const durableMicrosoft = Boolean(
      microsoft && microsoft.state === 'connected' && microsoft.connectionMode === 'offline',
    );
    if (!durableGmail && !durableMicrosoft) {
      await this.lifecycle.markTrackingReconnectRequired(userId);
      return null;
    }

    const results: GmailImportResult[] = [];
      const scopedExecutions = this.providerExecutions(execution);
      if (durableGmail) {
        results.push(await this.gmailImport.importFromGmail(user, lockHandle, 'background', scopedExecutions.gmail));
      }
      if (durableMicrosoft && this.outlookImport) {
        results.push(await this.outlookImport.importFromOutlook(user, lockHandle, 'background', scopedExecutions.microsoft));
      }
      const combined = this.combineResults(results);
      if (combined && !combined.success) {
        const errorCode = combined.errorCode ?? 'MAILBOX_TRACKING_FAILED';
        if (errorCode.includes('RECONNECT_REQUIRED')) {
          await this.lifecycle.markTrackingReconnectRequired(userId);
        } else {
          await this.lifecycle.markTrackingError(userId, errorCode);
        }
      }
    return combined;
  }

  private providerExecutions(
    execution: ImportExecutionCheckpoint | undefined,
  ): Record<'gmail' | 'microsoft', ImportExecutionCheckpoint | undefined> {
    if (!execution) return { gmail: undefined, microsoft: undefined };
    let root: Readonly<Record<string, unknown>> = execution.checkpoint.provider === 'tracking'
      ? execution.checkpoint
      : { provider: 'tracking', version: 1 };
    const scoped = (provider: 'gmail' | 'microsoft'): ImportExecutionCheckpoint => ({
      checkpoint: typeof root[provider] === 'object' && root[provider] !== null
        ? root[provider] as Readonly<Record<string, unknown>>
        : {},
      save: async (checkpoint, phase, progress) => {
        root = { ...root, provider: 'tracking', version: 1, [provider]: checkpoint };
        await execution.save(root, `${provider}_${phase}`, progress);
      },
    });
    return { gmail: scoped('gmail'), microsoft: scoped('microsoft') };
  }

  private combineResults(results: readonly GmailImportResult[]): GmailImportResult | null {
    if (!results.length) return null;
    return {
      success: results.every((result) => result.success),
      totalEmailsFound: results.reduce((sum, result) => sum + result.totalEmailsFound, 0),
      totalReceiptsProcessed: results.reduce(
        (sum, result) => sum + result.totalReceiptsProcessed,
        0,
      ),
      emailsExamined: results.reduce((sum, result) => sum + result.emailsExamined, 0),
      supportedReceiptsFound: results.reduce(
        (sum, result) => sum + result.supportedReceiptsFound,
        0,
      ),
      exportCoveredReceipts: results.reduce((sum, result) => sum + result.exportCoveredReceipts, 0),
      eligibleReceipts: results.reduce((sum, result) => sum + result.eligibleReceipts, 0),
      deduplicatedReceipts: results.reduce((sum, result) => sum + result.deduplicatedReceipts, 0),
      totalReceiptsImported: results.reduce((sum, result) => sum + result.totalReceiptsImported, 0),
      totalAmount: results.reduce((sum, result) => sum + result.totalAmount, 0),
      errors: results.flatMap((result) => result.errors),
      receipts: results.flatMap((result) => result.receipts),
      newOrders: results.reduce((sum, result) => sum + result.newOrders, 0),
      updatedOrders: results.reduce((sum, result) => sum + result.updatedOrders, 0),
      unchangedOrders: results.reduce((sum, result) => sum + result.unchangedOrders, 0),
      errorCode: results.find((result) => result.errorCode)?.errorCode ?? null,
    };
  }

  async runEligibleBatch(limit = 100): Promise<TrackingBatchResult> {
    if (this.batchRunning) {
      return { eligible: 0, checked: 0, skipped: 1, failed: 0, newOrders: 0, updatedOrders: 0 };
    }
    this.batchRunning = true;
    try {
      const userIds = await this.queries.getEligibleTrackingUserIds(
        Math.max(1, Math.min(limit, 500)),
      );
      const summary: TrackingBatchResult = {
        eligible: userIds.length,
        checked: 0,
        skipped: 0,
        failed: 0,
        newOrders: 0,
        updatedOrders: 0,
      };

      // Deliberately sequential to stay within mailbox-provider and database rate limits.
      for (const userId of userIds) {
        try {
          const result = await this.checkUser(userId);
          if (!result) {
            summary.skipped++;
            continue;
          }
          summary.checked++;
          summary.newOrders += result.newOrders;
          summary.updatedOrders += result.updatedOrders;
          if (!result.success) summary.failed++;
        } catch (error) {
          summary.failed++;
          logger.warn('Background mailbox tracking failed for user', {
            userId,
            operation: 'mailbox_tracking',
            outcome: 'failure',
            error,
          });
        }
      }
      logger.info('Background mailbox tracking batch finished', {
        operation: 'mailbox_tracking_batch',
        outcome: summary.failed > 0 ? 'partial_failure' : 'success',
        ...summary,
      });
      return summary;
    } finally {
      this.batchRunning = false;
    }
  }
}
