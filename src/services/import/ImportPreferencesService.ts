import { AppError, ConflictError } from '../../core/errors';
import type { User } from '../../models/User';
import type {
  ConsentDecision,
  ExportProvider,
  ImportPreferences,
  MonitoringConsentState,
  ProviderExportPreference,
} from './ImportLifecycleTypes';
import type { ImportLifecyclePort, ImportPreferencesQueryPort } from '../ports/ImportPorts';
import type {
  GmailConnectionHealthResult,
  GmailConnectionStatus,
  ImportPreferencesProjection,
  ImportStatusService,
} from './ImportStatusService';

type LifecyclePort = Pick<
  ImportLifecyclePort,
  | 'setMonitoringConsent'
  | 'setOngoingTrackingConsent'
  | 'markExportRequested'
  | 'confirmExportReady'
  | 'setExportStatus'
>;
type PreferencesQueryPort = Pick<
  ImportPreferencesQueryPort,
  'getTrackingBaseline' | 'get' | 'getProviderExports'
>;

type StatusPort = Pick<ImportStatusService, 'getPreferences' | 'getConnection'>;

interface ExportReadyDetector {
  hasUberExportReadyEmail(user: User, requestedAt: string): Promise<boolean>;
}

export interface ExportReadyCheckResult {
  readonly detected: boolean;
  readonly preferences: ImportPreferencesProjection;
}

const requireDurableGmail = (
  health: GmailConnectionHealthResult,
  status: GmailConnectionStatus,
): void => {
  if (health.status === 'unavailable') {
    throw new AppError({
      code: 'GMAIL_VALIDATION_UNAVAILABLE',
      message: 'Gmail could not be reached. Your connection is unchanged; try again shortly.',
    });
  }
  if (health.status !== 'valid' || !status.connected || status.connectionMode !== 'offline') {
    throw new ConflictError(
      'GMAIL_RECONNECT_REQUIRED',
      'Reconnect Gmail with durable access before enabling ongoing tracking.',
    );
  }
};

/** Owns import consent and provider-export preference transitions. */
export class ImportPreferencesService {
  constructor(
    private readonly lifecycle: LifecyclePort,
    private readonly queries: PreferencesQueryPort,
    private readonly status: StatusPort,
    private readonly exportReadyDetector: ExportReadyDetector,
  ) {}

  get(userId: string, requestTimezone?: string): Promise<ImportPreferencesProjection> {
    return this.status.getPreferences(userId, requestTimezone);
  }

  async setMonitoringConsent(
    userId: string,
    decision: ConsentDecision,
    consentVersion?: string,
  ): Promise<ImportPreferencesProjection> {
    await this.lifecycle.setMonitoringConsent(userId, decision, consentVersion);
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
      const { health, status } = await this.status.getConnection(userId, true);
      requireDurableGmail(health, status);
    }

    await this.lifecycle.setOngoingTrackingConsent(userId, decision, consentVersion);
    return this.status.getPreferences(userId);
  }

  async markExportRequested(
    userId: string,
    provider: ExportProvider,
  ): Promise<ImportPreferencesProjection> {
    await this.lifecycle.markExportRequested(userId, provider);
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
    return this.status.getPreferences(userId);
  }

  async checkExportReady(userId: string): Promise<ExportReadyCheckResult> {
    const [preferences, providerExports] = await Promise.all([
      this.queries.get(userId),
      this.queries.getProviderExports(userId),
    ]);
    const uberExport = providerExports.uber_eats;
    if (!this.shouldCheckUberExport(preferences, uberExport)) {
      return { detected: false, preferences: await this.status.getPreferences(userId) };
    }

    const { user, health, status } = await this.status.getConnection(userId);
    if (
      health.status !== 'valid' ||
      !status.connected ||
      !status.canImport ||
      status.connectionMode !== 'offline'
    ) {
      return { detected: false, preferences: await this.status.getPreferences(userId) };
    }

    const detected = await this.exportReadyDetector.hasUberExportReadyEmail(
      user,
      uberExport.requestedAt,
    );
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
