import { ConflictError } from '../../core/errors';
import type { ImportPreferencesProjection } from './ImportStatusService';
import type { GmailImportResult } from './GmailImportService';
import type { ImportPreferencesService } from './ImportPreferencesService';
import type { OngoingTrackingService } from './OngoingTrackingService';
import type { ImportLockHandle } from './ImportLockService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';

type TrackingPort = Pick<OngoingTrackingService, 'checkUser' | 'checkUserWithLock'>;
type PreferencesPort = Pick<ImportPreferencesService, 'get'>;

export type ManualTrackingCheckResult = GmailImportResult & {
  readonly preferences: ImportPreferencesProjection;
};

/** Owns one user-triggered ongoing check and its committed state projection. */
export class ManualTrackingCheckService {
  constructor(
    private readonly tracking: TrackingPort,
    private readonly preferences: PreferencesPort,
  ) {}

  async execute(userId: string): Promise<ManualTrackingCheckResult> {
    const result = await this.tracking.checkUser(userId);
    return this.buildResult(userId, result);
  }

  async executeWithLock(userId: string, lock: ImportLockHandle, execution?: ImportExecutionCheckpoint): Promise<ManualTrackingCheckResult> {
    const result = await this.tracking.checkUserWithLock(userId, lock, execution);
    return this.buildResult(userId, result);
  }

  private async buildResult(userId: string, result: Awaited<ReturnType<OngoingTrackingService['checkUser']>>): Promise<ManualTrackingCheckResult> {
    if (!result) {
      throw new ConflictError(
        'TRACKING_NOT_AVAILABLE',
        'Ongoing tracking is not enabled, Gmail needs reconnection, or a check is already running.',
      );
    }
    return { ...result, preferences: await this.preferences.get(userId) };
  }
}
