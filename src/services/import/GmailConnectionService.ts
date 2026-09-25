import type { MailboxAuthorizationPort } from '../ports/MailboxAuthorizationPort';
import { parseMailboxRedirect } from '../mailbox/MailboxRedirect';
import { AppError, ValidationError } from '../../core/errors';
import type {
  GmailSyncRunPort,
  ImportLifecyclePort,
  ImportPreferencesQueryPort,
  MailboxUserPort,
  MicrosoftMailboxConnectionPort,
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

type UserPort = Pick<
  MailboxUserPort,
  'updateGmailTokens' | 'disconnectGmail' | 'markGmailReconnectRequired'
>;
type QueryPort = Pick<ImportPreferencesQueryPort, 'get'>;
type LifecyclePort = Pick<
  ImportLifecyclePort,
  'setMonitoringConsent' | 'setOngoingTrackingConsent' | 'markTrackingReconnectRequired'
>;
type SyncRunPort = Pick<GmailSyncRunPort, 'resetGmailImportStatus'>;
interface ConnectionHealthCachePort {
  invalidate(userId: string): void;
}
interface GmailWatchLifecycle {
  ensureForUser(userId: string): Promise<boolean>;
  stopForUser(userId: string): Promise<void>;
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
    private readonly authorization: MailboxAuthorizationPort,
    private readonly mailboxConnections?: Pick<MicrosoftMailboxConnectionPort, 'findMicrosoft'>,
    private readonly gmailWatches?: GmailWatchLifecycle,
  ) {}

  async createAuthorizationUrl(
    userId: string,
    redirectUri: string,
    purpose: GmailConnectionPurpose = 'receipt_import',
    handoffChallenge: string,
    sessionVersion: number,
  ): Promise<string> {
    parseMailboxRedirect(redirectUri);
    const url = this.oauth.createAuthorizationUrl({ userId, redirectUri, purpose });
    await this.authorization.register(userId, 'gmail', url, handoffChallenge, sessionVersion);
    return url;
  }

  async completeAuthorization(
    stateToken: string,
    code?: string,
    providerError?: string,
  ): Promise<GmailOAuthCallbackResult> {
    const state = this.oauth.verifyState(stateToken);
    parseMailboxRedirect(state.redirectUri);
    const completionToken = await this.authorization.receive('gmail', stateToken, providerError ? undefined : code);
    if (providerError) {
      return {
        redirectUri: this.callbackRedirect(state, 'error', providerError),
        userId: state.userId,
        purpose: state.purpose,
      };
    }
    if (!code) throw new ValidationError('Missing authorization code', 'code');

    const redirect = new URL(this.callbackRedirect(state, 'pending'));
    redirect.searchParams.set('completionToken', completionToken);
    return { redirectUri: redirect.toString(), userId: state.userId, purpose: state.purpose };
  }

  async finishAuthorization(userId: string, completionToken: string, verifier: string): Promise<void> {
    const claim = await this.authorization.consume(userId, 'gmail', completionToken, verifier);
    const state = this.oauth.verifyState(claim.state);
    const grant = await this.oauth.exchangeAuthorizationCode(claim.code, state);
    this.assertRequiredScope(grant);
    await this.authorization.persist(claim, (transaction) => this.users.updateGmailTokens(userId, {
      refreshToken: grant.refreshToken, accessToken: grant.accessToken,
      expiryDate: grant.expiryDate, gmailEmail: grant.email, scopes: [...grant.scopes],
      connectionMode: grant.refreshToken ? 'offline' : 'temporary',
    }, transaction));
    this.connectionHealth.invalidate(userId);
    await this.gmailWatches?.ensureForUser(userId).catch(() => false);
  }

  failureRedirect(stateToken: string | undefined, error: unknown): string {
    let state: GmailOAuthState | undefined;
    if (stateToken) {
      try {
        state = this.oauth.verifyState(stateToken);
        parseMailboxRedirect(state.redirectUri);
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
    await this.authorization.cancel(userId, 'gmail');
    const [preferences, microsoft] = await Promise.all([
      this.queries.get(userId),
      this.mailboxConnections?.findMicrosoft(userId),
    ]);
    await this.gmailWatches?.stopForUser(userId);
    await this.users.disconnectGmail(userId);
    this.connectionHealth.invalidate(userId);
    const durableMicrosoft = Boolean(
      microsoft && microsoft.state === 'connected' && microsoft.connectionMode === 'offline',
    );
    if (!durableMicrosoft && preferences.monitoringConsentState === 'granted') {
      await this.lifecycle.setMonitoringConsent(userId, 'revoked');
    }
    if (!durableMicrosoft && preferences.ongoingTrackingConsentState === 'granted') {
      await this.lifecycle.setOngoingTrackingConsent(userId, 'revoked');
    }
    if (resetImportStatus) await this.syncRuns.resetGmailImportStatus(userId);
  }

  /** Simulates an invalid Gmail grant so clients exercise their normal reconnect flow. */
  async expireForTesting(userId: string): Promise<void> {
    await this.gmailWatches?.stopForUser(userId);
    await this.users.markGmailReconnectRequired(userId);
    this.connectionHealth.invalidate(userId);
    await this.lifecycle.markTrackingReconnectRequired(userId);
  }

  private assertRequiredScope(grant: GmailOAuthGrant): void {
    if (!grant.scopes.some((scope) => REQUIRED_GMAIL_SCOPES.has(scope))) {
      throw new ValidationError(
        'Gmail access was granted without a supported Gmail read scope.',
        'scope',
      );
    }
  }

  private callbackRedirect(
    state: GmailOAuthState,
    outcome: 'pending' | 'error',
    error?: string,
  ): string {
    const redirect = new URL(state.redirectUri);
    redirect.searchParams.set('gmail', outcome);
    redirect.searchParams.set('gmailPurpose', state.purpose);
    if (error) redirect.searchParams.set('error', error);
    return redirect.toString();
  }
}
