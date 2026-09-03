import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticationError } from '../../core/errors';
import { AuthTokens, TokenPayload } from '../../models/Token';
import { User } from '../../models/User';

export interface RefreshTokenBlacklist {
  isAvailable(): boolean;
  exists(key: string): Promise<boolean>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

export interface TokenServiceLogger {
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export interface TokenServiceOptions {
  readonly accessSecret: string;
  readonly refreshSecret: string;
  readonly accessTokenExpiry: string;
  readonly refreshTokenExpiry: string;
}

const tokenPayload = (value: unknown, expectedType: TokenPayload['type']): TokenPayload => {
  if (typeof value !== 'object' || value === null) {
    throw new AuthenticationError(
      `Invalid ${expectedType} token`,
      expectedType === 'access' ? 'ACCESS_TOKEN_INVALID' : 'REFRESH_TOKEN_INVALID',
    );
  }
  const record = value as Record<string, unknown>;
  const valid =
    typeof record.userId === 'string' &&
    typeof record.email === 'string' &&
    record.type === expectedType &&
    (record.iat === undefined || typeof record.iat === 'number') &&
    (record.exp === undefined || typeof record.exp === 'number') &&
    (record.jti === undefined || typeof record.jti === 'string');
  if (!valid) {
    throw new AuthenticationError(
      `Invalid ${expectedType} token`,
      expectedType === 'access' ? 'ACCESS_TOKEN_INVALID' : 'REFRESH_TOKEN_INVALID',
    );
  }
  return record as unknown as TokenPayload;
};

/** Owns JWT creation, verification, and refresh-token revocation only. */
export class TokenService {
  constructor(
    private readonly options: TokenServiceOptions,
    private readonly blacklist: RefreshTokenBlacklist,
    private readonly logger: TokenServiceLogger,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = uuidv4,
  ) {}

  generateTokens(user: User): AuthTokens {
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, type: 'access' } satisfies TokenPayload,
      this.options.accessSecret,
      { expiresIn: this.options.accessTokenExpiry as SignOptions['expiresIn'] },
    );
    const refreshToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        type: 'refresh',
        jti: this.createId(),
      } satisfies TokenPayload,
      this.options.refreshSecret,
      { expiresIn: this.options.refreshTokenExpiry as SignOptions['expiresIn'] },
    );
    return { accessToken, refreshToken };
  }

  verifyAccessToken(token: string): TokenPayload {
    return this.verify(token, 'access');
  }

  verifyRefreshToken(token: string): TokenPayload {
    return this.verify(token, 'refresh');
  }

  async verifyRefreshTokenWithBlacklist(token: string): Promise<TokenPayload> {
    const payload = this.verifyRefreshToken(token);
    if (!payload.jti || !payload.exp) {
      throw new AuthenticationError('Invalid refresh token', 'REFRESH_TOKEN_INVALID');
    }
    if (await this.blacklist.exists(`blacklist:refresh:${payload.jti}`)) {
      throw new AuthenticationError('Refresh token has been revoked', 'REFRESH_TOKEN_REVOKED');
    }
    return payload;
  }

  async consumeRefreshToken(token: string): Promise<TokenPayload> {
    const payload = this.verifyRefreshToken(token);
    if (!payload.jti || !payload.exp) {
      throw new AuthenticationError('Invalid refresh token', 'REFRESH_TOKEN_INVALID');
    }
    const ttlSeconds = payload.exp - Math.floor(this.now() / 1000);
    if (ttlSeconds <= 0) throw new AuthenticationError('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
    const consumed = await this.blacklist.setIfAbsent(
      `blacklist:refresh:${payload.jti}`,
      'consumed',
      ttlSeconds,
    );
    if (!consumed) throw new AuthenticationError('Refresh token has been revoked', 'REFRESH_TOKEN_REVOKED');
    return payload;
  }

  async revokeRefreshToken(token: string): Promise<void> {
    let payload: TokenPayload;
    try {
      payload = this.verifyRefreshToken(token);
    } catch (error) {
      this.logger.warn('Refresh token revocation skipped', {
        operation: 'revoke_refresh_token',
        outcome: 'invalid_or_expired',
        errorCode: error instanceof AuthenticationError ? error.code : 'INTERNAL_ERROR',
      });
      return;
    }
    if (!payload.jti || !payload.exp) return;
    const ttlSeconds = payload.exp - Math.floor(this.now() / 1000);
    if (ttlSeconds <= 0) return;
    await this.blacklist.set(`blacklist:refresh:${payload.jti}`, 'revoked', ttlSeconds);
    this.logger.info('Refresh token revoked', {
      userId: payload.userId,
      operation: 'revoke_refresh_token',
      outcome: 'success',
    });
  }

  private verify(token: string, type: TokenPayload['type']): TokenPayload {
    try {
      return tokenPayload(
        jwt.verify(
          token,
          type === 'access' ? this.options.accessSecret : this.options.refreshSecret,
        ),
        type,
      );
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError(
          `${type === 'access' ? 'Access' : 'Refresh'} token has expired`,
          type === 'access' ? 'ACCESS_TOKEN_EXPIRED' : 'REFRESH_TOKEN_EXPIRED',
        );
      }
      throw new AuthenticationError(
        `Invalid ${type} token`,
        type === 'access' ? 'ACCESS_TOKEN_INVALID' : 'REFRESH_TOKEN_INVALID',
      );
    }
  }
}
