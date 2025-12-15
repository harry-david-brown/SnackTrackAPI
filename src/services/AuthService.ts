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
import { AuthenticationError, ValidationError } from '../middleware/errorHandler';
import { v4 as uuidv4 } from 'uuid';

import { OAuth2Client } from 'google-auth-library';
import { OAuthRepository } from './data/OAuthRepository';
import appleSignin from 'apple-signin-auth';

// ... imports

interface AppleUserData {
  email?: string;
  name?: {
    firstName?: string;
    lastName?: string;
  };
}

export class AuthService {
  private googleClient: OAuth2Client;

  constructor(
    private userRepository: UserRepository,
    private oauthRepository: OAuthRepository
  ) {
    // We can use any client ID here as we'll verify the listener
    // Ideally these should be in config
    this.googleClient = new OAuth2Client(
      process.env.GMAIL_CLIENT_ID
    );
  }

  /**
   * Login with Google ID Token
   */
  async loginWithGoogle(idToken: string): Promise<AuthResponse> {
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: [ // Accept both web and mobile client IDs
          process.env.GMAIL_CLIENT_ID || '',
          process.env.GMAIL_IOS_CLIENT_ID || '',
          process.env.GMAIL_WEB_CLIENT_ID || ''
        ].filter(Boolean),
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
      console.error("Google Login Error:", error);
      throw new AuthenticationError('Google authentication failed');
    }
  }

  /**
   * Login with Apple ID Token
   */
  async loginWithApple(identityToken: string, userData?: AppleUserData): Promise<AuthResponse> {
    try {
      // Verify the identity token with Apple
      const appleClientId = process.env.APPLE_CLIENT_ID;
      if (!appleClientId) {
        throw new AuthenticationError('Apple Sign In not configured');
      }

      // Verify token and get claims
      const appleData = await appleSignin.verifyIdToken(identityToken, {
        audience: appleClientId,
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
      console.error("Apple Login Error:", error);
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

    const refreshPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
      type: 'refresh'
    };

    const accessToken = jwt.sign(
      accessPayload,
      authConfig.getJWTSecret(),
      { expiresIn: '15m' } // 15 minutes for access token
    );

    const refreshToken = jwt.sign(
      refreshPayload,
      authConfig.getRefreshSecret(),
      { expiresIn: '7d' } // 7 days for refresh token
    );

    return { accessToken, refreshToken };
  }

  /**
   * Verify and decode an access token
   */
  verifyAccessToken(token: string): TokenPayload {
    try {
      const decoded = jwt.verify(token, authConfig.getJWTSecret()) as TokenPayload;

      if (decoded.type !== 'access') {
        throw new AuthenticationError('Invalid token type');
      }

      return decoded;
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        throw new AuthenticationError('Access token has expired');
      }
      if (error.name === 'JsonWebTokenError') {
        throw new AuthenticationError('Invalid access token');
      }
      throw new AuthenticationError('Token verification failed');
    }
  }

  /**
   * Verify and decode a refresh token
   */
  verifyRefreshToken(token: string): TokenPayload {
    try {
      const decoded = jwt.verify(token, authConfig.getRefreshSecret()) as TokenPayload;

      if (decoded.type !== 'refresh') {
        throw new AuthenticationError('Invalid token type');
      }

      return decoded;
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        throw new AuthenticationError('Refresh token has expired');
      }
      if (error.name === 'JsonWebTokenError') {
        throw new AuthenticationError('Invalid refresh token');
      }
      throw new AuthenticationError('Token verification failed');
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
    // Verify refresh token
    const decoded = this.verifyRefreshToken(refreshToken);

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

