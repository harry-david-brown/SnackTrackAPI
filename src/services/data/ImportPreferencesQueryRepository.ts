import type {
  ExportProvider,
  ExportReadySource,
  GmailImportStatus,
  ImportPreferences,
  MonitoringConsentState,
  OngoingTrackingStatus,
  ProviderExportLifecycleStatus,
  ProviderExportPreference,
  ImportSetupGuidance,
  TrackingBaseline,
} from '../import/ImportLifecycleTypes';
import {
  EXPORT_PROVIDERS,
  EXPORT_READY_SOURCES,
  GMAIL_IMPORT_STATUSES,
  MONITORING_CONSENT_STATES,
  ONGOING_TRACKING_STATUSES,
  PROVIDER_EXPORT_LIFECYCLE_STATUSES,
  PROVIDER_RELEVANCE_VALUES,
  resolveTrackingBaseline,
} from '../import/ImportLifecycleTypes';
import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import { receiptHasSourceSql, receiptOrderPredicates } from './ReceiptReadPredicates';
import {
  databaseEnum,
  databaseNonNegativeInteger,
  databaseNullableEnum,
  databaseNullableString,
  databaseRow,
  databaseTimestamp,
  databaseUuid,
} from './DatabaseRowDecoder';

const mapPreferences = (value: unknown): ImportPreferences => {
  const row = databaseRow(value, 'import preferences');
  return {
    userId: databaseUuid(row, 'user_id'),
    monitoringConsentState: databaseEnum(
      row,
      'monitoring_consent_state',
      MONITORING_CONSENT_STATES,
    ),
    monitoringConsentVersion: databaseNullableString(row, 'monitoring_consent_version'),
    monitoringConsentedAt: databaseTimestamp(row, 'monitoring_consented_at'),
    monitoringRevokedAt: databaseTimestamp(row, 'monitoring_revoked_at'),
    gmailImportStatus: databaseEnum(row, 'gmail_import_status', GMAIL_IMPORT_STATUSES),
    gmailImportUpdatedAt: databaseTimestamp(row, 'gmail_import_updated_at'),
    gmailImportedCount: databaseNonNegativeInteger(row, 'gmail_imported_count'),
    gmailImportErrorCode: databaseNullableString(row, 'gmail_import_error_code'),
    gmailBaselineCompletedAt: databaseTimestamp(row, 'gmail_baseline_completed_at'),
    automaticUpdatesOfferSeenAt: databaseTimestamp(row, 'automatic_updates_offer_seen_at'),
    ongoingTrackingConsentState: databaseEnum(
      row,
      'ongoing_tracking_consent_state',
      MONITORING_CONSENT_STATES,
    ),
    ongoingTrackingConsentVersion: databaseNullableString(row, 'ongoing_tracking_consent_version'),
    ongoingTrackingConsentedAt: databaseTimestamp(row, 'ongoing_tracking_consented_at'),
    ongoingTrackingRevokedAt: databaseTimestamp(row, 'ongoing_tracking_revoked_at'),
    trackingStatus: databaseEnum(row, 'tracking_status', ONGOING_TRACKING_STATUSES),
    lastCheckAttemptAt: databaseTimestamp(row, 'last_check_attempt_at'),
    lastSuccessfulCheckAt: databaseTimestamp(row, 'last_successful_check_at'),
    lastStatsUpdatedAt: databaseTimestamp(row, 'last_stats_updated_at'),
    lastNewOrderAt: databaseTimestamp(row, 'last_new_order_at'),
    lastTrackingErrorAt: databaseTimestamp(row, 'last_tracking_error_at'),
    lastTrackingErrorCode: databaseNullableString(row, 'last_tracking_error_code'),
    initialSetupDeferredUntil: databaseTimestamp(row, 'initial_setup_deferred_until'),
  };
};

const mapProvider = (value: unknown): ProviderExportPreference => {
  const row = databaseRow(value, 'provider export preference');
  return {
    requestId: databaseNullableString(row, 'request_id'),
    readyAlert: {
      lastCheckedAt: databaseTimestamp(row, 'alert_last_checked_at'),
      errorCode: databaseNullableString(row, 'alert_last_error_code'),
      consentState: row.alert_consent === 'granted' || row.alert_consent === 'declined' || row.alert_consent === 'revoked' ? row.alert_consent : 'not_offered',
      consentVersion: databaseNullableString(row, 'alert_consent_version'),
      consentedAt: databaseTimestamp(row, 'alert_consented_at'),
      revokedAt: databaseTimestamp(row, 'alert_revoked_at'),
      backgroundAvailable: false, canMonitor: false,
    },
    provider: databaseEnum(row, 'provider', EXPORT_PROVIDERS),
    status: databaseEnum(row, 'status', PROVIDER_EXPORT_LIFECYCLE_STATUSES),
    requestedAt: databaseTimestamp(row, 'requested_at'),
    updatedAt: databaseTimestamp(row, 'updated_at'),
    errorCode: databaseNullableString(row, 'error_code'),
    readySource: databaseNullableEnum(row, 'ready_source', EXPORT_READY_SOURCES),
    relevance: databaseEnum(row, 'relevance', PROVIDER_RELEVANCE_VALUES),
  };
};

/** Read-only projections for import preferences, tracking eligibility, and activity metrics. */
export class ImportPreferencesQueryRepository {
  constructor(private readonly database: DatabaseQueryExecutor) {}

  async get(userId: string): Promise<ImportPreferences> {
    const result = await this.database.query(
      `SELECT input.user_id,
              COALESCE(preferences.monitoring_consent_state, 'not_offered') AS monitoring_consent_state,
              preferences.monitoring_consent_version, preferences.monitoring_consented_at,
              preferences.monitoring_revoked_at,
              COALESCE(preferences.gmail_import_status, 'never_started') AS gmail_import_status,
              preferences.gmail_import_updated_at,
              COALESCE(preferences.gmail_imported_count, 0)::int AS gmail_imported_count,
              preferences.gmail_import_error_code, preferences.gmail_baseline_completed_at,
              COALESCE(preferences.ongoing_tracking_consent_state, 'not_offered') AS ongoing_tracking_consent_state,
              preferences.automatic_updates_offer_seen_at,
              preferences.ongoing_tracking_consent_version,
              preferences.ongoing_tracking_consented_at, preferences.ongoing_tracking_revoked_at,
              COALESCE(preferences.tracking_status, 'inactive') AS tracking_status,
              preferences.last_check_attempt_at, preferences.last_successful_check_at,
              preferences.last_stats_updated_at, preferences.last_new_order_at,
              preferences.last_tracking_error_at, preferences.last_tracking_error_code,
              preferences.initial_setup_deferred_until
       FROM (SELECT $1::UUID AS user_id) input
       LEFT JOIN user_import_preferences preferences ON preferences.user_id = input.user_id`,
      [userId],
    );
    return mapPreferences(result.rows[0]);
  }

  async getProviderExports(
    userId: string,
  ): Promise<Record<ExportProvider, ProviderExportPreference>> {
    const result = await this.database.query(
      `SELECT providers.provider,
              CASE
                WHEN COALESCE(preferences.status, 'not_started') = 'not_started'
                  AND EXISTS (
                    SELECT 1 FROM receipts
                    WHERE receipts.user_id = $1
                      AND ${receiptHasSourceSql('receipts', 'csv')}
                      AND receipts.receipt_type = providers.provider
                  ) THEN 'completed'
                ELSE COALESCE(preferences.status, 'not_started')
              END AS status,
              preferences.requested_at, preferences.request_id, preferences.alert_consent,
              preferences.alert_consent_version, preferences.alert_consented_at, preferences.alert_revoked_at,
              preferences.alert_last_checked_at, preferences.alert_last_error_code,
              CASE
                WHEN preferences.updated_at IS NULL THEN (
                  SELECT MAX(receipts.created_at) FROM receipts
                  WHERE receipts.user_id = $1
                    AND ${receiptHasSourceSql('receipts', 'csv')}
                    AND receipts.receipt_type = providers.provider
                )
                ELSE preferences.updated_at
              END AS updated_at,
              preferences.error_code, preferences.ready_source
              , CASE WHEN EXISTS (
                  SELECT 1 FROM receipts usage_receipt
                  WHERE usage_receipt.user_id = $1
                    AND usage_receipt.receipt_type = providers.provider
                    AND usage_receipt.data_source IN ('email', 'csv')
                ) THEN 'unknown'
                ELSE COALESCE(preferences.relevance, 'unknown')
                END AS relevance
       FROM (VALUES ('uber_eats'::VARCHAR(24)), ('doordash'::VARCHAR(24))) providers(provider)
       LEFT JOIN user_export_provider_preferences preferences
         ON preferences.user_id = $1 AND preferences.provider = providers.provider`,
      [userId],
    );
    const mapped = result.rows.map(mapProvider);
    const uberEats = mapped.find(({ provider }) => provider === 'uber_eats');
    const doorDash = mapped.find(({ provider }) => provider === 'doordash');
    if (!uberEats || !doorDash) {
      throw new Error('Invalid database result: both export providers are required');
    }
    return { uber_eats: uberEats, doordash: doorDash };
  }

  async getSetupGuidance(userId: string): Promise<ImportSetupGuidance> {
    const result = await this.database.query(
      `SELECT preferences.initial_setup_deferred_until
       FROM (SELECT $1::UUID AS user_id) input
       LEFT JOIN user_import_preferences preferences ON preferences.user_id = input.user_id`,
      [userId],
    );
    const row = databaseRow(result.rows[0], 'import setup guidance');
    return {
      initialSetupDeferredUntil: databaseTimestamp(row, 'initial_setup_deferred_until'),
    };
  }

  async getOrdersAddedThisWeek(userId: string, timezone: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COUNT(*)::int AS count FROM receipts r
       LEFT JOIN pg_timezone_names z
         ON LOWER(z.name)=LOWER(COALESCE(r.resolution->'timestamp'->>'timezone',$2))
       WHERE r.user_id = $1 AND ${receiptHasSourceSql('r', 'email')}
         AND ${receiptOrderPredicates('r').established}
         AND r.order_date IS NOT NULL AND z.name IS NOT NULL
         AND (r.order_date AT TIME ZONE z.name)::date >= DATE_TRUNC('week', NOW() AT TIME ZONE $2)::date
         AND (r.order_date AT TIME ZONE z.name)::date < (DATE_TRUNC('week', NOW() AT TIME ZONE $2) + INTERVAL '7 days')::date`,
      [userId, timezone],
    );
    return databaseNonNegativeInteger(databaseRow(result.rows[0], 'weekly order count'), 'count');
  }

  async getTrackingBaseline(userId: string): Promise<TrackingBaseline> {
    const result = await this.database.query(
      `SELECT preferences.gmail_baseline_completed_at,
              outlook.baseline_completed_at AS outlook_baseline_completed_at,
              COUNT(*) FILTER (
                WHERE ${receiptHasSourceSql('receipts', 'csv')} AND receipts.receipt_type = 'uber_eats'
              )::int AS uber_eats_export_count,
              COUNT(*) FILTER (
                WHERE ${receiptHasSourceSql('receipts', 'csv')} AND receipts.receipt_type = 'doordash'
              )::int AS doordash_export_count
       FROM (SELECT $1::UUID AS user_id) input
       LEFT JOIN user_import_preferences preferences ON preferences.user_id = input.user_id
       LEFT JOIN mailbox_import_states outlook
         ON outlook.user_id = input.user_id AND outlook.provider = 'microsoft'
       LEFT JOIN receipts ON receipts.user_id = input.user_id
       GROUP BY preferences.gmail_baseline_completed_at, outlook.baseline_completed_at`,
      [userId],
    );
    const row = databaseRow(result.rows[0], 'tracking baseline');
    return resolveTrackingBaseline({
      gmailBaselineCompletedAt: databaseTimestamp(row, 'gmail_baseline_completed_at'),
      outlookBaselineCompletedAt: databaseTimestamp(row, 'outlook_baseline_completed_at'),
      uberEatsExportCount: databaseNonNegativeInteger(row, 'uber_eats_export_count'),
      doorDashExportCount: databaseNonNegativeInteger(row, 'doordash_export_count'),
    });
  }

  async getEligibleTrackingUserIds(limit = 100): Promise<string[]> {
    const result = await this.database.query(
      `SELECT preferences.user_id
       FROM user_import_preferences preferences
       JOIN users ON users.id = preferences.user_id
       WHERE preferences.ongoing_tracking_consent_state = 'granted'
         AND (
           preferences.gmail_baseline_completed_at IS NOT NULL
           OR EXISTS (
               SELECT 1 FROM mailbox_import_states mailbox_state
               WHERE mailbox_state.user_id = preferences.user_id
                 AND mailbox_state.provider = 'microsoft'
                 AND mailbox_state.baseline_completed_at IS NOT NULL
             )
           OR EXISTS (
               SELECT 1 FROM receipts uber_receipt
               WHERE uber_receipt.user_id = preferences.user_id
                 AND ${receiptHasSourceSql('uber_receipt', 'csv')}
                 AND uber_receipt.receipt_type = 'uber_eats'
             )
           OR EXISTS (
               SELECT 1 FROM receipts doordash_receipt
               WHERE doordash_receipt.user_id = preferences.user_id
                 AND ${receiptHasSourceSql('doordash_receipt', 'csv')}
                 AND doordash_receipt.receipt_type = 'doordash'
             )
         )
         AND (
           (
             users.gmail_connected = TRUE
             AND users.gmail_connection_mode = 'offline'
             AND users.gmail_refresh_token IS NOT NULL
           )
           OR EXISTS (
             SELECT 1 FROM mailbox_connections mailbox
             WHERE mailbox.user_id = preferences.user_id
               AND mailbox.provider = 'microsoft'
               AND mailbox.status = 'connected'
               AND mailbox.connection_mode = 'offline'
           )
         )
         AND (preferences.last_check_attempt_at IS NULL OR preferences.last_check_attempt_at <= NOW() - INTERVAL '15 minutes')
       ORDER BY preferences.last_check_attempt_at ASC NULLS FIRST
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((value) =>
      databaseUuid(databaseRow(value, 'eligible tracking user'), 'user_id'),
    );
  }

  async getEligibleOutlookTrackingUserIds(limit = 100): Promise<string[]> {
    const result = await this.database.query(
      `SELECT preferences.user_id
       FROM user_import_preferences preferences
       WHERE preferences.ongoing_tracking_consent_state='granted'
         AND (
           EXISTS (SELECT 1 FROM mailbox_import_states state
             WHERE state.user_id=preferences.user_id AND state.provider='microsoft'
               AND state.baseline_completed_at IS NOT NULL)
           OR EXISTS (SELECT 1 FROM receipts receipt
             WHERE receipt.user_id=preferences.user_id AND ${receiptHasSourceSql('receipt', 'csv')})
         )
         AND EXISTS (SELECT 1 FROM mailbox_connections mailbox
           WHERE mailbox.user_id=preferences.user_id AND mailbox.provider='microsoft'
             AND mailbox.status='connected' AND mailbox.connection_mode='offline')
         AND (preferences.last_check_attempt_at IS NULL OR preferences.last_check_attempt_at<=NOW()-INTERVAL '15 minutes')
       ORDER BY preferences.last_check_attempt_at ASC NULLS FIRST LIMIT $1`,
      [limit],
    );
    return result.rows.map((value) =>
      databaseUuid(databaseRow(value, 'eligible Outlook tracking user'), 'user_id'),
    );
  }
}
