import type { GmailPushStatePort } from '../ports/GmailPushPorts';
import type { ImportLockHandle } from './ImportLockService';
import type { ImportExecutionCheckpoint } from './ImportJobTypes';
import type { ImportPreferencesService } from './ImportPreferencesService';
import type { OngoingTrackingService } from './OngoingTrackingService';
import { AppError } from '../../core/errors';
import type { GmailWatchService } from './GmailWatchService';

export class GmailPushTrackingService {
  constructor(
    private readonly preferences: Pick<ImportPreferencesService, 'get'>,
    private readonly tracking: Pick<OngoingTrackingService, 'checkGmailUserWithLock'>,
    private readonly pushes: Pick<GmailPushStatePort, 'markProcessed'|'releaseDispatch'>,
    private readonly watches: Pick<GmailWatchService, 'stopForUser'>,
    private readonly exportAlerts?: {enqueueEligible(limit: number,userId: string):Promise<number>},
  ) {}

  async executeWithLock(
    userId: string,
    lock: ImportLockHandle,
    execution: ImportExecutionCheckpoint,
  ): Promise<Readonly<Record<string, unknown>>> {
    const historyId = typeof execution.checkpoint.historyId === 'string'
      ? execution.checkpoint.historyId
      : null;
    try {
      await this.exportAlerts?.enqueueEligible(2,userId);
      const preferences = await this.preferences.get(userId);
      const tracking = await this.tracking.checkGmailUserWithLock(userId, lock, execution);
      if (tracking && !tracking.success) {
        throw new AppError({
          code: tracking.errorCode ?? 'GMAIL_PUSH_TRACKING_FAILED',
          message: 'Gmail push tracking failed',
        });
      }
      await this.pushes.markProcessed(userId);
      if (preferences.ongoingTracking.consentState !== 'granted' &&
        !Object.values(preferences.export.providers).some(p=>p.status==='requested' && p.readyAlert?.consentState==='granted')) {
        await this.watches.stopForUser(userId);
      }
      return {
        success: true,
        exportReadyDetected: false,
        newOrders: tracking?.newOrders ?? 0,
        updatedOrders: tracking?.updatedOrders ?? 0,
        unchangedOrders: tracking?.unchangedOrders ?? 0,
      };
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'GMAIL_PUSH_TRACKING_FAILED';
      await this.pushes.releaseDispatch(userId, code);
      throw error;
    }
  }
}
