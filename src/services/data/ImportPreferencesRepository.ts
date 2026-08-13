import { PostgresService } from './PostgresService';

export type MonitoringConsentState = 'not_offered' | 'declined' | 'granted' | 'revoked';
export type GmailImportStatus = 'never_started' | 'importing' | 'completed' | 'failed';
export type OngoingTrackingStatus = 'inactive' | 'active' | 'paused' | 'reconnect_required' | 'error';
export type ExportLifecycleStatus =
  | 'not_started'
  | 'requested_monitoring_enabled'
  | 'requested_monitoring_disabled'
  | 'file_ready'
  | 'import_processing'
  | 'completed'
  | 'failed';

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
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
}

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

    await this.postgres.query(
      `UPDATE user_import_preferences preferences
       SET gmail_import_status = 'completed',
           gmail_imported_count = source.count,
           gmail_import_updated_at = COALESCE(gmail_import_updated_at, NOW()),
           updated_at = NOW()
       FROM (
         SELECT COUNT(*)::int AS count FROM receipts
         WHERE user_id = $1 AND data_source = 'email'
       ) source
       WHERE preferences.user_id = $1
         AND preferences.gmail_import_status = 'never_started'
         AND preferences.gmail_import_updated_at IS NULL
         AND source.count > 0`,
      [userId]
    );

    const result = await this.postgres.query(
      `SELECT user_id, monitoring_consent_state, monitoring_consent_version,
              monitoring_consented_at, monitoring_revoked_at, export_status,
              export_requested_at, export_updated_at, gmail_import_status,
              gmail_import_updated_at, gmail_imported_count, gmail_import_error_code,
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
    if (updateResult.rowCount > 0) {
      await this.recordEvent(userId, `monitoring_consent_${decision}`, {
        consentVersion: consentVersion || null,
      });
    }

    return this.get(userId);
  }

  async markExportRequested(userId: string): Promise<ImportPreferences> {
    await this.ensureRow(userId);

    const updateResult = await this.postgres.query(
      `UPDATE user_import_preferences
       SET export_status = CASE
             WHEN monitoring_consent_state = 'granted'
               THEN 'requested_monitoring_enabled'
             ELSE 'requested_monitoring_disabled'
           END,
           export_requested_at = COALESCE(export_requested_at, NOW()),
           export_updated_at = NOW(),
           updated_at = NOW()
       WHERE user_id = $1
         AND export_status <> 'completed'`,
      [userId]
    );
    if (updateResult.rowCount > 0) {
      await this.recordEvent(userId, 'export_requested');
    }

    return this.get(userId);
  }

  async setExportStatus(userId: string, status: ExportLifecycleStatus): Promise<boolean> {
    await this.ensureRow(userId);
    const result = await this.postgres.query(
      `UPDATE user_import_preferences
       SET export_status = $2::VARCHAR(40),
           export_updated_at = NOW(),
           updated_at = NOW()
       WHERE user_id = $1
         AND (export_status <> 'completed' OR $2::VARCHAR(40) = 'completed')`,
      [userId, status]
    );

    const eventNameByStatus: Partial<Record<ExportLifecycleStatus, string>> = {
      file_ready: 'export_file_ready',
      import_processing: 'export_import_processing',
      completed: 'export_completed',
      failed: 'export_failed',
    };
    const eventName = eventNameByStatus[status];
    if (result.rowCount > 0 && eventName) {
      await this.recordEvent(userId, eventName);
    }
    return result.rowCount > 0;
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
    const result = await this.postgres.query(
      `UPDATE user_import_preferences
       SET gmail_import_status = 'never_started',
           gmail_import_updated_at = NOW(),
           gmail_imported_count = 0,
           gmail_import_error_code = NULL,
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
    if (result.rowCount > 0) {
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
    await this.postgres.query(
      `UPDATE user_import_preferences
       SET gmail_import_status = 'importing', gmail_import_updated_at = NOW(),
           gmail_import_error_code = NULL, last_check_attempt_at = NOW(), updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0].id;
  }

  async completeSyncRun(
    runId: string,
    userId: string,
    outcome: 'success' | 'partial',
    counts: SyncRunCounts
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE gmail_sync_runs
       SET outcome = $2, completed_at = NOW(), emails_scanned = $3,
           receipts_processed = $4, new_orders = $5, updated_orders = $6,
           unchanged_orders = $7
       WHERE id = $1 AND user_id = $8`,
      [runId, outcome, counts.emailsScanned, counts.receiptsProcessed,
        counts.newOrders, counts.updatedOrders, counts.unchangedOrders, userId]
    );
    await this.postgres.query(
      `UPDATE user_import_preferences
       SET gmail_import_status = 'completed', gmail_import_updated_at = NOW(),
           gmail_imported_count = $2, gmail_import_error_code = NULL,
           last_successful_check_at = NOW(),
           last_stats_updated_at = CASE WHEN $3 > 0 OR $4 > 0 THEN NOW() ELSE last_stats_updated_at END,
           last_new_order_at = CASE WHEN $3 > 0 THEN NOW() ELSE last_new_order_at END,
           tracking_status = CASE WHEN ongoing_tracking_consent_state = 'granted' THEN 'active' ELSE tracking_status END,
           last_tracking_error_at = NULL, last_tracking_error_code = NULL, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, counts.newOrders + counts.updatedOrders + counts.unchangedOrders,
        counts.newOrders, counts.updatedOrders]
    );
  }

  async failSyncRun(runId: string, userId: string, errorCode: string): Promise<void> {
    const safeCode = errorCode.substring(0, 80);
    await this.postgres.query(
      `UPDATE gmail_sync_runs SET outcome = 'failed', completed_at = NOW(), error_code = $2
       WHERE id = $1 AND user_id = $3`,
      [runId, safeCode, userId]
    );
    await this.postgres.query(
      `UPDATE user_import_preferences
       SET gmail_import_status = 'failed', gmail_import_updated_at = NOW(),
           gmail_import_error_code = $2, tracking_status = CASE
             WHEN ongoing_tracking_consent_state = 'granted' THEN 'error' ELSE tracking_status END,
           last_tracking_error_at = NOW(), last_tracking_error_code = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, safeCode]
    );
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
         AND first_seen_at >= (DATE_TRUNC('week', NOW() AT TIME ZONE $2) AT TIME ZONE $2)`,
      [userId, timezone]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async getEligibleTrackingUserIds(limit = 100): Promise<string[]> {
    const result = await this.postgres.query(
      `SELECT preferences.user_id
       FROM user_import_preferences preferences
       JOIN users ON users.id = preferences.user_id
       WHERE preferences.ongoing_tracking_consent_state = 'granted'
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
