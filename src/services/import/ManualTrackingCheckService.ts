import { ConflictError } from '../../core/errors';
import type { ImportPreferencesProjection } from './ImportStatusService';
import type { GmailImportResult } from './GmailImportService';
import type { ImportPreferencesService } from './ImportPreferencesService';
import type { OngoingTrackingService } from './OngoingTrackingService';

type TrackingPort = Pick<OngoingTrackingService, 'checkUser'>;
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
    if (!result) {
      throw new ConflictError(
        'TRACKING_NOT_AVAILABLE',
        'Ongoing tracking is not enabled, Gmail needs reconnection, or a check is already running.',
      );
    }
    return { ...result, preferences: await this.preferences.get(userId) };
  }
}
