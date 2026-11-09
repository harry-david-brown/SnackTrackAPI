import type {
  ImportLifecyclePort,
  ImportPreferencesQueryPort,
  MailboxUserPort,
  MicrosoftMailboxConnectionPort,
  ReceiptWriterLockPort,
} from '../ports/ImportPorts';
import { GmailImportService, GmailImportResult, MailboxImportOutcome } from './GmailImportService';
import type { OutlookImportService } from './OutlookImportService';
import type { ImportLockHandle } from './ImportLockService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';
import type { ReceiptImportOutcomePort } from '../ports/ReceiptPorts';
import { receiptImportOutcomeFields } from './ReceiptImportOutcome';

/** Runs consented receipt checks from either the app or an external scheduler. */
export class OngoingTrackingService {
  constructor(
    private readonly users: Pick<MailboxUserPort, 'findById' | 'findByIdWithGmailTokens'>,
    private readonly queries: Pick<
      ImportPreferencesQueryPort,
      'get' | 'getTrackingBaseline'
    >,
    private readonly lifecycle: Pick<
      ImportLifecyclePort,
      'markTrackingReconnectRequired' | 'markTrackingError'
    >,
    private readonly gmailImport: GmailImportService,
    private readonly locks: Pick<ReceiptWriterLockPort, 'acquireLock' | 'releaseLock' | 'assertLockOwned'>,
    private readonly mailboxConnections?: Pick<MicrosoftMailboxConnectionPort, 'findMicrosoft'>,
    private readonly outlookImport?: Pick<OutlookImportService, 'importFromOutlook'>,
    private readonly outcomes?: ReceiptImportOutcomePort,
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
    return this.checkUserProviders(userId, lockHandle, execution, { gmail: true, microsoft: true });
  }

  /** Gmail-only path used by Gmail push notifications; it never wakes Outlook. */
  async checkGmailUserWithLock(userId: string, lockHandle: ImportLockHandle, execution?: ImportExecutionCheckpoint): Promise<GmailImportResult | null> {
    return this.checkUserProviders(userId, lockHandle, execution, { gmail: true, microsoft: false });
  }

  async checkOutlookUserWithLock(userId: string, lockHandle: ImportLockHandle, execution?: ImportExecutionCheckpoint): Promise<GmailImportResult | null> {
    return this.checkUserProviders(userId, lockHandle, execution, { gmail: false, microsoft: true });
  }

  private async checkUserProviders(
    userId: string,
    lockHandle: ImportLockHandle,
    execution: ImportExecutionCheckpoint | undefined,
    providers: { readonly gmail: boolean; readonly microsoft: boolean },
  ): Promise<GmailImportResult | null> {
    const [user, preferences, microsoft] = await Promise.all([
      this.users.findByIdWithGmailTokens(userId),
      this.queries.get(userId),
      this.mailboxConnections?.findMicrosoft(userId),
    ]);
    if (!user || user.deletionRequested || preferences.ongoingTrackingConsentState !== 'granted') return null;
    const baseline = await this.queries.getTrackingBaseline(userId);
    if (!baseline.eligible) return null;

    const durableGmail = Boolean(
      user.gmailConnected && user.gmailConnectionMode === 'offline' && user.gmailRefreshToken,
    );
    const durableMicrosoft = Boolean(
      microsoft && microsoft.state === 'connected' && microsoft.connectionMode === 'offline',
    );
    if ((!providers.gmail || !durableGmail) && (!providers.microsoft || !durableMicrosoft)) {
      await this.lifecycle.markTrackingReconnectRequired(userId);
      return null;
    }

    const results: GmailImportResult[] = [];
    const mailboxOutcomes: MailboxImportOutcome[] = [];
    const record = (mailbox: 'gmail' | 'outlook', email: string | null, result: GmailImportResult) => {
      results.push(result);
      mailboxOutcomes.push({ mailbox, email, success: result.success, newOrders: result.newOrders,
        updatedOrders: result.updatedOrders, unchangedOrders: result.unchangedOrders, errorCode: result.errorCode });
    };
      await execution?.assertActive?.();
      const scopedExecutions = this.providerExecutions(execution);
      if (providers.gmail && durableGmail) {
        record('gmail', user.gmailEmail ?? null, await this.gmailImport.importFromGmail(user, lockHandle, 'background', scopedExecutions.gmail));
      }
      if (providers.microsoft && durableMicrosoft && this.outlookImport) {
        await execution?.assertActive?.();
        await this.locks.assertLockOwned(lockHandle);
        record('outlook', microsoft?.email ?? null, await this.outlookImport.importFromOutlook(user, lockHandle, 'background', scopedExecutions.microsoft));
      }
      await execution?.assertActive?.();
      let combined = this.combineResults(results);
      if (combined) combined = { ...combined, mailboxOutcomes };
      if (combined && execution?.accountingJobId) {
        if (!this.outcomes) throw new Error('Canonical import outcome service is unavailable');
        const outcome = await this.outcomes.getImportOutcome(userId, execution.accountingJobId, () => this.locks.assertLockOwned(lockHandle));
        combined = { ...combined, ...receiptImportOutcomeFields(outcome) };
      }
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
      assertActive: execution.assertActive,
      ...(execution.accountingJobId ? { accountingJobId: execution.accountingJobId } : {}),
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
      totalAmount: results.some(result => result.totalAmount === null) ? null : results.reduce((sum, result) => sum + (result.totalAmount ?? 0), 0),
      errors: results.flatMap((result) => result.errors),
      receipts: results.flatMap((result) => result.receipts),
      newOrders: results.reduce((sum, result) => sum + result.newOrders, 0),
      unresolvedOrders: results[results.length-1]?.unresolvedOrders ?? 0,
      updatedOrders: results.reduce((sum, result) => sum + result.updatedOrders, 0),
      unchangedOrders: results.reduce((sum, result) => sum + result.unchangedOrders, 0),
      errorCode: results.find((result) => result.errorCode)?.errorCode ?? null,
    };
  }

}
