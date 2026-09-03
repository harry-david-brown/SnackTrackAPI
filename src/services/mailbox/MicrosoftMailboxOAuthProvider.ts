import {
  ConfidentialClientApplication,
  CryptoProvider,
  type AuthenticationResult,
} from '@azure/msal-node';
import { AppError, ValidationError } from '../../core/errors';
import type { MailboxSecretCipher } from './MailboxSecretCipher';

export const MICROSOFT_MAIL_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
] as const;

/** Resource scopes used after consent has been established. */
export const MICROSOFT_GRAPH_MAIL_SCOPES = ['https://graph.microsoft.com/Mail.Read'] as const;

export const MAILBOX_CONNECTION_PURPOSES = [
  'receipt_import',
  'export_ready_alerts',
  'ongoing_tracking',
  'connection_recovery',
  'manage_connection',
] as const;
export type MailboxConnectionPurpose = (typeof MAILBOX_CONNECTION_PURPOSES)[number];

interface MicrosoftMailboxOAuthState {
  readonly userId: string;
  readonly appRedirectUri: string;
  readonly purpose: MailboxConnectionPurpose;
  readonly codeVerifier: string;
  readonly expiresAt: number;
}

export interface MicrosoftMailboxOAuthGrant {
  readonly providerAccountId: string;
  readonly email: string;
  readonly scopes: readonly string[];
  readonly tokenExpiresAt: Date | null;
  readonly tokenCache: string;
}

export interface MicrosoftMailboxOAuthConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackRedirectUri?: string;
  readonly authority: string;
}

const parseState = (value: unknown): MicrosoftMailboxOAuthState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('OAuth state is invalid or expired', 'state');
  }
  const state = value as Record<string, unknown>;
  const purpose = state.purpose;
  if (
    typeof state.userId !== 'string' ||
    typeof state.appRedirectUri !== 'string' ||
    typeof state.codeVerifier !== 'string' ||
    typeof state.expiresAt !== 'number' ||
    typeof purpose !== 'string' ||
    !MAILBOX_CONNECTION_PURPOSES.includes(purpose as MailboxConnectionPurpose)
  ) {
    throw new ValidationError('OAuth state is invalid or expired', 'state');
  }
  return {
    userId: state.userId,
    appRedirectUri: state.appRedirectUri,
    codeVerifier: state.codeVerifier,
    expiresAt: state.expiresAt,
    purpose: purpose as MailboxConnectionPurpose,
  };
};

/** MSAL confidential-client adapter for delegated Microsoft mailbox consent. */
export class MicrosoftMailboxOAuthProvider {
  private readonly crypto = new CryptoProvider();

  constructor(
    private readonly configuration: MicrosoftMailboxOAuthConfig,
    private readonly cipher: MailboxSecretCipher,
    private readonly now: () => number = Date.now,
  ) {}

  async createAuthorizationUrl(input: {
    userId: string;
    appRedirectUri: string;
    purpose: MailboxConnectionPurpose;
  }): Promise<string> {
    const { verifier, challenge } = await this.crypto.generatePkceCodes();
    const state = this.cipher.encrypt(
      JSON.stringify({
        ...input,
        codeVerifier: verifier,
        expiresAt: this.now() + 10 * 60 * 1000,
      }),
    );
    return this.client().getAuthCodeUrl({
      scopes: [...MICROSOFT_MAIL_SCOPES],
      redirectUri: this.requiredConfiguration().callbackRedirectUri,
      responseMode: 'query',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      prompt: 'select_account',
      state,
    });
  }

  verifyState(token: string): MicrosoftMailboxOAuthState {
    try {
      const state = parseState(JSON.parse(this.cipher.decrypt(token)) as unknown);
      if (state.expiresAt < this.now()) {
        throw new ValidationError('OAuth state is invalid or expired', 'state');
      }
      return state;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError('OAuth state is invalid or expired', 'state', error);
    }
  }

  async exchangeAuthorizationCode(
    code: string,
    state: MicrosoftMailboxOAuthState,
  ): Promise<MicrosoftMailboxOAuthGrant> {
    const client = this.client();
    let result: AuthenticationResult | null;
    try {
      result = await client.acquireTokenByCode({
        code,
        scopes: [...MICROSOFT_MAIL_SCOPES],
        redirectUri: this.requiredConfiguration().callbackRedirectUri,
        codeVerifier: state.codeVerifier,
      });
    } catch (cause) {
      throw new AppError({
        code: 'OUTLOOK_OAUTH_FAILED',
        message: 'Microsoft mailbox authorization-code exchange failed',
        publicMessage: 'Outlook authorization could not be completed.',
        cause,
      });
    }
    const account = result?.account;
    const email = account?.username?.trim().toLowerCase();
    if (!result?.accessToken || !account?.homeAccountId || !email) {
      throw new AppError({
        code: 'OUTLOOK_OAUTH_FAILED',
        message: 'Microsoft did not return a complete mailbox authorization result',
        publicMessage: 'Outlook authorization could not be completed.',
      });
    }
    return {
      providerAccountId: account.homeAccountId,
      email,
      scopes: result.scopes,
      tokenExpiresAt: result.expiresOn ?? null,
      tokenCache: client.getTokenCache().serialize(),
    };
  }

  createClientWithCache(tokenCache: string): ConfidentialClientApplication {
    const client = this.client();
    client.getTokenCache().deserialize(tokenCache);
    return client;
  }

  private client(): ConfidentialClientApplication {
    const config = this.requiredConfiguration();
    return new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authority: config.authority,
      },
    });
  }

  private requiredConfiguration(): Required<MicrosoftMailboxOAuthConfig> {
    const { clientId, clientSecret, callbackRedirectUri, authority } = this.configuration;
    if (!clientId || !clientSecret || !callbackRedirectUri) {
      throw new AppError({
        code: 'CONFIGURATION_ERROR',
        message: 'Microsoft mailbox OAuth is not configured',
        publicMessage: 'Outlook connection is not available.',
      });
    }
    return { clientId, clientSecret, callbackRedirectUri, authority };
  }
}
