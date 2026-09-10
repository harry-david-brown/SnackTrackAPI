import { ConflictError } from '../../core/errors';
import type { ImportPreferencesQueryPort, ScheduledImportJobPort } from '../ports/ImportPorts';

export interface ScheduledImportBatchResult {
  readonly eligible: number;
  readonly queued: number;
  readonly skipped: number;
}

export class ScheduledImportJobService {
  constructor(
    private readonly preferences: Pick<ImportPreferencesQueryPort, 'getEligibleOutlookTrackingUserIds'>,
    private readonly jobs: ScheduledImportJobPort,
  ) {}

  async enqueueEligible(limit = 100): Promise<ScheduledImportBatchResult> {
    const userIds = await this.preferences.getEligibleOutlookTrackingUserIds(Math.max(1, Math.min(limit, 500)));
    let queued = 0;
    let skipped = 0;
    for (const userId of userIds) {
      try {
        await this.jobs.create({
          userId,
          kind: 'scheduled_tracking',
          trigger: 'scheduler',
          journeyContext: 'routine',
          idempotencyKey: `scheduled:${new Date().toISOString().slice(0, 13)}`,
        });
        queued += 1;
      } catch (error) {
        if (error instanceof ConflictError) skipped += 1;
        else throw error;
      }
    }
    return { eligible: userIds.length, queued, skipped };
  }
}
