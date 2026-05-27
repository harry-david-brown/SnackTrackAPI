import bcrypt from 'bcryptjs';
import { authConfig } from '../config/auth';

export interface User {
  id: string;
  email: string;
  password?: string; // Optional - not returned in API responses
  emailVerified?: boolean; // Email verification status
  timezone?: string; // IANA timezone (e.g., 'America/New_York', 'Europe/London')
  gmailRefreshToken?: string; // Gmail OAuth refresh token
  gmailAccessToken?: string; // Gmail OAuth access token
  gmailTokenExpiry?: string; // When the access token expires
  gmailConnected?: boolean; // Whether Gmail is connected
  gmailEmail?: string; // The email address of the connected Gmail account
  gmailScopes?: string[]; // OAuth scopes granted for Gmail integration
  gmailConnectionMode?: 'temporary' | 'offline' | 'none'; // Whether Gmail can be refreshed or is access-token only
  createdAt?: string;
}

/**
 * User model with authentication methods
 */
export class UserModel {
  /**
   * Hash a password using bcrypt
   */
  static async hashPassword(password: string): Promise<string> {
    const saltRounds = authConfig.getSaltRounds();
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Compare a plain text password with a hashed password
   */
  static async comparePassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
    return bcrypt.compare(plainPassword, hashedPassword);
  }

  /**
   * Remove sensitive fields from user object before sending to client
   */
  static sanitize(user: User): Omit<User, 'password'> {
    const { password, ...sanitizedUser } = user;
    return sanitizedUser;
  }

  /**
   * Validate password meets requirements
   */
  static validatePassword(password: string): { valid: boolean; errors: string[] } {
    return authConfig.validatePassword(password);
  }
}
