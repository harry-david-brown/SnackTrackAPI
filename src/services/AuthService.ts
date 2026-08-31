/**
 * Authentication Service
 * 
 * Handles JWT token generation, validation, and authentication logic
 */

import jwt, { SignOptions } from 'jsonwebtoken';
import { User, UserModel } from '../models/User';
import { UserRepository } from './data/UserRepository';
import { TokenPayload, AuthTokens, AuthResponse } from '../models/Token';
import { authConfig } from '../config/auth';
import { AuthenticationError, ValidationError } from '../core/errors';
import { v4 as uuidv4 } from 'uuid';

import { OAuth2Client } from 'google-auth-library';
import { OAuthRepository } from './data/OAuthRepository';
import appleSignin from 'apple-signin-auth';
import { redisConfig } from '../config/redis';
import logger from '../config/logger';

// ... imports

interface AppleUserData {
  email?: string;
  name?: {
    firstName?: string;
    lastName?: string;
  };
}

const isTokenPayload = (value: unknown): value is TokenPayload => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.userId === 'string'
    && typeof record.email === 'string'
    && (record.type === 'access' || record.type === 'refresh')
    && (record.iat === undefined || typeof record.iat === 'number')
    && (record.exp === undefined || typeof record.exp === 'number')
    && (record.jti === undefined || typeof record.jti === 'string');
};

export const parseTokenPayload = (value: unknown, expectedType: TokenPayload['type']): TokenPayload => {
  if (!isTokenPayload(value)) throw new AuthenticationError('Malformed token payload');
  if (value.type !== expectedType) throw new AuthenticationError('Invalid token type');
  return value;
};

export class AuthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly oauthRepository: OAuthRepository,
    private readonly googleClient: Pick<OAuth2Client, 'verifyIdToken'>,
    private readonly googleAudiences: string[],
    private readonly appleTokenVerifier: Pick<typeof appleSignin, 'verifyIdToken'>,
    private readonly appleClientIds: readonly string[],
  ) {
    if (this.googleAudiences.length === 0) {
      throw new Error(
        'Google auth is not configured. Set at least one of GMAIL_CLIENT_ID, GMAIL_IOS_CLIENT_ID, or GMAIL_WEB_CLIENT_ID.'
      );
    }
  }

  /**
   * Login with Google ID Token
   */
  async loginWithGoogle(idToken: string): Promise<AuthResponse> {
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.googleAudiences,
      });
      const payload = ticket.getPayload();

      if (!payload) {
        throw new AuthenticationError('Invalid Google token');
      }

      const { sub: googleId, email, email_verified } = payload;

      if (!email) {
        throw new AuthenticationError('Google account has no email');
      }

      // 1. Check if OAuth account exists
      let oauthAccount = await this.oauthRepository.findByProvider('google', googleId);
      let user: User | undefined;

      if (oauthAccount) {
        user = await this.userRepository.findById(oauthAccount.userId);
        // Update access token if available in prompt (not usually in id_token alone)
      } else {
        // 2. Check if user exists by email
        user = await this.userRepository.findByEmail(email);

        if (!user) {
          // 3. Create new user
          const userId = await this.userRepository.createUser(email, 'America/New_York'); // Default timezone
          user = await this.userRepository.findById(userId);
        }

        if (!user) throw new Error("Failed to create or find user");

        // 4. Create OAuth Link
        await this.oauthRepository.create({
          userId: user.id,
          provider: 'google',
          providerUserId: googleId,
          email: email,
          accessToken: undefined, // Standard sign-in doesn't give these
          refreshToken: undefined,
          tokenExpiry: undefined
        });

        // Mark email as verified if Google says so
        if (email_verified && !user.emailVerified) {
          await this.userRepository.updateEmailVerified(email, true);
        }
      }

      if (!user) {
        throw new AuthenticationError('User not found after successful Google auth');
      }

      const tokens = await this.generateTokens(user);

      return {
        userId: user.id,
        email: user.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified || false, // Use existing status
          createdAt: user.createdAt || new Date().toISOString()
        }
      };

    } catch (error) {
      logger.warn('Google login failed', { error });
      throw new AuthenticationError('Google authentication failed');
    }
  }

  /**
   * Login with Apple ID Token
   */
  async loginWithApple(identityToken: string, userData?: AppleUserData): Promise<AuthResponse> {
    try {
      // Verify the identity token with Apple
      // Support multiple client IDs: production (com.snacktrack.mobile) and Expo Go (host.exp.Exponent)
      const appleClientIds = this.appleClientIds.length > 0
        ? [...new Set(this.appleClientIds)]
        : ['com.snacktrack.mobile', 'host.exp.Exponent'];

      if (appleClientIds.length === 0) {
        throw new AuthenticationError('Apple Sign In not configured');
      }

      // Verify token and get claims
      // Accept both production and Expo Go audiences
      const appleData = await this.appleTokenVerifier.verifyIdToken(identityToken, {
        audience: appleClientIds,
        ignoreExpiration: false,
      });

      if (!appleData) {
        throw new AuthenticationError('Invalid Apple token');
      }

      const appleUserId = appleData.sub; // Apple's unique user identifier

      // Apple only provides email on first sign-in or if available in token
      let email = appleData.email || userData?.email;

      // 1. Check if OAuth account exists
      let oauthAccount = await this.oauthRepository.findByProvider('apple', appleUserId);
      let user: User | undefined;

      if (oauthAccount) {
        // Existing user - retrieve their account
        user = await this.userRepository.findById(oauthAccount.userId);

        // Use cached email from oauth_account if not provided in current token
        if (!email && oauthAccount.email) {
          email = oauthAccount.email;
        }
      } else {
        // New Apple Sign In - need email
        if (!email) {
          throw new AuthenticationError('Email not provided by Apple. Please try again or use a different sign-in method.');
        }

        // 2. Check if user exists by email
        user = await this.userRepository.findByEmail(email);

        if (!user) {
          // 3. Create new user
          const userId = await this.userRepository.createUser(email, 'America/New_York'); // Default timezone
          user = await this.userRepository.findById(userId);
        }

        if (!user) throw new Error("Failed to create or find user");

        // 4. Create OAuth Link - cache email for future sign-ins
        await this.oauthRepository.create({
          userId: user.id,
          provider: 'apple',
          providerUserId: appleUserId,
          email: email, // Important: cache email as Apple won't provide it next time
          accessToken: undefined,
          refreshToken: undefined,
          tokenExpiry: undefined
        });

        // Apple verifies emails, so mark as verified
        if (!user.emailVerified) {
          await this.userRepository.updateEmailVerified(email, true);
        }
      }

      if (!user) {
        throw new AuthenticationError('User not found after successful Apple auth');
      }

      const tokens = await this.generateTokens(user);

      return {
        userId: user.id,
        email: user.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified || false,
          createdAt: user.createdAt || new Date().toISOString()
        }
      };

    } catch (error: any) {
      logger.warn('Apple login failed', { error });
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError('Apple authentication failed');
    }
  }

  // ... (rest of existing methods, make sure generateTokens etc are preserved)


  /**
   * Generate access and refresh tokens for a user
   */
  async generateTokens(user: User): Promise<AuthTokens> {
    const accessPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
      type: 'access'
    };

    const accessToken = jwt.sign(
      accessPayload,
      authConfig.getJWTSecret(),
      { expiresIn: '15m' } // 15 minutes for access token
    );

    const refreshJti = uuidv4();
    const refreshPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
      type: 'refresh',
      jti: refreshJti
    };

    const refreshToken = jwt.sign(
      refreshPayload,
      authConfig.getRefreshSecret(),
      { expiresIn: '7d' }
    );

    return { accessToken, refreshToken };
  }

  /**
   * Verify and decode an access token
   */
  verifyAccessToken(token: string): TokenPayload {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, authConfig.getJWTSecret());
    } catch (error: unknown) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError('Access token has expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthenticationError('Invalid access token');
      }
      throw new AuthenticationError('Token verification failed');
    }
    return parseTokenPayload(decoded, 'access');
  }

  /**
   * Verify and decode a refresh token
   */
  verifyRefreshToken(token: string): TokenPayload {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, authConfig.getRefreshSecret());
    } catch (error: unknown) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError('Refresh token has expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthenticationError('Invalid refresh token');
      }
      throw new AuthenticationError('Token verification failed');
    }
    return parseTokenPayload(decoded, 'refresh');
  }

  /**
   * Verified refresh token and check blacklist
   */
  async verifyRefreshTokenWithBlacklist(token: string): Promise<TokenPayload> {
    const decoded = this.verifyRefreshToken(token);

    // Check blacklist if Redis is enabled
    if (decoded.jti && redisConfig.isAvailable()) {
      const isBlacklisted = await redisConfig.exists(`blacklist:refresh:${decoded.jti}`);
      if (isBlacklisted) {
        throw new AuthenticationError('Refresh token has been revoked');
      }
    }

    return decoded;
  }

  /**
   * Revoke a refresh token by adding its JTI to the blacklist
   */
  async revokeRefreshToken(token: string): Promise<void> {
    try {
      // Decode without verifying signature first to get payload (we want to revoke even if expired/invalid signature technically)
      // BUT for security, we should probably verify it's signed by us before blacklisting random strings.
      // However, if we can't verify it, we can't trust the JTI either.
      // So let's use verifyRefreshToken.
      const decoded = this.verifyRefreshToken(token);

      if (decoded.jti && decoded.exp && redisConfig.isAvailable()) {
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await redisConfig.set(`blacklist:refresh:${decoded.jti}`, 'revoked', ttl);
          logger.info('Refresh token revoked', { userId: decoded.userId });
        }
      }
    } catch (error) {
      // Ignore errors during revocation (e.g. token already expired)
      logger.warn('Refresh token revocation skipped', { error });
    }
  }

  /**
   * Register a new user with email and password
   */
  async register(email: string, password: string, timezone?: string): Promise<AuthResponse> {
    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Validate password strength
    const passwordValidation = UserModel.validatePassword(password);
    if (!passwordValidation.valid) {
      throw new ValidationError(passwordValidation.errors.join('; '), 'password');
    }

    // Check if user already exists
    const existingUser = await this.userRepository.findByEmail(normalizedEmail);
    if (existingUser) {
      throw new ValidationError('User with this email already exists', 'email');
    }

    // Hash password
    const hashedPassword = await UserModel.hashPassword(password);

    // Create user with timezone
    const userId = await this.userRepository.createUserWithPassword(
      normalizedEmail,
      hashedPassword,
      timezone
    );

    // Fetch created user
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new Error('Failed to create user');
    }

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      userId: user.id,
      email: user.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        emailVerified: false, // Always false for new registrations
        createdAt: user.createdAt || new Date().toISOString()
      }
    };
  }

  /**
   * Login a user with email and password
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Find user
    const user = await this.userRepository.findByEmailWithPassword(normalizedEmail);
    if (!user || !user.password) {
      throw new AuthenticationError('Invalid email or password');
    }

    // Verify password
    const isPasswordValid = await UserModel.comparePassword(password, user.password);
    if (!isPasswordValid) {
      throw new AuthenticationError('Invalid email or password');
    }

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      userId: user.id,
      email: user.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified || false,
        createdAt: user.createdAt || new Date().toISOString()
      }
    };
  }

  /**
   * Reset password using email and code
   */
  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    // Validate password strength
    const passwordValidation = UserModel.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new ValidationError(passwordValidation.errors.join('; '), 'password');
    }

    // Hash new password
    const hashedPassword = await UserModel.hashPassword(newPassword);

    // Update password
    await this.userRepository.updatePassword(email.toLowerCase().trim(), hashedPassword);
  }

  /**
   * Refresh access token using a valid refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
    // Verify refresh token and check blacklist
    const decoded = await this.verifyRefreshTokenWithBlacklist(refreshToken);

    // Find user
    const user = await this.userRepository.findById(decoded.userId);
    if (!user) {
      throw new AuthenticationError('User not found');
    }

    // Generate new tokens
    return this.generateTokens(user);
  }

  /**
   * Validate that a user exists and return user data
   */
  async validateUser(userId: string): Promise<User | undefined> {
    return this.userRepository.findById(userId);
  }

}
