import { Auth, google } from 'googleapis';
import jwt from 'jsonwebtoken';
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

/** Google/JWT adapter for Gmail connection authorization. */
export class GmailOAuthProvider implements GmailOAuthPort {
  constructor(private readonly configuration: GmailOAuthProviderConfig) {}

  createAuthorizationUrl(state: GmailOAuthState): string {
    return this.client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: [...GOOGLE_AUTH_SCOPES],
      state: jwt.sign(state, this.configuration.stateSecret, {
        expiresIn: '10m',
        issuer: 'snacktrack-gmail-oauth',
      }),
    });
  }

  verifyState(state: string): GmailOAuthState {
    let decoded: unknown;
    try {
      decoded = jwt.verify(state, this.configuration.stateSecret, {
        issuer: 'snacktrack-gmail-oauth',
      });
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
      !isPurpose(record.purpose)
    ) {
      throw new ValidationError('OAuth state payload is invalid', 'state');
    }
    return {
      userId: record.userId,
      redirectUri: record.redirectUri,
      purpose: record.purpose,
    };
  }

  async exchangeAuthorizationCode(code: string): Promise<GmailOAuthGrant> {
    const client = this.client();
    const tokens = decodeGoogleOAuthTokens(await client.getToken(code));
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
