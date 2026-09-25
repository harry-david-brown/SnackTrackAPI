import { OAuth2Client } from 'google-auth-library';
import appleSignin from 'apple-signin-auth';
import { AuthenticationError } from '../../core/errors';

export interface VerifiedProviderIdentity {
  readonly providerUserId: string;
  readonly email?: string;
  readonly emailVerified: boolean;
}

export interface IdentityTokenVerifier {
  verify(identityToken: string): Promise<VerifiedProviderIdentity>;
}

export class GoogleIdentityTokenVerifier implements IdentityTokenVerifier {
  constructor(
    private readonly client: Pick<OAuth2Client, 'verifyIdToken'>,
    private readonly audiences: readonly string[],
  ) {}

  async verify(identityToken: string): Promise<VerifiedProviderIdentity> {
    if (this.audiences.length === 0) {
      throw new AuthenticationError('Google sign-in is not configured', 'PROVIDER_AUTH_FAILED');
    }
    const ticket = await this.client.verifyIdToken({
      idToken: identityToken,
      audience: [...this.audiences],
    });
    const payload: unknown = ticket.getPayload();
    if (typeof payload !== 'object' || payload === null) {
      throw new AuthenticationError('Google identity token is invalid', 'PROVIDER_AUTH_FAILED');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sub !== 'string' || record.sub.length === 0) {
      throw new AuthenticationError('Google identity token is invalid', 'PROVIDER_AUTH_FAILED');
    }
    return {
      providerUserId: record.sub,
      email: typeof record.email === 'string' ? record.email : undefined,
      emailVerified: record.email_verified === true && (
        (typeof record.email === 'string' && /@gmail\.com$/i.test(record.email)) ||
        (typeof record.hd === 'string' && record.hd.length > 0)
      ),
    };
  }
}

export class AppleIdentityTokenVerifier implements IdentityTokenVerifier {
  constructor(
    private readonly verifier: Pick<typeof appleSignin, 'verifyIdToken'>,
    private readonly audiences: readonly string[],
  ) {}

  async verify(identityToken: string): Promise<VerifiedProviderIdentity> {
    if (this.audiences.length === 0) {
      throw new AuthenticationError('Apple sign-in is not configured', 'PROVIDER_AUTH_FAILED');
    }
    const payload: unknown = await this.verifier.verifyIdToken(identityToken, {
      audience: [...new Set(this.audiences)],
      ignoreExpiration: false,
    });
    if (typeof payload !== 'object' || payload === null) {
      throw new AuthenticationError('Apple identity token is invalid', 'PROVIDER_AUTH_FAILED');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sub !== 'string' || record.sub.length === 0) {
      throw new AuthenticationError('Apple identity token is invalid', 'PROVIDER_AUTH_FAILED');
    }
    return {
      providerUserId: record.sub,
      email: typeof record.email === 'string' ? record.email : undefined,
      emailVerified: record.email_verified === true || record.email_verified === 'true',
    };
  }
}
