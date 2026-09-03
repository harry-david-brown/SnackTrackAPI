import { AppError, ValidationError } from '../../core/errors';
import type { UserRepository } from '../data/UserRepository';
import type { ImportLifecycleRepository } from '../data/ImportLifecycleRepository';
import type { ImportPreferencesQueryRepository } from '../data/ImportPreferencesQueryRepository';
import type { MailboxConnectionRepository } from '../data/MailboxConnectionRepository';
import type { MailboxSyncRunRepository } from '../data/MailboxSyncRunRepository';
import type { MicrosoftMailboxConnectionHealthService } from './MicrosoftMailboxConnectionHealthService';
import {
  type MailboxConnectionPurpose,
  type MicrosoftMailboxOAuthProvider,
} from './MicrosoftMailboxOAuthProvider';

const ALLOWED_APP_REDIRECT_SCHEMES = new Set([
  'snacktrack:',
  'exp+snack-track:',
  'https:',
  'http:',
]);

export class MicrosoftMailboxConnectionService {
  constructor(
    private readonly oauth: MicrosoftMailboxOAuthProvider,
    private readonly connections: MailboxConnectionRepository,
    private readonly users: Pick<UserRepository, 'findByIdWithGmailTokens'>,
    private readonly preferences: Pick<ImportPreferencesQueryRepository, 'get'>,
    private readonly lifecycle: Pick<
      ImportLifecycleRepository,
      'setMonitoringConsent' | 'setOngoingTrackingConsent'
    >,
    private readonly syncRuns: Pick<MailboxSyncRunRepository, 'resetMicrosoftImportStatus'>,
    private readonly health: Pick<MicrosoftMailboxConnectionHealthService, 'invalidate'>,
  ) {}

  async createAuthorizationUrl(
    userId: string,
    appRedirectUri: string,
    purpose: MailboxConnectionPurpose = 'receipt_import',
  ): Promise<string> {
    this.parseAppRedirectUri(appRedirectUri);
    return this.oauth.createAuthorizationUrl({ userId, appRedirectUri, purpose });
  }

  async completeAuthorization(
    stateToken: string,
    code?: string,
    providerError?: string,
  ): Promise<{ redirectUri: string; userId: string; purpose: MailboxConnectionPurpose }> {
    const state = this.oauth.verifyState(stateToken);
    this.parseAppRedirectUri(state.appRedirectUri);
    if (providerError) {
      return {
        redirectUri: this.callbackRedirect(
          state.appRedirectUri,
          state.purpose,
          'error',
          providerError === 'access_denied' ? 'authorization_denied' : 'outlook_oauth_failed',
        ),
        userId: state.userId,
        purpose: state.purpose,
      };
    }
    if (!code) throw new ValidationError('Missing authorization code', 'code');
    const grant = await this.oauth.exchangeAuthorizationCode(code, state);
    if (
      !grant.scopes.some((scope) => {
        const normalized = scope.toLowerCase();
        return normalized === 'mail.read' || normalized.endsWith('/mail.read');
      })
    ) {
      throw new ValidationError('Outlook access was granted without Mail.Read.', 'scope');
    }
    await this.connections.saveMicrosoft({
      userId: state.userId,
      providerAccountId: grant.providerAccountId,
      email: grant.email,
      scopes: grant.scopes,
      tokenExpiresAt: grant.tokenExpiresAt,
      credentials: {
        tokenCache: grant.tokenCache,
        homeAccountId: grant.providerAccountId,
      },
    });
    this.health.invalidate(state.userId);
    return {
      redirectUri: this.callbackRedirect(state.appRedirectUri, state.purpose, 'success', undefined),
      userId: state.userId,
      purpose: state.purpose,
    };
  }

  failureRedirect(stateToken: string | undefined, error: unknown): string {
    let appRedirectUri = 'snacktrack://oauth-callback';
    let purpose: MailboxConnectionPurpose = 'receipt_import';
    if (stateToken) {
      try {
        const state = this.oauth.verifyState(stateToken);
        this.parseAppRedirectUri(state.appRedirectUri);
        appRedirectUri = state.appRedirectUri;
        purpose = state.purpose;
      } catch {
        // Fall back to the allowlisted app callback without exposing state details.
      }
    }
    const message = error instanceof AppError ? error.publicMessage : 'outlook_oauth_failed';
    return this.callbackRedirect(appRedirectUri, purpose, 'error', message);
  }

  async disconnect(userId: string, resetImportStatus: boolean): Promise<void> {
    const [preferences, gmailUser] = await Promise.all([
      this.preferences.get(userId),
      this.users.findByIdWithGmailTokens(userId),
    ]);
    await this.connections.disconnectMicrosoft(userId);
    this.health.invalidate(userId);
    const durableGmail = Boolean(
      gmailUser?.gmailConnected &&
      gmailUser.gmailConnectionMode === 'offline' &&
      gmailUser.gmailRefreshToken,
    );
    if (!durableGmail) {
      if (preferences.monitoringConsentState === 'granted') {
        await this.lifecycle.setMonitoringConsent(userId, 'revoked');
      }
      if (preferences.ongoingTrackingConsentState === 'granted') {
        await this.lifecycle.setOngoingTrackingConsent(userId, 'revoked');
      }
    }
    if (resetImportStatus) await this.syncRuns.resetMicrosoftImportStatus(userId);
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
    appRedirectUri: string,
    purpose: MailboxConnectionPurpose,
    outcome: 'success' | 'error',
    error?: string,
  ): string {
    const redirect = new URL(appRedirectUri);
    redirect.searchParams.set('outlook', outcome);
    redirect.searchParams.set('outlookPurpose', purpose);
    if (error) redirect.searchParams.set('error', error);
    return redirect.toString();
  }
}
