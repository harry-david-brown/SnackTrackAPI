import { AppError, AuthenticationError } from '../../core/errors';
import { AuthProvider } from '../../models/OAuthAccount';
import { AuthResponse } from '../../models/Token';
import type { AuthenticationActivityPort, AuthTokenPort, ProviderAccountPort } from '../ports/AuthPorts';
import { StructuredLogger } from '../core/StructuredLogger';
import { mapAuthResponse } from './AuthResponseMapper';
import { IdentityTokenVerifier } from './IdentityProvider';

export interface AppleFirstSignInData {
  readonly email?: string;
  readonly name?: { readonly firstName?: string; readonly lastName?: string };
}

/** Links verified external identities to SnackTrack accounts. */
export class ProviderAuthService {
  constructor(
    private readonly accounts: ProviderAccountPort,
    private readonly tokens: Pick<AuthTokenPort, 'generateTokens'>,
    private readonly google: IdentityTokenVerifier,
    private readonly apple: IdentityTokenVerifier,
    private readonly logger: StructuredLogger,
    private readonly activity?: AuthenticationActivityPort,
  ) {}

  loginWithGoogle(identityToken: string): Promise<AuthResponse> {
    return this.login('google', identityToken);
  }

  loginWithApple(identityToken: string, _firstSignIn?: AppleFirstSignInData): Promise<AuthResponse> {
    return this.login('apple', identityToken);
  }

  private async login(
    provider: AuthProvider,
    identityToken: string,
  ): Promise<AuthResponse> {
    try {
      const identity = await (provider === 'google' ? this.google : this.apple).verify(
        identityToken,
      );
      const user = await this.accounts.resolve({ provider, ...identity });
      await this.activity?.recordSuccess(user.id, provider, 'signed_in');
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
}
