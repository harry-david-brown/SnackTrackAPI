import { AuthenticationError } from '../../core/errors';
import { AuthTokens } from '../../models/Token';
import type { AuthTokenPort, AuthUserPort } from '../ports/AuthPorts';

/** Orchestrates refresh-token validation and session rotation. */
export class SessionService {
  constructor(
    private readonly users: Pick<AuthUserPort, 'findById'>,
    private readonly tokens: AuthTokenPort,
  ) {}

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.tokens.consumeRefreshToken(refreshToken);
    const user = await this.users.findById(payload.userId);
    if (!user) {
      throw new AuthenticationError(
        'The account for this session no longer exists',
        'REFRESH_TOKEN_INVALID',
      );
    }
    return this.tokens.generateTokens(user);
  }

  revoke(refreshToken: string): Promise<void> {
    return this.tokens.revokeRefreshToken(refreshToken);
  }
}
