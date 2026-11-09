import { AppError, AuthenticationError } from '../../core/errors';
import { AuthTokens, TokenPayload } from '../../models/Token';
import type { AuthTokenPort, AuthUserPort } from '../ports/AuthPorts';

/** Orchestrates refresh-token validation and session rotation. */
export class SessionService {
  constructor(
    private readonly users: Pick<AuthUserPort, 'findById'>,
    private readonly tokens: AuthTokenPort,
  ) {}

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.tokens.verifyRefreshTokenWithBlacklist(refreshToken);
    const user = await this.loadUser(payload.userId);
    if (!user || (payload.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) {
      throw new AuthenticationError(
        'This session is no longer valid. Please sign in again.',
        'REFRESH_TOKEN_INVALID',
      );
    }
    if (user.deletionRequested) throw new AuthenticationError(
      'Your account is being deleted. Deletion will continue even if you close the app.', 'ACCOUNT_DELETION_PENDING');
    await this.tokens.consumeRefreshToken(refreshToken);
    return this.tokens.generateTokens(user);
  }

  async verifyAccessSession(payload: TokenPayload, allowPendingDeletion = false): Promise<void> {
    const user = await this.loadUser(payload.userId);
    if (!user || (payload.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) {
      throw new AuthenticationError('This session is no longer valid. Please sign in again.', 'ACCESS_TOKEN_INVALID');
    }
    if (user.deletionRequested && !allowPendingDeletion) throw new AuthenticationError(
      'Your account is being deleted. Deletion will continue even if you close the app.', 'ACCOUNT_DELETION_PENDING');
  }

  private async loadUser(userId: string) {
    try {
      return await this.users.findById(userId);
    } catch (cause) {
      throw new AppError({ code: 'SESSION_STORE_UNAVAILABLE',
        message: 'Session validation is temporarily unavailable', cause });
    }
  }

  revoke(refreshToken: string): Promise<void> {
    return this.tokens.revokeRefreshToken(refreshToken);
  }
}
