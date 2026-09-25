import { Auth, google } from 'googleapis';
import { createHash, randomBytes } from 'crypto';
import { CodeChallengeMethod } from 'google-auth-library';
import { MailboxSecretCipher } from '../mailbox/MailboxSecretCipher';
import { AppError, ValidationError } from '../../core/errors';
import {
  GMAIL_CONNECTION_PURPOSES,
  GmailConnectionPurpose,
  GmailOAuthGrant,
  GmailOAuthPort,
  GmailOAuthState,
} from '../import/GmailConnectionContracts';
import { decodeGoogleOAuthTokens, decodeGoogleUserInfoEmail } from './GmailProviderDecoder';

export interface GmailOAuthProviderConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackRedirectUri?: string;
  readonly stateSecret: string;
}

const GOOGLE_AUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

const isPurpose = (value: unknown): value is GmailConnectionPurpose =>
  typeof value === 'string' && GMAIL_CONNECTION_PURPOSES.includes(value as GmailConnectionPurpose);

/** Google OAuth adapter with PKCE and encrypted, expiring state. */
export class GmailOAuthProvider implements GmailOAuthPort {
  private readonly cipher: MailboxSecretCipher;
  constructor(private readonly configuration: GmailOAuthProviderConfig) {
    this.cipher = new MailboxSecretCipher(configuration.stateSecret);
  }

  createAuthorizationUrl(state: GmailOAuthState): string {
    const codeVerifier = randomBytes(32).toString('base64url');
    return this.client().generateAuthUrl({
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: CodeChallengeMethod.S256,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: [...GOOGLE_AUTH_SCOPES],
      state: this.cipher.encrypt(JSON.stringify({ ...state, codeVerifier, expiresAt: Date.now() + 600_000 })),
    });
  }

  verifyState(state: string): GmailOAuthState {
    let decoded: unknown;
    try {
      decoded = JSON.parse(this.cipher.decrypt(state)) as unknown;
    } catch (cause) {
      throw new ValidationError('OAuth state is invalid or expired', 'state', cause);
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new ValidationError('OAuth state payload is invalid', 'state');
    }
    const record = decoded as Record<string, unknown>;
    if (
      typeof record.userId !== 'string' ||
      typeof record.redirectUri !== 'string' ||
      typeof record.codeVerifier !== 'string' ||
      typeof record.expiresAt !== 'number' || record.expiresAt <= Date.now() ||
      !isPurpose(record.purpose)
    ) {
      throw new ValidationError('OAuth state payload is invalid', 'state');
    }
    return {
      codeVerifier: record.codeVerifier,
      userId: record.userId,
      redirectUri: record.redirectUri,
      purpose: record.purpose,
    };
  }

  async exchangeAuthorizationCode(code: string, state: GmailOAuthState): Promise<GmailOAuthGrant> {
    const client = this.client();
    if (!state.codeVerifier) throw new ValidationError('Missing OAuth verifier', 'state');
    const tokens = decodeGoogleOAuthTokens(await client.getToken({ code, codeVerifier: state.codeVerifier }));
    client.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiryDate.getTime(),
      scope: tokens.scopes.join(' '),
    });
    const email = decodeGoogleUserInfoEmail(
      await google.oauth2({ version: 'v2', auth: client }).userinfo.get(),
    );
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiryDate: tokens.expiryDate,
      email,
      scopes: tokens.scopes,
    };
  }

  private client(): Auth.OAuth2Client {
    const { clientId, clientSecret, callbackRedirectUri } = this.configuration;
    if (!clientId || !clientSecret || !callbackRedirectUri) {
      throw new AppError({
        code: 'CONFIGURATION_ERROR',
        message: 'Gmail OAuth credentials or callback redirect URI are not configured',
        publicMessage: 'Gmail connection is temporarily unavailable.',
      });
    }
    return new google.auth.OAuth2(clientId, clientSecret, callbackRedirectUri);
  }
}
