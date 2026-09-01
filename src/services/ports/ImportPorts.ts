import type { User } from '../../models/User';
import type {
  ExportProvider,
  ExportReadySource,
  GmailSyncTrigger,
  ImportPreferences,
  ImportSourceCoverage,
  MonitoringConsentState,
  ProviderExportLifecycleStatus,
  ProviderExportPreference,
  SyncRunCounts,
  TrackingBaseline,
} from '../import/ImportLifecycleTypes';
import type { GmailConnectionMode } from '../import/GmailConnectionContracts';
import type { ImportLockHandle } from '../import/ImportLockService';

export interface MailboxUserPort {
  findById(userId: string): Promise<User | undefined>;
  findByIdWithGmailTokens(userId: string): Promise<User | undefined>;
  updateTimezone(userId: string, timezone: string): Promise<void>;
  updateGmailTokens(
    userId: string,
    input: {
      refreshToken?: string | null;
      accessToken: string;
      expiryDate: Date;
      gmailEmail?: string;
      scopes: string[];
      connectionMode: Exclude<GmailConnectionMode, 'none'>;
    },
  ): Promise<void>;
  disconnectGmail(userId: string): Promise<void>;
  markGmailReconnectRequired(userId: string): Promise<void>;
}

export interface ImportLifecyclePort {
  setMonitoringConsent(
    userId: string,
    decision: Exclude<MonitoringConsentState, 'not_offered'>,
    consentVersion?: string,
  ): Promise<void>;
  setOngoingTrackingConsent(
    userId: string,
    decision: Exclude<MonitoringConsentState, 'not_offered'>,
    consentVersion?: string,
  ): Promise<void>;
  markExportRequested(userId: string, provider: ExportProvider): Promise<void>;
  setExportStatus(
    userId: string,
    provider: ExportProvider,
    status: ProviderExportLifecycleStatus,
    errorCode?: string,
    readySource?: ExportReadySource,
  ): Promise<boolean>;
  confirmExportReady(userId: string, provider: ExportProvider): Promise<boolean>;
  markTrackingReconnectRequired(userId: string): Promise<void>;
}

export interface ImportPreferencesQueryPort {
  get(userId: string): Promise<ImportPreferences>;
  getProviderExports(userId: string): Promise<Record<ExportProvider, ProviderExportPreference>>;
  getOrdersAddedThisWeek(userId: string, timezone: string): Promise<number>;
  getTrackingBaseline(userId: string): Promise<TrackingBaseline>;
  getEligibleTrackingUserIds(limit?: number): Promise<string[]>;
}

export interface GmailSyncRunPort {
  resetGmailImportStatus(userId: string): Promise<void>;
  startSyncRun(userId: string, trigger: GmailSyncTrigger): Promise<string>;
  completeSyncRun(
    runId: string,
    userId: string,
    outcome: 'success' | 'partial',
    counts: SyncRunCounts,
    trigger: GmailSyncTrigger,
  ): Promise<void>;
  failSyncRun(
    runId: string,
    userId: string,
    errorCode: string,
    trigger: GmailSyncTrigger,
  ): Promise<void>;
}

export interface ImportSourceCoveragePort {
  getForUser(userId: string): Promise<ImportSourceCoverage>;
}

export interface ReceiptWriterLockPort {
  acquireLock(userId: string): Promise<ImportLockHandle | null>;
  assertLockOwned(handle: ImportLockHandle): Promise<void>;
  releaseLock(handle: ImportLockHandle): Promise<boolean>;
}
