import { UserRepository } from '../data/UserRepository';
import { ImportPreferencesRepository } from '../data/ImportPreferencesRepository';
import { GmailImportService, GmailImportResult } from './GmailImportService';
import { ImportLockService } from './ImportLockService';
import logger from '../../config/logger';

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
    private readonly users: UserRepository,
    private readonly preferences: ImportPreferencesRepository,
    private readonly gmailImport: GmailImportService,
  ) {}

  async checkUser(userId: string): Promise<GmailImportResult | null> {
    const [user, preferences] = await Promise.all([
      this.users.findByIdWithGmailTokens(userId),
      this.preferences.get(userId),
    ]);
    if (
      !user
      || preferences.ongoingTrackingConsentState !== 'granted'
    ) return null;
    const baseline = await this.preferences.getTrackingBaseline(userId);
    if (!baseline.eligible) return null;

    const durableConnection = Boolean(
      user.gmailConnected
      && user.gmailConnectionMode === 'offline'
      && user.gmailRefreshToken
    );
    if (!durableConnection) {
      await this.preferences.markTrackingReconnectRequired(userId);
      return null;
    }

    const lockHandle = await ImportLockService.acquireLock(userId);
    if (!lockHandle) return null;
    try {
      return await this.gmailImport.importFromGmail(user, lockHandle, 'background');
    } finally {
      await ImportLockService.releaseLock(lockHandle);
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
        } catch (error) {
          summary.failed++;
          logger.warn('Background Gmail tracking failed for user', {
            userId,
            operation: 'gmail_tracking',
            outcome: 'failure',
            error,
          });
        }
      }
      logger.info('Background Gmail tracking batch finished', {
        operation: 'gmail_tracking_batch',
        outcome: summary.failed > 0 ? 'partial_failure' : 'success',
        ...summary,
      });
      return summary;
    } finally {
      this.batchRunning = false;
    }
  }
}
