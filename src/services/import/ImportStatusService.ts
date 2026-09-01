import { NotFoundError } from '../../core/errors';
import { User } from '../../models/User';
import type {
  ImportPreferences,
  ImportSourceCoverage,
  ProviderExportPreference,
  TrackingBaseline,
} from './ImportLifecycleTypes';
import { resolveTrackingBaseline } from './ImportLifecycleTypes';
import type { GmailConnectionMode } from './GmailConnectionContracts';
import type {
  ImportPreferencesQueryPort,
  ImportSourceCoveragePort,
  MailboxUserPort,
} from '../ports/ImportPorts';

const REQUIRED_GMAIL_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);

export type GmailConnectionHealth = 'disconnected' | 'valid' | 'reconnect_required' | 'unavailable';
export interface GmailConnectionStatus {
  readonly connected: boolean;
  readonly canImport: boolean;
  readonly needsReconnect: boolean;
  readonly email: string;
  readonly connectionMode: GmailConnectionMode;
  readonly scopes: readonly string[];
  readonly hasRequiredScope: boolean;
  readonly expiresAt: string | null;
  readonly connectionHealth: GmailConnectionHealth;
  readonly lastValidatedAt: string | null;
  readonly statusMessage: string;
}

export interface GmailConnectionHealthResult {
  readonly status: GmailConnectionHealth;
  readonly validatedAt: string | null;
}

interface ConnectionHealthPort {
  validate(user: User, force?: boolean): Promise<GmailConnectionHealthResult>;
}

type UserPort = Pick<MailboxUserPort, 'findByIdWithGmailTokens' | 'updateTimezone'>;
type PreferencesPort = Pick<
  ImportPreferencesQueryPort,
  'get' | 'getProviderExports' | 'getOrdersAddedThisWeek'
>;
type SourceCoveragePort = Pick<ImportSourceCoveragePort, 'getForUser'>;

export type MonitoringEffectiveState =
  'not_offered' | 'declined' | 'enabled' | 'disabled' | 'reconnect_required';

export type TrackingEffectiveState =
  'not_offered' | 'declined' | 'setting_up' | 'active' | 'paused' | 'reconnect_required' | 'error';

export interface ImportPreferencesProjection {
  readonly gmailConnection: GmailConnectionStatus;
  readonly monitoring: {
    readonly consentState: ImportPreferences['monitoringConsentState'];
    readonly consentVersion: string | null;
    readonly consentedAt: string | null;
    readonly revokedAt: string | null;
    readonly effectiveState: MonitoringEffectiveState;
    readonly capability: {
      readonly gmailConnected: boolean;
      readonly durableAccess: boolean;
      readonly needsReconnect: boolean;
      readonly connectionHealth: GmailConnectionHealth;
      readonly lastValidatedAt: string | null;
      readonly canMonitor: boolean;
    };
  };
  readonly export: {
    readonly providers: {
      readonly uberEats: ProviderExportPreference;
      readonly doorDash: ProviderExportPreference;
    };
  };
  readonly gmailBaseline: {
    readonly hasCompleted: boolean;
    readonly completedAt: string | null;
    readonly latestAttempt: {
      readonly status: ImportPreferences['gmailImportStatus'];
      readonly updatedAt: string | null;
      readonly importedCount: number;
      readonly errorCode: string | null;
    };
  };
  readonly ongoingTracking: {
    readonly consentState: ImportPreferences['ongoingTrackingConsentState'];
    readonly consentVersion: string | null;
    readonly consentedAt: string | null;
    readonly revokedAt: string | null;
    readonly status: ImportPreferences['trackingStatus'];
    readonly effectiveState: TrackingEffectiveState;
    readonly baseline: TrackingBaseline;
    readonly capability: {
      readonly gmailConnected: boolean;
      readonly durableAccess: boolean;
      readonly needsReconnect: boolean;
      readonly connectionHealth: GmailConnectionHealth;
      readonly lastValidatedAt: string | null;
      readonly canTrack: boolean;
    };
    readonly activity: {
      readonly lastCheckAttemptAt: string | null;
      readonly lastSuccessfulCheckAt: string | null;
      readonly lastStatsUpdatedAt: string | null;
      readonly lastNewOrderAt: string | null;
      readonly ordersAddedThisWeek: number;
      readonly lastErrorAt: string | null;
      readonly lastErrorCode: string | null;
    };
  };
  readonly coverage: ImportSourceCoverage;
}

const connectionModeFor = (user: User): GmailConnectionMode => {
  if (user.gmailConnectionMode === 'offline' || user.gmailConnectionMode === 'temporary') {
    return user.gmailConnectionMode;
  }
  if (user.gmailRefreshToken) return 'offline';
  if (user.gmailAccessToken) return 'temporary';
  return 'none';
};

const expiryFor = (user: User): Date | null => {
  if (!user.gmailTokenExpiry) return null;
  const expiry = new Date(user.gmailTokenExpiry);
  return Number.isNaN(expiry.getTime()) ? null : expiry;
};

export const buildGmailConnectionStatus = (
  user: User,
  health: GmailConnectionHealthResult | undefined,
  now = new Date(),
): GmailConnectionStatus => {
  const scopes = user.gmailScopes ?? [];
  const connectionMode = connectionModeFor(user);
  const expiryDate = expiryFor(user);
  const hasRequiredScope = scopes.some((scope) => REQUIRED_GMAIL_SCOPES.has(scope));
  const accessTokenUsable = Boolean(
    user.gmailAccessToken && (!expiryDate || expiryDate.getTime() > now.getTime()),
  );
  const credentialRejected = health?.status === 'reconnect_required';
  const canImport =
    hasRequiredScope && Boolean(user.gmailRefreshToken || accessTokenUsable) && !credentialRejected;
  const connected = Boolean(user.gmailConnected && connectionMode !== 'none');
  const needsReconnect = credentialRejected || (connected && !canImport);

  let statusMessage = 'Connect your Gmail account to import receipts.';
  if (needsReconnect) {
    statusMessage = 'Gmail needs to be reconnected before imports can run.';
  } else if (connected && connectionMode === 'offline') {
    statusMessage = 'Gmail is connected with durable access for imports you explicitly allow.';
  } else if (connected && connectionMode === 'temporary' && canImport && expiryDate) {
    statusMessage = `Gmail is connected with temporary access until ${expiryDate.toISOString()}.`;
  } else if (connected && connectionMode === 'temporary') {
    statusMessage = 'Gmail is connected with temporary access. Reconnect when the token expires.';
  }

  return {
    connected,
    canImport,
    needsReconnect,
    email: user.gmailEmail || user.email,
    connectionMode,
    scopes,
    hasRequiredScope,
    expiresAt: expiryDate?.toISOString() ?? null,
    connectionHealth: health?.status ?? (connected ? 'valid' : 'disconnected'),
    lastValidatedAt: health?.validatedAt ?? null,
    statusMessage,
  };
};

const monitoringState = (
  preferences: ImportPreferences,
  status: GmailConnectionStatus,
): MonitoringEffectiveState => {
  if (preferences.monitoringConsentState === 'granted') {
    return status.connected && status.canImport && status.connectionMode === 'offline'
      ? 'enabled'
      : 'reconnect_required';
  }
  if (preferences.monitoringConsentState === 'declined') return 'declined';
  if (preferences.monitoringConsentState === 'revoked') return 'disabled';
  return 'not_offered';
};

const trackingState = (
  preferences: ImportPreferences,
  status: GmailConnectionStatus,
): TrackingEffectiveState => {
  if (preferences.ongoingTrackingConsentState === 'granted') {
    if (!status.connected || !status.canImport || status.connectionMode !== 'offline') {
      return 'reconnect_required';
    }
    if (preferences.trackingStatus === 'error') return 'error';
    if (preferences.trackingStatus === 'setting_up') return 'setting_up';
    if (preferences.trackingStatus === 'inactive' || preferences.trackingStatus === 'paused') {
      return 'paused';
    }
    return 'active';
  }
  if (preferences.ongoingTrackingConsentState === 'declined') return 'declined';
  if (preferences.ongoingTrackingConsentState === 'revoked') return 'paused';
  return 'not_offered';
};

/** Application owner for Gmail connection health and the canonical import-state projection. */
export class ImportStatusService {
  constructor(
    private readonly users: UserPort,
    private readonly health: ConnectionHealthPort,
    private readonly preferences: PreferencesPort,
    private readonly sourceCoverage: SourceCoveragePort,
  ) {}

  async getConnection(
    userId: string,
    force = false,
  ): Promise<{
    user: User;
    health: GmailConnectionHealthResult;
    status: GmailConnectionStatus;
  }> {
    let user = await this.users.findByIdWithGmailTokens(userId);
    if (!user) throw new NotFoundError('User', userId);
    const health = await this.health.validate(user, force);
    if (health.status === 'reconnect_required') {
      user = await this.users.findByIdWithGmailTokens(userId);
      if (!user) throw new NotFoundError('User', userId);
    }
    return { user, health, status: buildGmailConnectionStatus(user, health) };
  }

  async getPreferences(
    userId: string,
    requestTimezone?: string,
  ): Promise<ImportPreferencesProjection> {
    if (requestTimezone) await this.users.updateTimezone(userId, requestTimezone);
    const [{ user, status }, preferences, coverage, providers] = await Promise.all([
      this.getConnection(userId),
      this.preferences.get(userId),
      this.sourceCoverage.getForUser(userId),
      this.preferences.getProviderExports(userId),
    ]);
    const ordersAddedThisWeek = await this.preferences.getOrdersAddedThisWeek(
      userId,
      user.timezone || 'America/New_York',
    );
    const trackingBaseline = resolveTrackingBaseline({
      gmailBaselineCompletedAt: preferences.gmailBaselineCompletedAt,
      uberEatsExportCount: coverage.exportProviders.uberEats.receiptCount,
      doorDashExportCount: coverage.exportProviders.doorDash.receiptCount,
    });
    const durableGmail =
      status.connectionHealth === 'valid' &&
      status.connected &&
      status.canImport &&
      status.connectionMode === 'offline';

    return {
      gmailConnection: status,
      monitoring: {
        consentState: preferences.monitoringConsentState,
        consentVersion: preferences.monitoringConsentVersion,
        consentedAt: preferences.monitoringConsentedAt,
        revokedAt: preferences.monitoringRevokedAt,
        effectiveState: monitoringState(preferences, status),
        capability: {
          gmailConnected: status.connected,
          durableAccess: status.connectionMode === 'offline',
          needsReconnect: status.needsReconnect,
          connectionHealth: status.connectionHealth,
          lastValidatedAt: status.lastValidatedAt,
          canMonitor: durableGmail,
        },
      },
      export: {
        providers: { uberEats: providers.uber_eats, doorDash: providers.doordash },
      },
      gmailBaseline: {
        hasCompleted: preferences.gmailBaselineCompletedAt !== null,
        completedAt: preferences.gmailBaselineCompletedAt,
        latestAttempt: {
          status: preferences.gmailImportStatus,
          updatedAt: preferences.gmailImportUpdatedAt,
          importedCount: preferences.gmailImportedCount,
          errorCode: preferences.gmailImportErrorCode,
        },
      },
      ongoingTracking: {
        consentState: preferences.ongoingTrackingConsentState,
        consentVersion: preferences.ongoingTrackingConsentVersion,
        consentedAt: preferences.ongoingTrackingConsentedAt,
        revokedAt: preferences.ongoingTrackingRevokedAt,
        status: preferences.trackingStatus,
        effectiveState: trackingState(preferences, status),
        baseline: trackingBaseline,
        capability: {
          gmailConnected: status.connected,
          durableAccess: status.connectionMode === 'offline',
          needsReconnect: status.needsReconnect,
          connectionHealth: status.connectionHealth,
          lastValidatedAt: status.lastValidatedAt,
          canTrack: durableGmail,
        },
        activity: {
          lastCheckAttemptAt: preferences.lastCheckAttemptAt,
          lastSuccessfulCheckAt: preferences.lastSuccessfulCheckAt,
          lastStatsUpdatedAt: preferences.lastStatsUpdatedAt,
          lastNewOrderAt: preferences.lastNewOrderAt,
          ordersAddedThisWeek,
          lastErrorAt: preferences.lastTrackingErrorAt,
          lastErrorCode: preferences.lastTrackingErrorCode,
        },
      },
      coverage,
    };
  }
}
