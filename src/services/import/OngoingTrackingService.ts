import { PostgresService } from '../data/PostgresService';
import { UserRepository } from '../data/UserRepository';
import { ImportPreferencesRepository } from '../data/ImportPreferencesRepository';
import { GmailImportService, GmailImportResult } from './GmailImportService';
import { ImportLockService } from './ImportLockService';

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
  private users: UserRepository;
  private preferences: ImportPreferencesRepository;
  private batchRunning = false;

  constructor(private postgres: PostgresService) {
    this.users = new UserRepository(postgres);
    this.preferences = new ImportPreferencesRepository(postgres);
  }

  async checkUser(userId: string): Promise<GmailImportResult | null> {
    const [user, preferences] = await Promise.all([
      this.users.findByIdWithGmailTokens(userId),
      this.preferences.get(userId),
    ]);
    if (
      !user
      || preferences.gmailImportStatus !== 'completed'
      || preferences.ongoingTrackingConsentState !== 'granted'
    ) return null;

    const durableConnection = Boolean(
      user.gmailConnected
      && user.gmailConnectionMode === 'offline'
      && user.gmailRefreshToken
    );
    if (!durableConnection) {
      await this.preferences.markTrackingReconnectRequired(userId);
      return null;
    }

    if (!await ImportLockService.acquireLock(userId)) return null;
    try {
      return await new GmailImportService(this.postgres).importFromGmail(user, 'background');
    } finally {
      await ImportLockService.releaseLock(userId);
    }
  }

  async runEligibleBatch(limit = 100): Promise<TrackingBatchResult> {
    if (this.batchRunning) {
      return { eligible: 0, checked: 0, skipped: 1, failed: 0, newOrders: 0, updatedOrders: 0 };
    }
    this.batchRunning = true;
    try {
      const userIds = await this.preferences.getEligibleTrackingUserIds(Math.max(1, Math.min(limit, 500)));
      const summary: TrackingBatchResult = {
        eligible: userIds.length,
        checked: 0,
        skipped: 0,
        failed: 0,
        newOrders: 0,
        updatedOrders: 0,
      };

      // Deliberately sequential to stay within Gmail and database rate limits.
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
        } catch {
          summary.failed++;
        }
      }
      return summary;
    } finally {
      this.batchRunning = false;
    }
  }
}
