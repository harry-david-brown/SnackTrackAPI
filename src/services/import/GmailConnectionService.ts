import { AppError, ValidationError } from '../../core/errors';
import type {
  GmailSyncRunPort,
  ImportLifecyclePort,
  ImportPreferencesQueryPort,
  MailboxUserPort,
} from '../ports/ImportPorts';
import {
  GmailConnectionPurpose,
  GmailOAuthGrant,
  GmailOAuthPort,
  GmailOAuthState,
} from './GmailConnectionContracts';

const REQUIRED_GMAIL_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);
const ALLOWED_APP_REDIRECT_SCHEMES = new Set([
  'snacktrack:',
  'exp+snack-track:',
  'https:',
  'http:',
]);

type UserPort = Pick<MailboxUserPort, 'updateGmailTokens' | 'disconnectGmail'>;
type QueryPort = Pick<ImportPreferencesQueryPort, 'get'>;
type LifecyclePort = Pick<
  ImportLifecyclePort,
  'setMonitoringConsent' | 'setOngoingTrackingConsent'
>;
type SyncRunPort = Pick<GmailSyncRunPort, 'resetGmailImportStatus'>;
interface ConnectionHealthCachePort {
  invalidate(userId: string): void;
}

export interface GmailOAuthCallbackResult {
  readonly redirectUri: string;
  readonly userId: string;
  readonly purpose: GmailConnectionPurpose;
}

/** Owns Gmail connection authorization, credential persistence, and disconnect semantics. */
export class GmailConnectionService {
  constructor(
    private readonly oauth: GmailOAuthPort,
    private readonly users: UserPort,
    private readonly queries: QueryPort,
    private readonly lifecycle: LifecyclePort,
    private readonly syncRuns: SyncRunPort,
    private readonly connectionHealth: ConnectionHealthCachePort,
  ) {}

  createAuthorizationUrl(
    userId: string,
    redirectUri: string,
    purpose: GmailConnectionPurpose = 'receipt_import',
  ): string {
    this.parseAppRedirectUri(redirectUri);
    return this.oauth.createAuthorizationUrl({ userId, redirectUri, purpose });
  }

  async completeAuthorization(
    stateToken: string,
    code?: string,
    providerError?: string,
  ): Promise<GmailOAuthCallbackResult> {
    const state = this.oauth.verifyState(stateToken);
    this.parseAppRedirectUri(state.redirectUri);
    if (providerError) {
      return {
        redirectUri: this.callbackRedirect(state, 'error', providerError),
        userId: state.userId,
        purpose: state.purpose,
      };
    }
    if (!code) throw new ValidationError('Missing authorization code', 'code');

    const grant = await this.oauth.exchangeAuthorizationCode(code);
    this.assertRequiredScope(grant);
    const connectionMode = grant.refreshToken ? 'offline' : 'temporary';
    await this.users.updateGmailTokens(state.userId, {
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      expiryDate: grant.expiryDate,
      gmailEmail: grant.email,
      scopes: [...grant.scopes],
      connectionMode,
    });
    this.connectionHealth.invalidate(state.userId);
    return {
      redirectUri: this.callbackRedirect(state, 'success', undefined, connectionMode),
      userId: state.userId,
      purpose: state.purpose,
    };
  }

  failureRedirect(stateToken: string | undefined, error: unknown): string {
    let state: GmailOAuthState | undefined;
    if (stateToken) {
      try {
        state = this.oauth.verifyState(stateToken);
        this.parseAppRedirectUri(state.redirectUri);
      } catch {
        state = undefined;
      }
    }
    const safeState: GmailOAuthState = state ?? {
      userId: '',
      redirectUri: 'snacktrack://oauth-callback',
      purpose: 'receipt_import',
    };
    const message = error instanceof AppError ? error.publicMessage : 'gmail_oauth_failed';
    return this.callbackRedirect(safeState, 'error', message);
  }

  async disconnect(userId: string, resetImportStatus: boolean): Promise<void> {
    const preferences = await this.queries.get(userId);
    await this.users.disconnectGmail(userId);
    this.connectionHealth.invalidate(userId);
    if (preferences.monitoringConsentState === 'granted') {
      await this.lifecycle.setMonitoringConsent(userId, 'revoked');
    }
    if (preferences.ongoingTrackingConsentState === 'granted') {
      await this.lifecycle.setOngoingTrackingConsent(userId, 'revoked');
    }
    if (resetImportStatus) await this.syncRuns.resetGmailImportStatus(userId);
  }

  private assertRequiredScope(grant: GmailOAuthGrant): void {
    if (!grant.scopes.some((scope) => REQUIRED_GMAIL_SCOPES.has(scope))) {
      throw new ValidationError(
        'Gmail access was granted without a supported Gmail read scope.',
        'scope',
      );
    }
  }

  private parseAppRedirectUri(value: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (cause) {
      throw new ValidationError('redirectUri must be a valid absolute URI', 'redirectUri', cause);
    }
    if (!ALLOWED_APP_REDIRECT_SCHEMES.has(parsed.protocol)) {
      throw new ValidationError('redirectUri uses an unsupported scheme', 'redirectUri');
    }
    return parsed;
  }

  private callbackRedirect(
    state: GmailOAuthState,
    outcome: 'success' | 'error',
    error?: string,
    connectionMode?: 'temporary' | 'offline',
  ): string {
    const redirect = new URL(state.redirectUri);
    redirect.searchParams.set('gmail', outcome);
    redirect.searchParams.set('gmailPurpose', state.purpose);
    if (error) redirect.searchParams.set('error', error);
    if (connectionMode) redirect.searchParams.set('connectionMode', connectionMode);
    return redirect.toString();
  }
}
