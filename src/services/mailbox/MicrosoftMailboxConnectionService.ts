import type { MailboxAuthorizationPort } from '../ports/MailboxAuthorizationPort';
import { parseMailboxRedirect } from '../mailbox/MailboxRedirect';
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
    private readonly authorization: MailboxAuthorizationPort,
  ) {}

  async createAuthorizationUrl(
    userId: string,
    appRedirectUri: string,
    purpose: MailboxConnectionPurpose = 'receipt_import',
    handoffChallenge: string,
    sessionVersion: number,
  ): Promise<string> {
    parseMailboxRedirect(appRedirectUri);
    const url = await this.oauth.createAuthorizationUrl({ userId, appRedirectUri, purpose });
    await this.authorization.register(userId, 'outlook', url, handoffChallenge, sessionVersion);
    return url;
  }

  async completeAuthorization(
    stateToken: string,
    code?: string,
    providerError?: string,
  ): Promise<{ redirectUri: string; userId: string; purpose: MailboxConnectionPurpose }> {
    const state = this.oauth.verifyState(stateToken);
    parseMailboxRedirect(state.appRedirectUri);
    const completionToken = await this.authorization.receive('outlook', stateToken, providerError ? undefined : code);
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
    const redirect = new URL(this.callbackRedirect(state.appRedirectUri, state.purpose, 'pending'));
    redirect.searchParams.set('completionToken', completionToken);
    return { redirectUri: redirect.toString(), userId: state.userId, purpose: state.purpose };
  }

  async finishAuthorization(userId: string, completionToken: string, verifier: string): Promise<void> {
    const claim = await this.authorization.consume(userId, 'outlook', completionToken, verifier);
    const state = this.oauth.verifyState(claim.state);
    const grant = await this.oauth.exchangeAuthorizationCode(claim.code, state);
    if (
      !grant.scopes.some((scope) => {
        const normalized = scope.toLowerCase();
        return normalized === 'mail.read' || normalized.endsWith('/mail.read');
      })
    ) {
      throw new ValidationError('Outlook access was granted without Mail.Read.', 'scope');
    }
    await this.authorization.persist(claim, (transaction) => this.connections.saveMicrosoft({
      userId,
      providerAccountId: grant.providerAccountId,
      email: grant.email,
      scopes: grant.scopes,
      tokenExpiresAt: grant.tokenExpiresAt,
      credentials: {
        tokenCache: grant.tokenCache,
        homeAccountId: grant.providerAccountId,
      },
    }, transaction));
    this.health.invalidate(userId);
  }

  failureRedirect(stateToken: string | undefined, error: unknown): string {
    let appRedirectUri = 'snacktrack://oauth-callback';
    let purpose: MailboxConnectionPurpose = 'receipt_import';
    if (stateToken) {
      try {
        const state = this.oauth.verifyState(stateToken);
        parseMailboxRedirect(state.appRedirectUri);
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
    await this.authorization.cancel(userId, 'outlook');
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

  private callbackRedirect(
    appRedirectUri: string,
    purpose: MailboxConnectionPurpose,
    outcome: 'pending' | 'error',
    error?: string,
  ): string {
    const redirect = new URL(appRedirectUri);
    redirect.searchParams.set('outlook', outcome);
    redirect.searchParams.set('outlookPurpose', purpose);
    if (error) redirect.searchParams.set('error', error);
    return redirect.toString();
  }
}
