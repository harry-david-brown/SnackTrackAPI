import type { DatabaseQueryExecutor } from './DatabasePort';
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
  ProviderRelevance,
  ImportSetupGuidance,
  SyncRunCounts,
  TrackingBaseline,
} from '../import/ImportLifecycleTypes';
import type { GmailConnectionMode } from '../import/GmailConnectionContracts';
import type { ImportLockHandle } from '../import/ImportLockService';
import type {
  MailboxImportState,
  MicrosoftMailboxConnection,
  MicrosoftMailboxConnectionStatus,
} from '../mailbox/MailboxConnection';
import type { MicrosoftMailboxHealthResult } from '../mailbox/MicrosoftMailboxConnectionHealthService';

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
    executor?: DatabaseQueryExecutor,
  ): Promise<void>;
  disconnectGmail(userId: string): Promise<void>;
  markGmailReconnectRequired(userId: string): Promise<void>;
}

export interface ImportLifecyclePort {
  markAutomaticUpdatesOfferSeen(userId: string): Promise<void>;
  setInitialSetupDeferral(userId: string, decision: 'defer' | 'resume'): Promise<void>;
  setProviderRelevance(
    userId: string,
    provider: ExportProvider,
    relevance: ProviderRelevance,
  ): Promise<boolean>;
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
    eventMetadata?: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<boolean>;
  confirmExportReady(userId: string, provider: ExportProvider): Promise<boolean>;
  markTrackingReconnectRequired(userId: string): Promise<void>;
  markTrackingError(userId: string, errorCode: string): Promise<void>;
}

export interface ImportPreferencesQueryPort {
  get(userId: string): Promise<ImportPreferences>;
  getProviderExports(userId: string): Promise<Record<ExportProvider, ProviderExportPreference>>;
  getSetupGuidance(userId: string): Promise<ImportSetupGuidance>;
  getOrdersAddedThisWeek(userId: string, timezone: string): Promise<number>;
  getTrackingBaseline(userId: string): Promise<TrackingBaseline>;
  getEligibleTrackingUserIds(limit?: number): Promise<string[]>;
  getEligibleOutlookTrackingUserIds(limit?: number): Promise<string[]>;
}

export interface ScheduledImportJobPort {
  create(input: {
    userId: string;
    kind: 'scheduled_tracking';
    trigger: 'scheduler';
    journeyContext: 'routine';
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface GmailSyncRunPort {
  resetGmailImportStatus(userId: string): Promise<void>;
  startSyncRun(userId: string, trigger: GmailSyncTrigger, importJobId?: string): Promise<string>;
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

export interface MicrosoftMailboxConnectionPort {
  findMicrosoft(userId: string): Promise<MicrosoftMailboxConnection | undefined>;
  getMicrosoftImportState(userId: string): Promise<MailboxImportState>;
  markMicrosoftReconnectRequired(userId: string): Promise<void>;
}

export interface MicrosoftMailboxHealthPort {
  validate(
    userId: string,
    force?: boolean,
  ): Promise<{
    connection: MicrosoftMailboxConnection | undefined;
    health: MicrosoftMailboxHealthResult;
  }>;
  buildStatus(
    connection: MicrosoftMailboxConnection | undefined,
    health: MicrosoftMailboxHealthResult,
  ): MicrosoftMailboxConnectionStatus;
}

export interface MicrosoftMailboxSyncRunPort {
  startSyncRun(userId: string, trigger: 'manual' | 'background', importJobId?: string): Promise<string>;
  completeSyncRun(
    runId: string,
    userId: string,
    outcome: 'success' | 'partial',
    counts: SyncRunCounts,
    trigger: 'manual' | 'background',
  ): Promise<void>;
  failSyncRun(
    runId: string,
    userId: string,
    errorCode: string,
    trigger: 'manual' | 'background',
  ): Promise<void>;
}
