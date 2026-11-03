export const MONITORING_CONSENT_STATES = ['not_offered', 'declined', 'granted', 'revoked'] as const;
export type MonitoringConsentState = (typeof MONITORING_CONSENT_STATES)[number];
export const CONSENT_DECISIONS = ['declined', 'granted', 'revoked'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

export const GMAIL_IMPORT_STATUSES = ['never_started', 'importing', 'completed', 'failed'] as const;
export type GmailImportStatus = (typeof GMAIL_IMPORT_STATUSES)[number];

export const ONGOING_TRACKING_STATUSES = [
  'inactive',
  'setting_up',
  'active',
  'paused',
  'reconnect_required',
  'error',
] as const;
export type OngoingTrackingStatus = (typeof ONGOING_TRACKING_STATUSES)[number];

export const EXPORT_PROVIDERS = ['uber_eats', 'doordash'] as const;
export type ExportProvider = (typeof EXPORT_PROVIDERS)[number];
export const PROVIDER_RELEVANCE_VALUES = ['unknown', 'not_used'] as const;
export type ProviderRelevance = (typeof PROVIDER_RELEVANCE_VALUES)[number];

export const PROVIDER_EXPORT_LIFECYCLE_STATUSES = [
  'not_started',
  'requested',
  'file_ready',
  'import_processing',
  'completed',
  'failed',
] as const;
export type ProviderExportLifecycleStatus = (typeof PROVIDER_EXPORT_LIFECYCLE_STATUSES)[number];

export const EXPORT_READY_SOURCES = ['detected_email', 'user_confirmed'] as const;
export type ExportReadySource = (typeof EXPORT_READY_SOURCES)[number];

export const GMAIL_SYNC_TRIGGERS = ['manual', 'background'] as const;
export type GmailSyncTrigger = (typeof GMAIL_SYNC_TRIGGERS)[number];

const includes = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === 'string' && values.some((candidate) => candidate === value);

export const isConsentDecision = (value: unknown): value is ConsentDecision =>
  includes(CONSENT_DECISIONS, value);
export const isExportProvider = (value: unknown): value is ExportProvider =>
  includes(EXPORT_PROVIDERS, value);
export const isProviderRelevance = (value: unknown): value is ProviderRelevance =>
  includes(PROVIDER_RELEVANCE_VALUES, value);

export interface ProviderReadyAlert {
  lastCheckedAt?: string | null;
  errorCode?: string | null;
  effectiveState?: 'off' | 'active' | 'reconnect_required' | 'unavailable' | 'error';
  consentState: MonitoringConsentState;
  consentVersion: string | null;
  consentedAt: string | null;
  revokedAt: string | null;
  backgroundAvailable: boolean;
  canMonitor: boolean;
}
export interface ProviderExportPreference {
  requestId?: string | null;
  readyAlert?: ProviderReadyAlert;
  provider: ExportProvider;
  status: ProviderExportLifecycleStatus;
  requestedAt: string | null;
  updatedAt: string | null;
  errorCode: string | null;
  readySource: ExportReadySource | null;
  relevance: ProviderRelevance;
}

export interface ImportSetupGuidance {
  initialSetupDeferredUntil: string | null;
}

export interface ImportPreferences {
  userId: string;
  monitoringConsentState: MonitoringConsentState;
  monitoringConsentVersion: string | null;
  monitoringConsentedAt: string | null;
  monitoringRevokedAt: string | null;
  gmailImportStatus: GmailImportStatus;
  gmailImportUpdatedAt: string | null;
  gmailImportedCount: number;
  gmailImportErrorCode: string | null;
  gmailBaselineCompletedAt: string | null;
  automaticUpdatesOfferSeenAt?: string | null;
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
  initialSetupDeferredUntil: string | null;
}

export interface SyncRunCounts {
  receiptOutcome?: import('./ReceiptImportOutcome').ReceiptImportOutcome;
  emailsScanned: number;
  receiptsProcessed: number;
  supportedReceiptsFound: number;
  exportCoveredReceipts: number;
  eligibleReceipts: number;
  deduplicatedReceipts: number;
  newOrders: number;
  updatedOrders: number;
  unchangedOrders: number;
  rejectedMessages: number;
  decodedBytesExamined: number;
}

export interface TrackingBaseline {
  eligible: boolean;
  source: 'gmail' | 'outlook' | 'exports' | 'none';
}

export interface ProviderSourceCoverage {
  /** Canonical records containing this source, including unresolved evidence; not documents. */
  readonly receiptCount: number;
  readonly hasData: boolean;
  /** Observed order range, excluding unlinked adjustments; not verified export completeness. */
  readonly earliestOrderDate: string | null;
  readonly latestOrderDate: string | null;
}

export interface ImportSourceCoverage {
  /** Overlapping source sets: a combined order contributes once to each, never sum them. */
  readonly emailReceiptCount: number;
  readonly exportReceiptCount: number;
  readonly hasEmailData: boolean;
  readonly hasExportData: boolean;
  readonly emailProviders: {
    readonly uberEats: ProviderSourceCoverage;
    readonly doorDash: ProviderSourceCoverage;
  };
  readonly exportProviders: {
    readonly uberEats: ProviderSourceCoverage;
    readonly doorDash: ProviderSourceCoverage;
  };
}

export const resolveTrackingBaseline = ({
  gmailBaselineCompletedAt,
  outlookBaselineCompletedAt,
  uberEatsExportCount,
  doorDashExportCount,
}: {
  gmailBaselineCompletedAt: unknown;
  outlookBaselineCompletedAt?: unknown;
  uberEatsExportCount: number;
  doorDashExportCount: number;
}): TrackingBaseline => {
  if (uberEatsExportCount > 0 || doorDashExportCount > 0) {
    return { eligible: true, source: 'exports' };
  }
  if (gmailBaselineCompletedAt) return { eligible: true, source: 'gmail' };
  if (outlookBaselineCompletedAt) return { eligible: true, source: 'outlook' };
  return { eligible: false, source: 'none' };
};
