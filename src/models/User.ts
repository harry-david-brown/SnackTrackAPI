import bcrypt from 'bcryptjs';
import { authConfig } from '../config/auth';

export interface User {
  id: string;
  email: string;
  password?: string; // Optional - not returned in API responses
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