import type {
  ExportProvider,
  ExportReadySource,
  MonitoringConsentState,
  ProviderExportLifecycleStatus,
  ProviderRelevance,
} from '../import/ImportLifecycleTypes';
import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import type { ImportEventName, ImportEventRepository } from './ImportEventRepository';

type EventPort = Pick<ImportEventRepository, 'record'>;

/** Persists consent and provider-export lifecycle commands. */
export class ImportLifecycleRepository {
  constructor(
    private readonly database: DatabaseQueryExecutor,
    private readonly events: EventPort,
  ) {}

  private async ensurePreferences(userId: string): Promise<void> {
    await this.database.query(
      `INSERT INTO user_import_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }

  private async ensureProviderPreferences(userId: string): Promise<void> {
    await this.database.query(
      `INSERT INTO user_export_provider_preferences (user_id, provider)
       VALUES ($1, 'uber_eats'), ($1, 'doordash')
       ON CONFLICT (user_id, provider) DO NOTHING`,
      [userId],
    );
  }

  async setInitialSetupDeferral(userId: string, decision: 'defer' | 'resume'): Promise<void> {
    await this.ensurePreferences(userId);
    await this.database.query(
      `UPDATE user_import_preferences
       SET initial_setup_deferred_until = CASE
             WHEN $2::VARCHAR(12) = 'defer' THEN NOW() + INTERVAL '7 days'
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, decision],
    );
  }

  async setProviderRelevance(
    userId: string,
    provider: ExportProvider,
    relevance: ProviderRelevance,
  ): Promise<boolean> {
    await this.ensureProviderPreferences(userId);
    const result = await this.database.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET relevance = $3::VARCHAR(16), updated_at = NOW()
       WHERE user_id = $1 AND provider = $2::VARCHAR(24)
         AND (
           $3::VARCHAR(16) = 'unknown'
           OR (
             provider_preferences.status = 'not_started'
             AND NOT EXISTS (
               SELECT 1 FROM receipts
               WHERE receipts.user_id = $1
                 AND receipts.receipt_type = $2::VARCHAR(24)
                 AND receipts.data_source IN ('email', 'csv')
             )
           )
         )`,
      [userId, provider, relevance],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setMonitoringConsent(
    userId: string,
    decision: Exclude<MonitoringConsentState, 'not_offered'>,
    consentVersion?: string,
  ): Promise<void> {
    await this.ensurePreferences(userId);
    const result = await this.database.query(
      `UPDATE user_import_preferences
       SET monitoring_consent_state = $2::VARCHAR(24),
           monitoring_consent_version = CASE
             WHEN $2::VARCHAR(24) = 'granted' THEN $3::VARCHAR(50)
             ELSE monitoring_consent_version
           END,
           monitoring_consented_at = CASE
             WHEN $2::VARCHAR(24) = 'granted' THEN NOW()
             ELSE monitoring_consented_at
           END,
           monitoring_revoked_at = CASE
             WHEN $2::VARCHAR(24) = 'revoked' THEN NOW()
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, decision, consentVersion || null],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.events.record(userId, `monitoring_consent_${decision}`, {
        consentVersion: consentVersion || null,
      });
    }
  }

  async markExportRequested(userId: string, provider: ExportProvider): Promise<void> {
    await this.ensureProviderPreferences(userId);
    const result = await this.database.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET status = 'requested', requested_at = NOW(), updated_at = NOW(),
           error_code = NULL, ready_source = NULL, relevance = 'unknown'
       WHERE user_id = $1 AND provider = $2::VARCHAR(24)`,
      [userId, provider],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.events.record(userId, 'export_requested', { provider });
    }
  }

  async setExportStatus(
    userId: string,
    provider: ExportProvider,
    status: ProviderExportLifecycleStatus,
    errorCode?: string,
    readySource?: ExportReadySource,
    eventMetadata: Readonly<Record<string, string | number | boolean | null>> = {},
  ): Promise<boolean> {
    await this.ensureProviderPreferences(userId);
    const result = await this.database.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET status = $3::VARCHAR(32),
           error_code = CASE WHEN $3::VARCHAR(32) = 'failed' THEN $4::VARCHAR(80) ELSE NULL END,
           ready_source = CASE
             WHEN $3::VARCHAR(32) = 'file_ready' THEN $5::VARCHAR(24)
             ELSE ready_source
           END,
           relevance = CASE
             WHEN $3::VARCHAR(32) = 'not_started' THEN relevance
             ELSE 'unknown'
           END,
           updated_at = NOW()
       WHERE user_id = $1 AND provider = $2::VARCHAR(24)`,
      [userId, provider, status, errorCode?.substring(0, 80) ?? null, readySource ?? null],
    );

    const eventNameByStatus: Partial<Record<ProviderExportLifecycleStatus, ImportEventName>> = {
      file_ready: 'export_file_ready',
      import_processing: 'export_import_processing',
      completed: 'export_completed',
      failed: 'export_failed',
    };
    const eventName = eventNameByStatus[status];
    if ((result.rowCount ?? 0) > 0 && eventName) {
      await this.events.record(userId, eventName, {
        provider,
        ...(errorCode ? { errorCode } : {}),
        ...eventMetadata,
      });
    }
    return (result.rowCount ?? 0) > 0;
  }

  async confirmExportReady(userId: string, provider: ExportProvider): Promise<boolean> {
    await this.ensureProviderPreferences(userId);
    const result = await this.database.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET status = 'file_ready',
           ready_source = CASE
             WHEN status = 'file_ready' THEN ready_source
             ELSE 'user_confirmed'
           END,
           updated_at = CASE WHEN status = 'file_ready' THEN updated_at ELSE NOW() END,
           error_code = NULL,
           relevance = 'unknown'
       WHERE user_id = $1 AND provider = $2::VARCHAR(24)
         AND status <> 'import_processing'`,
      [userId, provider],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.events.record(userId, 'export_file_ready', {
        provider,
        source: 'user_confirmed',
      });
    }
    return (result.rowCount ?? 0) > 0;
  }

  async setOngoingTrackingConsent(
    userId: string,
    decision: Exclude<MonitoringConsentState, 'not_offered'>,
    consentVersion?: string,
  ): Promise<void> {
    await this.ensurePreferences(userId);
    const result = await this.database.query(
      `UPDATE user_import_preferences
       SET ongoing_tracking_consent_state = $2::VARCHAR(24),
           ongoing_tracking_consent_version = CASE WHEN $2::VARCHAR(24) = 'granted' THEN $3::VARCHAR(50) ELSE ongoing_tracking_consent_version END,
           ongoing_tracking_consented_at = CASE WHEN $2::VARCHAR(24) = 'granted' THEN NOW() ELSE ongoing_tracking_consented_at END,
           ongoing_tracking_revoked_at = CASE WHEN $2::VARCHAR(24) = 'revoked' THEN NOW() ELSE NULL END,
           tracking_status = CASE
             WHEN $2::VARCHAR(24) = 'granted' AND last_successful_check_at IS NULL THEN 'setting_up'
             WHEN $2::VARCHAR(24) = 'granted' THEN 'active'
             WHEN $2::VARCHAR(24) = 'revoked' THEN 'paused'
             ELSE 'inactive'
           END,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, decision, consentVersion || null],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.events.record(userId, `ongoing_tracking_consent_${decision}`, {
        consentVersion: consentVersion || null,
      });
    }
  }

  async markTrackingReconnectRequired(userId: string): Promise<void> {
    await this.ensurePreferences(userId);
    await this.database.query(
      `UPDATE user_import_preferences SET tracking_status = 'reconnect_required', updated_at = NOW()
       WHERE user_id = $1 AND ongoing_tracking_consent_state = 'granted'`,
      [userId],
    );
  }

  async markTrackingError(userId: string, errorCode: string): Promise<void> {
    await this.ensurePreferences(userId);
    await this.database.query(
      `UPDATE user_import_preferences
       SET tracking_status = 'error', last_tracking_error_at = NOW(),
           last_tracking_error_code = $2, updated_at = NOW()
       WHERE user_id = $1 AND ongoing_tracking_consent_state = 'granted'`,
      [userId, errorCode.substring(0, 80)],
    );
  }
}
