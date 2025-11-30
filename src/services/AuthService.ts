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

export class AuthService {
  constructor(private userRepository: UserRepository) {}

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

