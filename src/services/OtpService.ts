/**
 * OTP Service
 * 
 * Handles OTP generation, storage, and verification
 * Uses bcrypt to hash OTPs before storing them in the database
 */

import bcrypt from 'bcryptjs';
import { PostgresService } from './data/PostgresService';
import { authConfig } from '../config/auth';
import { AuthenticationError } from '../middleware/errorHandler';

export type CodeType = 'password_reset' | 'email_verification';

interface VerificationCode {
  id: string;
  email: string;
  codeHash: string;
  codeType: CodeType;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  usedAt: Date | null;
}

export class OtpService {
  private readonly CODE_EXPIRY_MINUTES = 15;
  private readonly MAX_ATTEMPTS = 5;

  constructor(private postgres: PostgresService) {}

  /**
   * Generate a 6-digit numeric OTP
   */
  generateOTP(): string {
    const min = 100000;
    const max = 999999;
    return Math.floor(Math.random() * (max - min + 1) + min).toString().padStart(6, '0');
  }

  /**
   * Store an OTP code for an email
   * Invalidates any existing codes of the same type for that email
   * Returns the plain text code to be sent via email
   */
  async storeOTP(email: string, codeType: CodeType): Promise<string> {
    const code = this.generateOTP();
    const codeHash = await bcrypt.hash(code, authConfig.getSaltRounds());
    
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.CODE_EXPIRY_MINUTES);
    
    // Invalidate any existing codes for this email/type
    await this.postgres.query(
      'DELETE FROM verification_codes WHERE email = $1 AND code_type = $2',
      [email.toLowerCase().trim(), codeType]
    );
    
    // Store new code
    await this.postgres.query(
      `INSERT INTO verification_codes (email, code_hash, code_type, expires_at, max_attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [email.toLowerCase().trim(), codeHash, codeType, expiresAt, this.MAX_ATTEMPTS]
    );
    
    return code; // Return plain code to send via email
  }

  /**
   * Verify an OTP code
   * Returns true if valid, false otherwise
   * Increments attempt counter on failure
   * Optionally marks code as used on success (set markAsUsed=true)
   */
  async verifyOTP(email: string, code: string, codeType: CodeType, markAsUsed: boolean = true): Promise<boolean> {
    // Find valid, unused code
    const result = await this.postgres.query(
      `SELECT * FROM verification_codes 
       WHERE email = $1 
         AND code_type = $2 
         AND expires_at > NOW() 
         AND used_at IS NULL
       ORDER BY created_at DESC 
       LIMIT 1`,
      [email.toLowerCase().trim(), codeType]
    );
    
    if (result.rows.length === 0) {
      return false; // No valid code found
    }
    
    const record = result.rows[0];
    
    // Check attempt limit
    if (record.attempts >= record.max_attempts) {
      // Mark as used to prevent further attempts
      await this.postgres.query(
        'UPDATE verification_codes SET used_at = NOW() WHERE id = $1',
        [record.id]
      );
      return false;
    }
    
    // Verify code hash
    const isValid = await bcrypt.compare(code, record.code_hash);
    
    if (isValid) {
      // Mark as used only if requested
      if (markAsUsed) {
        await this.postgres.query(
          'UPDATE verification_codes SET used_at = NOW() WHERE id = $1',
          [record.id]
        );
      }
      return true;
    } else {
      // Increment attempt counter
      await this.postgres.query(
        'UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1',
        [record.id]
      );
      return false;
    }
  }

  /**
   * Check if there's a valid (unexpired, unused) code for an email
   */
  async hasValidCode(email: string, codeType: CodeType): Promise<boolean> {
    const result = await this.postgres.query(
      `SELECT id FROM verification_codes 
       WHERE email = $1 
         AND code_type = $2 
         AND expires_at > NOW() 
         AND used_at IS NULL
       LIMIT 1`,
      [email.toLowerCase().trim(), codeType]
    );
    
    return result.rows.length > 0;
  }

  /**
   * Clean up expired codes (should be run periodically via cron)
   */
  async cleanupExpiredCodes(): Promise<number> {
    const result = await this.postgres.query(
      `DELETE FROM verification_codes 
       WHERE expires_at < NOW() - INTERVAL '1 day'`
    );
    
    return result.rowCount || 0;
  }
}

