import type { ImportStatusService } from './ImportStatusService';
import type { ExportReadyAlertService } from './ExportReadyAlertService';
import type { GmailPushJobPort, GmailPushStatePort } from '../ports/GmailPushPorts';

export class GmailPushDispatchService {
  constructor(
    private readonly pushes: Pick<GmailPushStatePort, 'claimDue'|'markDispatched'|'releaseDispatch'>,
    private readonly jobs: GmailPushJobPort,
    private readonly status?: Pick<ImportStatusService, 'getPreferences'>,
    private readonly alerts?: Pick<ExportReadyAlertService, 'enqueueEligible'>,
  ) {}

  async dispatchDue(limit = 500): Promise<{ claimed: number; queued: number; deferred: number }> {
    const due = await this.pushes.claimDue(limit);
    let queued = 0;
    let deferred = 0;
    for (const wakeup of due) {
      try {
        await this.alerts?.enqueueEligible(2, wakeup.userId, undefined, `gmail:${wakeup.historyId ?? wakeup.notificationCount}`);
        const preferences = await this.status?.getPreferences(wakeup.userId);
        if (preferences && preferences.ongoingTracking.consentState !== 'granted') {
          await this.pushes.markDispatched(wakeup.userId, wakeup.historyId, wakeup.notificationCount);
          queued += 1;
          continue;
        }
        await this.jobs.create({
          userId: wakeup.userId,
          kind: 'gmail_push_tracking',
          trigger: 'scheduler',
          journeyContext: 'routine',
          // A provider history ID makes crash recovery idempotent. Incrementing
          // the suffix after a failed execution permits a fresh durable job once
          // the queue has exhausted the prior job's own retry policy.
          idempotencyKey: `gmail-push:${wakeup.historyId ?? 'watch'}:${wakeup.failureCount}`,
          initialCheckpoint: { provider: 'gmail_push', version: 1, historyId: wakeup.historyId },
        });
        await this.pushes.markDispatched(wakeup.userId, wakeup.historyId, wakeup.notificationCount);
        queued += 1;
      } catch (error) {
        await this.pushes.releaseDispatch(
          wakeup.userId,
          error instanceof Error ? error.name : 'GMAIL_PUSH_DISPATCH_FAILED',
        );
        deferred += 1;
      }
    }
    return { claimed: due.length, queued, deferred };
  }
}
