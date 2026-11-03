import type { ExportReadyAlertRepository } from '../data/ExportReadyAlertRepository';
import { BACKGROUND_ALERT_CONSENT_VERSION } from '../data/ExportReadyAlertRepository';
import { ImportLockService } from './ImportLockService';
import { AppError, ConflictError } from '../../core/errors';
import type { User } from '../../models/User';
import type {
  ConsentDecision,
  ExportProvider,
  ImportPreferences,
  ImportSetupGuidance,
  MonitoringConsentState,
  ProviderExportPreference,
  ProviderRelevance,
} from './ImportLifecycleTypes';
import type {
  ImportLifecyclePort,
  ImportPreferencesQueryPort,
  ImportSourceCoveragePort,
} from '../ports/ImportPorts';
import type { ImportPreferencesProjection, ImportStatusService } from './ImportStatusService';

type LifecyclePort = Pick<
  ImportLifecyclePort,
  | 'markAutomaticUpdatesOfferSeen'
  | 'setMonitoringConsent'
  | 'setOngoingTrackingConsent'
  | 'markExportRequested'
  | 'confirmExportReady'
  | 'setExportStatus'
  | 'setInitialSetupDeferral'
  | 'setProviderRelevance'
>;
type PreferencesQueryPort = Pick<
  ImportPreferencesQueryPort,
  'getTrackingBaseline' | 'get' | 'getProviderExports' | 'getSetupGuidance'
>;
type SourceCoveragePort = Pick<ImportSourceCoveragePort, 'getForUser'>;

type StatusPort = Pick<ImportStatusService, 'getPreferences' | 'getConnection'>;

interface ExportReadyDetector {
  hasUberExportReadyEmail(user: User, requestedAt: string): Promise<boolean>;
}

interface OutlookExportReadyDetector {
  hasUberExportReadyEmail(userId: string, requestedAt: string): Promise<boolean>;
}
interface GmailWatchLifecycle {
  ensureForUser(userId: string): Promise<boolean>;
  stopForUser(userId: string): Promise<void>;
}

export interface ExportReadyCheckResult {
  readonly detected: boolean;
  readonly preferences: ImportPreferencesProjection;
}

/** Owns import consent and provider-export preference transitions. */
export class ImportPreferencesService {
  constructor(
    private readonly lifecycle: LifecyclePort,
    private readonly queries: PreferencesQueryPort,
    private readonly status: StatusPort,
    private readonly exportReadyDetector: ExportReadyDetector,
    private readonly sourceCoverage: SourceCoveragePort,
    private readonly outlookExportReadyDetector?: OutlookExportReadyDetector,
    private readonly gmailWatches?: GmailWatchLifecycle,
    private readonly readyAlerts?: Pick<ExportReadyAlertRepository,'setConsent'>,
    private readonly backgroundAlertsEnabled=false,
    private readonly enqueueReadyCheck?: (userId:string,provider:ExportProvider)=>Promise<void>,
  ) {}

  async queueProviderReadyCheck(userId:string,provider:ExportProvider):Promise<ImportPreferencesProjection>{
    if(this.backgroundAlertsEnabled) await this.enqueueReadyCheck?.(userId,provider);
    return this.status.getPreferences(userId);
  }

  async setProviderReadyAlertConsent(userId: string, provider: ExportProvider, decision: ConsentDecision, version?: string): Promise<ImportPreferencesProjection> {
    if (!this.readyAlerts || (decision==='granted' && !this.backgroundAlertsEnabled)) throw new ConflictError('EXPORT_ALERTS_UNAVAILABLE','Background ready alerts are not available yet.');
    if (decision==='granted' && version!==BACKGROUND_ALERT_CONSENT_VERSION) throw new ConflictError('CONSENT_VERSION_REQUIRED','Review the current ready-alert consent.');
    const lock=await ImportLockService.acquireLockWithWait(userId,5_000);
    if (!lock) throw new ConflictError('IMPORT_IN_PROGRESS','Please try again when the current operation finishes.');
    try {
      await this.readyAlerts.setConsent(userId,provider,decision);
      if (provider === 'uber_eats' && decision !== 'granted') await this.lifecycle.setMonitoringConsent(userId, decision);
    }
    finally { await ImportLockService.releaseLock(lock); }
    await this.syncGmailWatchForCurrentPurpose(userId);
    return this.status.getPreferences(userId);
  }

  async markAutomaticUpdatesOfferSeen(userId: string): Promise<ImportPreferencesProjection> {
    const lock = await ImportLockService.acquireLockWithWait(userId, 5_000);
    if (!lock) throw new ConflictError('IMPORT_IN_PROGRESS', 'Please try again shortly.');
    try { await this.lifecycle.markAutomaticUpdatesOfferSeen(userId); }
    finally { await ImportLockService.releaseLock(lock); }
    return this.status.getPreferences(userId);
  }

  get(userId: string, requestTimezone?: string): Promise<ImportPreferencesProjection> {
    return this.status.getPreferences(userId, requestTimezone);
  }

  getSetupGuidance(userId: string): Promise<ImportSetupGuidance> {
    return this.queries.getSetupGuidance(userId);
  }

  async setInitialSetupDeferral(
    userId: string,
    decision: 'defer' | 'resume',
  ): Promise<ImportSetupGuidance> {
    await this.lifecycle.setInitialSetupDeferral(userId, decision);
    return this.queries.getSetupGuidance(userId);
  }

  async setProviderRelevance(
    userId: string,
    provider: ExportProvider,
    relevance: ProviderRelevance,
  ): Promise<ImportPreferencesProjection> {
    const updated = await this.lifecycle.setProviderRelevance(userId, provider, relevance);
    if (!updated && relevance === 'not_used') {
      const coverage = await this.sourceCoverage.getForUser(userId);
      const providerCoverage = provider === 'uber_eats' ? 'uberEats' : 'doorDash';
      if (
        coverage.emailProviders[providerCoverage].hasData ||
        coverage.exportProviders[providerCoverage].hasData
      ) {
        throw new ConflictError(
          'PROVIDER_USAGE_EVIDENCE_EXISTS',
          'Order history already shows activity for this provider.',
        );
      }
      throw new ConflictError(
        'PROVIDER_WORKFLOW_ACTIVE',
        'This provider already has an active history request or import.',
      );
    }
    return this.status.getPreferences(userId);
  }

  async setMonitoringConsent(
    userId: string,
    decision: ConsentDecision,
    consentVersion?: string,
  ): Promise<ImportPreferencesProjection> {
    const lock=await ImportLockService.acquireLockWithWait(userId,5_000);
    if (!lock) throw new ConflictError('IMPORT_IN_PROGRESS','Please try again when the current operation finishes.');
    try {
      await this.lifecycle.setMonitoringConsent(userId, decision, consentVersion);
      if (decision !== 'granted' && this.readyAlerts) await this.readyAlerts.setConsent(userId, 'uber_eats', decision);
    } finally { await ImportLockService.releaseLock(lock); }
    await this.syncGmailWatchForCurrentPurpose(userId);
    return this.status.getPreferences(userId);
  }

  async setOngoingTrackingConsent(
    userId: string,
    decision: ConsentDecision,
    consentVersion?: string,
  ): Promise<ImportPreferencesProjection> {
    if (decision === 'granted') {
      const baseline = await this.queries.getTrackingBaseline(userId);
      if (!baseline.eligible) {
        throw new ConflictError(
          'HISTORICAL_BASELINE_REQUIRED',
          'Import Gmail history or a provider export before enabling ongoing tracking.',
        );
      }
      const projection = await this.status.getPreferences(userId);
      if (!projection.ongoingTracking.capability.canTrack) {
        const temporarilyUnavailable =
          projection.gmailConnection.connectionHealth === 'unavailable' ||
          projection.outlookConnection.connectionHealth === 'unavailable';
        if (temporarilyUnavailable) {
          throw new AppError({
            code: 'MAILBOX_VALIDATION_UNAVAILABLE',
            message: 'Connected mailboxes could not be reached. Try again shortly.',
          });
        }
        throw new ConflictError(
          'MAILBOX_RECONNECT_REQUIRED',
          'Reconnect Gmail or Outlook with durable access before enabling ongoing tracking.',
        );
      }
    }

    await this.lifecycle.setOngoingTrackingConsent(userId, decision, consentVersion);
    await this.syncGmailWatch(userId, decision);
    return this.status.getPreferences(userId);
  }

  private async syncGmailWatch(userId: string, decision: ConsentDecision): Promise<void> {
    if (!this.gmailWatches) return;
    if (decision === 'granted') {
      await this.gmailWatches.ensureForUser(userId).catch(() => false);
      return;
    }
    await this.syncGmailWatchForCurrentPurpose(userId);
  }

  private async syncGmailWatchForCurrentPurpose(userId: string): Promise<void> {
    if (!this.gmailWatches) return;
    const [current, exports] = await Promise.all([
      this.queries.get(userId),
      this.queries.getProviderExports(userId),
    ]);
    const active = current.ongoingTrackingConsentState === 'granted' ||
      Object.values(exports).some(p=>p.status==='requested' && p.readyAlert?.consentState==='granted');
    if (active) await this.gmailWatches.ensureForUser(userId).catch(() => false);
    else await this.gmailWatches.stopForUser(userId);
  }

  async markExportRequested(
    userId: string,
    provider: ExportProvider,
  ): Promise<ImportPreferencesProjection> {
    await this.lifecycle.markExportRequested(userId, provider);
    await this.gmailWatches?.ensureForUser(userId).catch(() => false);
    return this.status.getPreferences(userId);
  }

  async confirmExportReady(
    userId: string,
    provider: ExportProvider,
  ): Promise<ImportPreferencesProjection> {
    const updated = await this.lifecycle.confirmExportReady(userId, provider);
    if (!updated) {
      throw new ConflictError(
        'EXPORT_ALREADY_PROCESSING',
        'This provider archive is already being processed.',
      );
    }
    if (provider === 'uber_eats') await this.syncGmailWatchForCurrentPurpose(userId);
    return this.status.getPreferences(userId);
  }

  async checkExportReady(userId: string): Promise<ExportReadyCheckResult> {
    return this.checkExportReadyWithProviders(userId, true);
  }

  checkGmailExportReady(userId: string): Promise<ExportReadyCheckResult> {
    return this.checkExportReadyWithProviders(userId, false);
  }

  private async checkExportReadyWithProviders(
    userId: string,
    includeOutlook: boolean,
  ): Promise<ExportReadyCheckResult> {
    const [preferences, providerExports] = await Promise.all([
      this.queries.get(userId),
      this.queries.getProviderExports(userId),
    ]);
    const uberExport = providerExports.uber_eats;
    if (uberExport.readyAlert?.consentState==='granted' || !this.shouldCheckUberExport(preferences, uberExport)) {
      return { detected: false, preferences: await this.status.getPreferences(userId) };
    }

    const projection = await this.status.getPreferences(userId);
    let detected = false;
    if (
      projection.gmailConnection.connectionHealth === 'valid' &&
      projection.gmailConnection.canImport &&
      projection.gmailConnection.connectionMode === 'offline'
    ) {
      const { user } = await this.status.getConnection(userId);
      detected = await this.exportReadyDetector.hasUberExportReadyEmail(
        user,
        uberExport.requestedAt,
      );
    }
    if (
      includeOutlook &&
      !detected &&
      this.outlookExportReadyDetector &&
      projection.outlookConnection.connectionHealth === 'valid' &&
      projection.outlookConnection.canImport &&
      projection.outlookConnection.connectionMode === 'offline'
    ) {
      detected = await this.outlookExportReadyDetector.hasUberExportReadyEmail(
        userId,
        uberExport.requestedAt,
      );
    }
    if (detected) {
      await this.lifecycle.setExportStatus(
        userId,
        'uber_eats',
        'file_ready',
        undefined,
        'detected_email',
      );
    }
    return { detected, preferences: await this.status.getPreferences(userId) };
  }

  private shouldCheckUberExport(
    preferences: ImportPreferences,
    uberExport: ProviderExportPreference,
  ): uberExport is ProviderExportPreference & { requestedAt: string } {
    return (
      preferences.monitoringConsentState === 'granted' &&
      uberExport.status === 'requested' &&
      Boolean(uberExport.requestedAt)
    );
  }
}
