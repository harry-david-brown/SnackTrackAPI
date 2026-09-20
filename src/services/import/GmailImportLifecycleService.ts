import type { GmailSyncRunPort, ImportLifecyclePort, MailboxUserPort } from '../ports/ImportPorts';
import type { SyncRunCounts } from './ImportLifecycleTypes';

type SyncRuns = Pick<GmailSyncRunPort, 'startSyncRun' | 'completeSyncRun' | 'failSyncRun'>;
type Lifecycle = Pick<ImportLifecyclePort, 'markTrackingReconnectRequired'>;
type Users = Pick<MailboxUserPort, 'markGmailReconnectRequired'>;

/** Owns durable Gmail sync-run transitions and reconnect-state persistence. */
export class GmailImportLifecycleService {
  constructor(
    private readonly syncRuns: SyncRuns,
    private readonly lifecycle: Lifecycle,
    private readonly users: Users,
  ) {}

  start(userId: string, trigger: 'manual' | 'background', importJobId?: string): Promise<string> {
    return this.syncRuns.startSyncRun(userId, trigger, importJobId);
  }

  complete(
    syncRunId: string,
    userId: string,
    outcome: 'success' | 'partial',
    counts: SyncRunCounts,
    trigger: 'manual' | 'background',
  ): Promise<void> {
    return this.syncRuns.completeSyncRun(syncRunId, userId, outcome, counts, trigger);
  }

  fail(
    syncRunId: string,
    userId: string,
    errorCode: string,
    trigger: 'manual' | 'background',
  ): Promise<void> {
    return this.syncRuns.failSyncRun(syncRunId, userId, errorCode, trigger);
  }

  async markReconnectRequired(userId: string): Promise<void> {
    await this.users.markGmailReconnectRequired(userId);
    await this.lifecycle.markTrackingReconnectRequired(userId);
  }
}
