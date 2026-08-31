import { PostgresService } from './PostgresService';

export type MonitoringConsentState = 'not_offered' | 'declined' | 'granted' | 'revoked';
export type GmailImportStatus = 'never_started' | 'importing' | 'completed' | 'failed';
export type OngoingTrackingStatus = 'inactive' | 'setting_up' | 'active' | 'paused' | 'reconnect_required' | 'error';
export type ExportLifecycleStatus =
  | 'not_started'
  | 'requested_monitoring_enabled'
  | 'requested_monitoring_disabled'
  | 'file_ready'
  | 'import_processing'
  | 'completed'
  | 'failed';
export type ExportProvider = 'uber_eats' | 'doordash';
export type ProviderExportLifecycleStatus =
  | 'not_started'
  | 'requested'
  | 'file_ready'
  | 'import_processing'
  | 'completed'
  | 'failed';
export type ExportReadySource = 'detected_email' | 'user_confirmed';

export interface ProviderExportPreference {
  provider: ExportProvider;
  status: ProviderExportLifecycleStatus;
  requestedAt: string | null;
  updatedAt: string | null;
  errorCode: string | null;
  readySource: ExportReadySource | null;
}

export interface ImportPreferences {
  userId: string;
  monitoringConsentState: MonitoringConsentState;
  monitoringConsentVersion: string | null;
  monitoringConsentedAt: string | null;
  monitoringRevokedAt: string | null;
  exportStatus: ExportLifecycleStatus;
  exportRequestedAt: string | null;
  exportUpdatedAt: string | null;
  gmailImportStatus: GmailImportStatus;
  gmailImportUpdatedAt: string | null;
  gmailImportedCount: number;
  gmailImportErrorCode: string | null;
  gmailBaselineCompletedAt: string | null;
  ongoingTrackingConsentState: MonitoringConsentState;
  ongoingTrackingConsentVersion: string | null;
  ongoingTrackingConsentedAt: string | null;
  ongoingTrackingRevokedAt: string | null;
  trackingStatus: OngoingTrackingStatus;
  lastCheckAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastStatsUpdatedAt: string | null;
  lastNewOrderAt: string | null;
  lastTrackingErrorAt: string | null;
  lastTrackingErrorCode: string | null;
}

export interface SyncRunCounts {
  emailsScanned: number;
  receiptsProcessed: number;
  supportedReceiptsFound: number;
  exportCoveredReceipts: number;
  eligibleReceipts: number;
  deduplicatedReceipts: number;
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
}

export interface TrackingBaseline {
  eligible: boolean;
  source: 'gmail' | 'exports' | 'none';
}

export const resolveTrackingBaseline = ({
  gmailBaselineCompletedAt,
  uberEatsExportCount,
  doorDashExportCount,
}: {
  gmailBaselineCompletedAt: unknown;
  uberEatsExportCount: number;
  doorDashExportCount: number;
}): TrackingBaseline => {
  if (uberEatsExportCount > 0 || doorDashExportCount > 0) {
    return { eligible: true, source: 'exports' };
  }
  if (gmailBaselineCompletedAt) return { eligible: true, source: 'gmail' };
  return { eligible: false, source: 'none' };
};

const mapRow = (row: any): ImportPreferences => ({
  userId: row.user_id,
  monitoringConsentState: row.monitoring_consent_state,
  monitoringConsentVersion: row.monitoring_consent_version,
  monitoringConsentedAt: row.monitoring_consented_at?.toISOString?.() ?? row.monitoring_consented_at ?? null,
  monitoringRevokedAt: row.monitoring_revoked_at?.toISOString?.() ?? row.monitoring_revoked_at ?? null,
  exportStatus: row.export_status,
  exportRequestedAt: row.export_requested_at?.toISOString?.() ?? row.export_requested_at ?? null,
  exportUpdatedAt: row.export_updated_at?.toISOString?.() ?? row.export_updated_at ?? null,
  gmailImportStatus: row.gmail_import_status,
  gmailImportUpdatedAt: row.gmail_import_updated_at?.toISOString?.() ?? row.gmail_import_updated_at ?? null,
  gmailImportedCount: Number(row.gmail_imported_count || 0),
  gmailImportErrorCode: row.gmail_import_error_code ?? null,
  gmailBaselineCompletedAt: row.gmail_baseline_completed_at?.toISOString?.() ?? row.gmail_baseline_completed_at ?? null,
  ongoingTrackingConsentState: row.ongoing_tracking_consent_state,
  ongoingTrackingConsentVersion: row.ongoing_tracking_consent_version ?? null,
  ongoingTrackingConsentedAt: row.ongoing_tracking_consented_at?.toISOString?.() ?? row.ongoing_tracking_consented_at ?? null,
  ongoingTrackingRevokedAt: row.ongoing_tracking_revoked_at?.toISOString?.() ?? row.ongoing_tracking_revoked_at ?? null,
  trackingStatus: row.tracking_status,
  lastCheckAttemptAt: row.last_check_attempt_at?.toISOString?.() ?? row.last_check_attempt_at ?? null,
  lastSuccessfulCheckAt: row.last_successful_check_at?.toISOString?.() ?? row.last_successful_check_at ?? null,
  lastStatsUpdatedAt: row.last_stats_updated_at?.toISOString?.() ?? row.last_stats_updated_at ?? null,
  lastNewOrderAt: row.last_new_order_at?.toISOString?.() ?? row.last_new_order_at ?? null,
  lastTrackingErrorAt: row.last_tracking_error_at?.toISOString?.() ?? row.last_tracking_error_at ?? null,
  lastTrackingErrorCode: row.last_tracking_error_code ?? null,
});

export class ImportPreferencesRepository {
  constructor(private postgres: PostgresService) {}

  private async recordEvent(
    userId: string,
    eventName: string,
    metadata: Record<string, string | null> = {}
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO user_import_preference_events (user_id, event_name, metadata)
       VALUES ($1, $2, $3::JSONB)`,
      [userId, eventName, JSON.stringify(metadata)]
    );
  }

  private async ensureRow(userId: string): Promise<void> {
    await this.postgres.query(
      `INSERT INTO user_import_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  }

  private async ensureProviderRows(userId: string): Promise<void> {
    await this.postgres.query(
      `INSERT INTO user_export_provider_preferences (user_id, provider)
       VALUES ($1, 'uber_eats'), ($1, 'doordash')
       ON CONFLICT (user_id, provider) DO NOTHING`,
      [userId]
    );
  }

  async getProviderExports(userId: string): Promise<Record<ExportProvider, ProviderExportPreference>> {
    await this.ensureProviderRows(userId);
    await this.postgres.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET status = 'completed', error_code = NULL, updated_at = NOW()
       WHERE provider_preferences.user_id = $1
         AND EXISTS (
           SELECT 1 FROM receipts
           WHERE receipts.user_id = provider_preferences.user_id
             AND receipts.data_source = 'csv'
             AND receipts.receipt_type = provider_preferences.provider
         )
         AND provider_preferences.status = 'not_started'`,
      [userId]
    );
    const result = await this.postgres.query(
      `SELECT provider, status, requested_at, updated_at, error_code, ready_source
       FROM user_export_provider_preferences
       WHERE user_id = $1`,
      [userId]
    );
    const mapped = Object.fromEntries(result.rows.map((row: any) => [row.provider, {
      provider: row.provider,
      status: row.status,
      requestedAt: row.requested_at?.toISOString?.() ?? row.requested_at ?? null,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at ?? null,
      errorCode: row.error_code ?? null,
      readySource: row.ready_source ?? null,
    }])) as Partial<Record<ExportProvider, ProviderExportPreference>>;
    return {
      uber_eats: mapped.uber_eats!,
      doordash: mapped.doordash!,
    };
  }

  async get(userId: string): Promise<ImportPreferences> {
    await this.ensureRow(userId);

    // A valid CSV/ZIP import remains the source of truth for completion even
    // when preference state was created on another device or before this table.
    await this.postgres.query(
      `UPDATE user_import_preferences preferences
       SET export_status = 'completed',
           export_updated_at = NOW(),
           updated_at = NOW()
       WHERE preferences.user_id = $1
         AND preferences.export_status <> 'completed'
         AND EXISTS (
           SELECT 1
           FROM receipts
           WHERE receipts.user_id = preferences.user_id
             AND receipts.data_source = 'csv'
         )`,
      [userId]
    );

    const result = await this.postgres.query(
      `SELECT user_id, monitoring_consent_state, monitoring_consent_version,
              monitoring_consented_at, monitoring_revoked_at, export_status,
              export_requested_at, export_updated_at, gmail_import_status,
              gmail_import_updated_at, gmail_imported_count, gmail_import_error_code,
              gmail_baseline_completed_at,
              ongoing_tracking_consent_state, ongoing_tracking_consent_version,
              ongoing_tracking_consented_at, ongoing_tracking_revoked_at,
              tracking_status, last_check_attempt_at, last_successful_check_at,
              last_stats_updated_at, last_new_order_at, last_tracking_error_at,
              last_tracking_error_code
       FROM user_import_preferences
       WHERE user_id = $1`,
      [userId]
    );

    return mapRow(result.rows[0]);
  }

  async setMonitoringConsent(
    userId: string,
    decision: Exclude<MonitoringConsentState, 'not_offered'>,
    consentVersion?: string
  ): Promise<ImportPreferences> {
    await this.ensureRow(userId);

    const updateResult = await this.postgres.query(
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
           export_status = CASE
             WHEN export_status IN ('requested_monitoring_enabled', 'requested_monitoring_disabled')
               THEN CASE
                 WHEN $2::VARCHAR(24) = 'granted' THEN 'requested_monitoring_enabled'
                 ELSE 'requested_monitoring_disabled'
               END
             ELSE export_status
           END,
           export_updated_at = CASE
             WHEN export_status IN ('requested_monitoring_enabled', 'requested_monitoring_disabled')
               THEN NOW()
             ELSE export_updated_at
           END,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, decision, consentVersion || null]
    );
    if ((updateResult.rowCount ?? 0) > 0) {
      await this.recordEvent(userId, `monitoring_consent_${decision}`, {
        consentVersion: consentVersion || null,
      });
    }

    return this.get(userId);
  }

  async markExportRequested(userId: string, provider: ExportProvider): Promise<void> {
    await this.ensureProviderRows(userId);
    const updateResult = await this.postgres.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET status = 'requested',
           requested_at = NOW(),
           updated_at = NOW(), error_code = NULL, ready_source = NULL
       WHERE user_id = $1 AND provider = $2::VARCHAR(24)`,
      [userId, provider]
    );
    if ((updateResult.rowCount ?? 0) > 0) {
      await this.recordEvent(userId, 'export_requested', { provider });
    }
  }

  async setExportStatus(
    userId: string,
    provider: ExportProvider,
    status: ProviderExportLifecycleStatus,
    errorCode?: string,
    readySource?: ExportReadySource
  ): Promise<boolean> {
    await this.ensureProviderRows(userId);
    const result = await this.postgres.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET status = $3::VARCHAR(32),
           error_code = CASE WHEN $3::VARCHAR(32) = 'failed' THEN $4::VARCHAR(80) ELSE NULL END,
           ready_source = CASE
             WHEN $3::VARCHAR(32) = 'file_ready' THEN $5::VARCHAR(24)
             ELSE ready_source
           END,
           updated_at = NOW()
       WHERE user_id = $1 AND provider = $2::VARCHAR(24)`,
      [userId, provider, status, errorCode?.substring(0, 80) ?? null, readySource ?? null]
    );

    const eventNameByStatus: Partial<Record<ProviderExportLifecycleStatus, string>> = {
      file_ready: 'export_file_ready',
      import_processing: 'export_import_processing',
      completed: 'export_completed',
      failed: 'export_failed',
    };
    const eventName = eventNameByStatus[status];
    if ((result.rowCount ?? 0) > 0 && eventName) {
      await this.recordEvent(userId, eventName, { provider });
    }
    return (result.rowCount ?? 0) > 0;
  }

  async confirmExportReady(userId: string, provider: ExportProvider): Promise<boolean> {
    await this.ensureProviderRows(userId);
    const result = await this.postgres.query(
      `UPDATE user_export_provider_preferences provider_preferences
       SET status = 'file_ready',
           ready_source = CASE
             WHEN status = 'file_ready' THEN ready_source
             ELSE 'user_confirmed'
           END,
           updated_at = CASE WHEN status = 'file_ready' THEN updated_at ELSE NOW() END,
           error_code = NULL
       WHERE user_id = $1 AND provider = $2::VARCHAR(24)
         AND status <> 'import_processing'`,
      [userId, provider]
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.recordEvent(userId, 'export_file_ready', { provider, source: 'user_confirmed' });
    }
    return (result.rowCount ?? 0) > 0;
  }

  async setOngoingTrackingConsent(
    userId: string,
    decision: Exclude<MonitoringConsentState, 'not_offered'>,
    consentVersion?: string
  ): Promise<ImportPreferences> {
    await this.ensureRow(userId);
    await this.postgres.query(
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
      [userId, decision, consentVersion || null]
    );
    await this.recordEvent(userId, `ongoing_tracking_consent_${decision}`, {
      consentVersion: consentVersion || null,
    });
    return this.get(userId);
  }

  async resetGmailImportStatus(userId: string): Promise<void> {
    await this.ensureRow(userId);
    const client = await this.postgres.getClient();
    let updated = false;
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM gmail_sync_runs WHERE user_id = $1', [userId]);
      const result = await client.query(
        `UPDATE user_import_preferences
         SET gmail_import_status = 'never_started',
             gmail_import_updated_at = NOW(),
             gmail_imported_count = 0,
             gmail_import_error_code = NULL,
             gmail_baseline_completed_at = NULL,
             last_check_attempt_at = NULL,
             last_successful_check_at = NULL,
             last_stats_updated_at = NULL,
             last_new_order_at = NULL,
             last_tracking_error_at = NULL,
             last_tracking_error_code = NULL,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      updated = (result.rowCount ?? 0) > 0;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (updated) {
      await this.recordEvent(userId, 'gmail_import_reset');
    }
  }

  async startSyncRun(userId: string, triggerType: 'manual' | 'background'): Promise<string> {
    await this.ensureRow(userId);
    const result = await this.postgres.query(
      `INSERT INTO gmail_sync_runs (user_id, trigger_type)
       VALUES ($1, $2) RETURNING id`,
      [userId, triggerType]
    );
    if (triggerType === 'manual') {
      await this.postgres.query(
        `UPDATE user_import_preferences
         SET gmail_import_status = 'importing', gmail_import_updated_at = NOW(),
             gmail_import_error_code = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
    } else {
      await this.postgres.query(
        `UPDATE user_import_preferences
         SET last_check_attempt_at = NOW(), updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
    }
    return result.rows[0].id;
  }

  async completeSyncRun(
    runId: string,
    userId: string,
    outcome: 'success' | 'partial',
    counts: SyncRunCounts,
    triggerType: 'manual' | 'background'
  ): Promise<void> {
    const client = await this.postgres.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE gmail_sync_runs
         SET outcome = $2, completed_at = NOW(), emails_scanned = $3,
             receipts_processed = $4, new_orders = $5, updated_orders = $6,
             unchanged_orders = $7, supported_receipts_found = $8,
             export_covered_receipts = $9, eligible_receipts = $10,
             deduplicated_receipts = $11
         WHERE id = $1 AND user_id = $12`,
        [runId, outcome, counts.emailsScanned, counts.receiptsProcessed,
          counts.newOrders, counts.updatedOrders, counts.unchangedOrders,
          counts.supportedReceiptsFound, counts.exportCoveredReceipts,
          counts.eligibleReceipts, counts.deduplicatedReceipts, userId]
      );
      if (triggerType === 'manual') {
        await client.query(
          `UPDATE user_import_preferences
           SET gmail_import_status = 'completed', gmail_import_updated_at = NOW(),
               gmail_imported_count = $2, gmail_import_error_code = NULL,
               gmail_baseline_completed_at = COALESCE(gmail_baseline_completed_at, NOW()),
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId, counts.newOrders + counts.updatedOrders + counts.unchangedOrders]
        );
      } else {
        await client.query(
          `UPDATE user_import_preferences
           SET last_successful_check_at = NOW(),
               last_stats_updated_at = CASE WHEN $2 > 0 OR $3 > 0 THEN NOW() ELSE last_stats_updated_at END,
               last_new_order_at = CASE WHEN $2 > 0 THEN NOW() ELSE last_new_order_at END,
               tracking_status = CASE WHEN ongoing_tracking_consent_state = 'granted' THEN 'active' ELSE tracking_status END,
               last_tracking_error_at = NULL, last_tracking_error_code = NULL, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, counts.newOrders, counts.updatedOrders]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async failSyncRun(
    runId: string,
    userId: string,
    errorCode: string,
    triggerType: 'manual' | 'background'
  ): Promise<void> {
    const safeCode = errorCode.substring(0, 80);
    const client = await this.postgres.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE gmail_sync_runs SET outcome = 'failed', completed_at = NOW(), error_code = $2
         WHERE id = $1 AND user_id = $3`,
        [runId, safeCode, userId]
      );
      if (triggerType === 'manual') {
        await client.query(
          `UPDATE user_import_preferences
           SET gmail_import_status = 'failed', gmail_import_updated_at = NOW(),
               gmail_import_error_code = $2, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, safeCode]
        );
      } else {
        await client.query(
          `UPDATE user_import_preferences
           SET tracking_status = CASE
                 WHEN ongoing_tracking_consent_state = 'granted' THEN 'error' ELSE tracking_status END,
               last_tracking_error_at = NOW(), last_tracking_error_code = $2, updated_at = NOW()
           WHERE user_id = $1`,
          [userId, safeCode]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markTrackingReconnectRequired(userId: string): Promise<void> {
    await this.ensureRow(userId);
    await this.postgres.query(
      `UPDATE user_import_preferences SET tracking_status = 'reconnect_required', updated_at = NOW()
       WHERE user_id = $1 AND ongoing_tracking_consent_state = 'granted'`,
      [userId]
    );
  }

  async getOrdersAddedThisWeek(userId: string, timezone: string): Promise<number> {
    const result = await this.postgres.query(
      `SELECT COUNT(*)::int AS count FROM receipts
       WHERE user_id = $1 AND data_source = 'email'
         AND order_date IS NOT NULL
         AND order_date >= (DATE_TRUNC('week', NOW() AT TIME ZONE $2) AT TIME ZONE $2)
         AND order_date < ((DATE_TRUNC('week', NOW() AT TIME ZONE $2) + INTERVAL '7 days') AT TIME ZONE $2)`,
      [userId, timezone]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async getTrackingBaseline(userId: string): Promise<TrackingBaseline> {
    await this.ensureRow(userId);
    const result = await this.postgres.query(
      `SELECT preferences.gmail_baseline_completed_at,
              COUNT(*) FILTER (
                WHERE receipts.data_source = 'csv' AND receipts.receipt_type = 'uber_eats'
              )::int AS uber_eats_export_count,
              COUNT(*) FILTER (
                WHERE receipts.data_source = 'csv' AND receipts.receipt_type = 'doordash'
              )::int AS doordash_export_count
       FROM user_import_preferences preferences
       LEFT JOIN receipts ON receipts.user_id = preferences.user_id
       WHERE preferences.user_id = $1
       GROUP BY preferences.gmail_baseline_completed_at`,
      [userId]
    );
    const row = result.rows[0];
    return resolveTrackingBaseline({
      gmailBaselineCompletedAt: row?.gmail_baseline_completed_at,
      uberEatsExportCount: Number(row?.uber_eats_export_count || 0),
      doorDashExportCount: Number(row?.doordash_export_count || 0),
    });
  }

  async getEligibleTrackingUserIds(limit = 100): Promise<string[]> {
    const result = await this.postgres.query(
      `SELECT preferences.user_id
       FROM user_import_preferences preferences
       JOIN users ON users.id = preferences.user_id
       WHERE preferences.ongoing_tracking_consent_state = 'granted'
         AND (
           preferences.gmail_baseline_completed_at IS NOT NULL
           OR EXISTS (
               SELECT 1 FROM receipts uber_receipt
               WHERE uber_receipt.user_id = preferences.user_id
                 AND uber_receipt.data_source = 'csv'
                 AND uber_receipt.receipt_type = 'uber_eats'
             )
           OR EXISTS (
               SELECT 1 FROM receipts doordash_receipt
               WHERE doordash_receipt.user_id = preferences.user_id
                 AND doordash_receipt.data_source = 'csv'
                 AND doordash_receipt.receipt_type = 'doordash'
             )
         )
         AND users.gmail_connected = TRUE
         AND users.gmail_connection_mode = 'offline'
         AND users.gmail_refresh_token IS NOT NULL
         AND (preferences.last_check_attempt_at IS NULL OR preferences.last_check_attempt_at <= NOW() - INTERVAL '15 minutes')
       ORDER BY preferences.last_check_attempt_at ASC NULLS FIRST
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row: any) => row.user_id);
  }
}
