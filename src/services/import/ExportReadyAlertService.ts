import { BACKGROUND_ALERT_CONSENT_VERSION } from '../data/ExportReadyAlertRepository';
import { ConflictError } from '../../core/errors';
import type { ExportReadyAlertRepository } from '../data/ExportReadyAlertRepository';
import type { ImportJobRepository } from '../data/ImportJobRepository';
import type { ImportStatusService } from './ImportStatusService';
import type { ImportJob } from './ImportJobTypes';
import type { ExportProvider } from './ImportLifecycleTypes';
import type { User } from '../../models/User';
import { ImportLockService, type ImportLockHandle } from './ImportLockService';

export class ExportReadyAlertService {
  constructor(
    private readonly alerts: Pick<ExportReadyAlertRepository, 'due' | 'scheduled'>,
    private readonly jobs: Pick<ImportJobRepository, 'create'>,
    private readonly status: Pick<ImportStatusService, 'getPreferences' | 'getConnection'>,
    private readonly gmail: {
      hasExportReadyEmail(
        user: User,
        requestedAt: string,
        provider: ExportProvider,
      ): Promise<boolean>;
    },
    private readonly outlook: {
      hasExportReadyEmail(
        userId: string,
        requestedAt: string,
        provider: ExportProvider,
      ): Promise<boolean>;
    },
    readonly enabled: boolean,
  ) {}

  async enqueueEligible(
    limit = 500,
    userId?: string,
    provider?: ExportProvider,
    wakeupIdentity?: string,
  ): Promise<number> {
    if (!this.enabled) return 0;
    let queued = 0;
    for (const candidate of await this.alerts.due(limit, userId)) {
      if (provider && candidate.provider !== provider) continue;
      try {
        await this.jobs.create({
          userId: candidate.userId,
          kind: 'export_ready_check',
          trigger: 'scheduler',
          journeyContext: 'routine',
          exportProvider: candidate.provider,
          initialCheckpoint: { requestId: candidate.requestId },
          idempotencyKey: `ready:${candidate.provider}:${candidate.requestId}:${wakeupIdentity ?? Math.floor(Date.now() / 900000)}`,
        });
        await this.alerts.scheduled(candidate);
        queued++;
      } catch (error) {
        if (!(error instanceof ConflictError) && (error as { code?: string }).code !== '23505')
          throw error;
      }
    }
    return queued;
  }

  async execute(
    job: ImportJob,
    lock: ImportLockHandle,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!this.enabled || !job.exportProvider) return { success: true, skipped: true };
    const prefs = await this.status.getPreferences(job.userId);
    const provider = job.exportProvider;
    const state =
      provider === 'uber_eats' ? prefs.export.providers.uberEats : prefs.export.providers.doorDash;
    if (
      state.status !== 'requested' ||
      !state.requestedAt ||
      state.requestId !== job.checkpoint.requestId ||
      state.readyAlert?.consentState !== 'granted' ||
      state.readyAlert.consentVersion !== BACKGROUND_ALERT_CONSENT_VERSION
    )
      return { success: true, skipped: true };
    let detected = false;
    let failure: unknown;
    if (
      prefs.gmailConnection.connectionHealth === 'valid' &&
      prefs.gmailConnection.connectionMode === 'offline'
    ) {
      try {
        detected = await this.gmail.hasExportReadyEmail(
          (await this.status.getConnection(job.userId)).user,
          state.requestedAt,
          provider,
        );
      } catch (error) {
        failure = error;
      }
    }
    if (
      !detected &&
      prefs.outlookConnection.connectionHealth === 'valid' &&
      prefs.outlookConnection.connectionMode === 'offline'
    ) {
      try {
        detected = await this.outlook.hasExportReadyEmail(job.userId, state.requestedAt, provider);
      } catch (error) {
        failure = error;
      }
    }
    if (!detected && failure) throw failure;
    await ImportLockService.assertLockOwned(lock);
    // The worker repository commits the guarded ready transition and notify outbox atomically.
    return { success: true, exportReadyDetected: detected, provider, requestId: state.requestId };
  }
}
