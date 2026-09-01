import { AppError, AuthenticationError } from '../../core/errors';
import { AuthProvider } from '../../models/OAuthAccount';
import { AuthResponse } from '../../models/Token';
import { User } from '../../models/User';
import type { AuthTokenPort, AuthUserPort, OAuthIdentityPort } from '../ports/AuthPorts';
import { StructuredLogger } from '../core/StructuredLogger';
import { mapAuthResponse } from './AuthResponseMapper';
import { IdentityTokenVerifier, VerifiedProviderIdentity } from './IdentityProvider';

export interface AppleFirstSignInData {
  readonly email?: string;
  readonly name?: { readonly firstName?: string; readonly lastName?: string };
}

/** Links verified external identities to SnackTrack accounts. */
export class ProviderAuthService {
  constructor(
    private readonly users: AuthUserPort,
    private readonly oauthAccounts: OAuthIdentityPort,
    private readonly tokens: Pick<AuthTokenPort, 'generateTokens'>,
    private readonly google: IdentityTokenVerifier,
    private readonly apple: IdentityTokenVerifier,
    private readonly logger: StructuredLogger,
  ) {}

  loginWithGoogle(identityToken: string): Promise<AuthResponse> {
    return this.login('google', identityToken);
  }

  loginWithApple(identityToken: string, firstSignIn?: AppleFirstSignInData): Promise<AuthResponse> {
    return this.login('apple', identityToken, firstSignIn?.email);
  }

  private async login(
    provider: AuthProvider,
    identityToken: string,
    fallbackEmail?: string,
  ): Promise<AuthResponse> {
    try {
      const identity = await (provider === 'google' ? this.google : this.apple).verify(
        identityToken,
      );
      const user = await this.resolveUser(provider, identity, fallbackEmail);
      return mapAuthResponse(user, this.tokens.generateTokens(user));
    } catch (error) {
      const authenticationError =
        error instanceof AppError
          ? error
          : new AuthenticationError(
              `${provider === 'google' ? 'Google' : 'Apple'} authentication failed`,
              'PROVIDER_AUTH_FAILED',
            );
      this.logger.warn('Identity-provider authentication failed', {
        operation: 'provider_authentication',
        provider,
        outcome: 'failure',
        errorCode: authenticationError.code,
      });
      throw authenticationError;
    }
  }

  private async resolveUser(
    provider: AuthProvider,
    identity: VerifiedProviderIdentity,
    fallbackEmail?: string,
  ): Promise<User> {
    const linked = await this.oauthAccounts.findByProvider(provider, identity.providerUserId);
    if (linked) {
      const linkedUser = await this.users.findById(linked.userId);
      if (!linkedUser) {
        throw new AuthenticationError('Linked account no longer exists', 'PROVIDER_AUTH_FAILED');
      }
      return linkedUser;
    }

    const email = (identity.email ?? fallbackEmail)?.toLowerCase().trim();
    if (!email) {
      throw new AuthenticationError(
        'The identity provider did not supply an email address',
        'PROVIDER_AUTH_FAILED',
      );
    }
    let user = await this.users.findByEmail(email);
    if (!user) {
      const userId = await this.users.createUser(email, 'America/New_York');
      user = await this.users.findById(userId);
    }
    if (!user) throw new Error('Provider-authenticated account could not be loaded');

    await this.oauthAccounts.create({
      userId: user.id,
      provider,
      providerUserId: identity.providerUserId,
      email,
    });
    if (identity.emailVerified && !user.emailVerified) {
      await this.users.updateEmailVerified(email, true);
      user = { ...user, emailVerified: true };
    }
    return user;
  }
}
