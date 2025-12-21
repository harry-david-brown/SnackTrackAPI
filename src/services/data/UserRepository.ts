import { User } from '../../models/User';
import { PostgresService } from './PostgresService';
import { v4 as uuidv4 } from 'uuid';

/**
 * Repository for user data access operations
 * Separated from DatabaseService to follow single responsibility principle
 */
export class UserRepository {
  constructor(private postgres: PostgresService) {}

  async createUser(email: string, timezone?: string): Promise<string> {
    // First check if user already exists
    const existingUser = await this.findByEmail(email);
    if (existingUser) {
      return existingUser.id;
    }

    // Use provided timezone or default
    const userTimezone = timezone || 'America/New_York';

    // Create new user if doesn't exist
    const userId = uuidv4();
    try {
      const result = await this.postgres.query(
        'INSERT INTO users (id, email, timezone) VALUES ($1, $2, $3) RETURNING id',
        [userId, email, userTimezone]
      );
      return result.rows[0].id;
    } catch (error: any) {
      // If unique constraint violation, try to find the user again
      if (error.code === '23505') { // PostgreSQL unique violation error code
        const existingUser = await this.findByEmail(email);
        if (existingUser) {
          return existingUser.id;
        }
      }
      throw error;
    }
  }

  async findById(id: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      'SELECT id, email, email_verified, timezone, created_at FROM users WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified || false,
      timezone: row.timezone || 'America/New_York', // Default timezone
      createdAt: row.created_at
    };
  }

  async findAll(): Promise<User[]> {
    const result = await this.postgres.query('SELECT id, email, email_verified, timezone, created_at FROM users');
    return result.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified || false,
      timezone: row.timezone || 'America/New_York', // Default timezone
      createdAt: row.created_at
    }));
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      'SELECT id, email, email_verified, timezone, created_at FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified || false,
      timezone: row.timezone || 'America/New_York', // Default timezone
      createdAt: row.created_at
    };
  }

  async findByEmailWithPassword(email: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      'SELECT id, email, password, email_verified, timezone, created_at FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      password: row.password,
      emailVerified: row.email_verified || false,
      timezone: row.timezone || 'America/New_York', // Default timezone
      createdAt: row.created_at
    };
  }

  async createUserWithPassword(email: string, hashedPassword: string, timezone?: string): Promise<string> {
    // First check if user already exists
    const existingUser = await this.findByEmail(email);
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    // Use provided timezone or default
    const userTimezone = timezone || 'America/New_York';

    // Create new user with password (email_verified defaults to false)
    const userId = uuidv4();
    try {
      const result = await this.postgres.query(
        'INSERT INTO users (id, email, password, email_verified, timezone, created_at) VALUES ($1, $2, $3, FALSE, $4, NOW()) RETURNING id',
        [userId, email, hashedPassword, userTimezone]
      );
      return result.rows[0].id;
    } catch (error: any) {
      // If unique constraint violation, throw error
      if (error.code === '23505') {
        throw new Error('User with this email already exists');
      }
      throw error;
    }
  }

  async updateEmailVerified(email: string, verified: boolean): Promise<void> {
    await this.postgres.query(
      'UPDATE users SET email_verified = $1, updated_at = NOW() WHERE email = $2',
      [verified, email]
    );
  }

  async updatePassword(email: string, hashedPassword: string): Promise<void> {
    await this.postgres.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE email = $2',
      [hashedPassword, email]
    );
  }

  async updateTimezone(userId: string, timezone: string): Promise<void> {
    // Validate timezone format (basic check - should be IANA timezone)
    // Common IANA timezones: America/New_York, Europe/London, Asia/Tokyo, etc.
    if (!timezone || typeof timezone !== 'string' || timezone.length > 50) {
      throw new Error('Invalid timezone format');
    }

    await this.postgres.query(
      'UPDATE users SET timezone = $1, updated_at = NOW() WHERE id = $2',
      [timezone, userId]
    );
  }

  /**
   * Update Gmail OAuth tokens for a user
   */
  async updateGmailTokens(userId: string, refreshToken: string, accessToken: string, expiryDate: Date, gmailEmail?: string): Promise<void> {
    await this.postgres.query(
      `UPDATE users SET 
        gmail_refresh_token = $1, 
        gmail_access_token = $2, 
        gmail_token_expiry = $3,
        gmail_connected = TRUE,
        gmail_email = $4,
        updated_at = NOW() 
      WHERE id = $5`,
      [refreshToken, accessToken, expiryDate, gmailEmail || null, userId]
    );
  }

  /**
   * Get user with Gmail tokens
   */
  async findByIdWithGmailTokens(userId: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      `SELECT id, email, email_verified, gmail_refresh_token, gmail_access_token, 
              gmail_token_expiry, gmail_connected, gmail_email, created_at 
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) return undefined;

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified || false,
      gmailRefreshToken: row.gmail_refresh_token,
      gmailAccessToken: row.gmail_access_token,
      gmailTokenExpiry: row.gmail_token_expiry,
      gmailConnected: row.gmail_connected || false,
      gmailEmail: row.gmail_email,
      createdAt: row.created_at
    };
  }

  /**
   * Disconnect Gmail account for a user
   */
  async disconnectGmail(userId: string): Promise<void> {
    await this.postgres.query(
      `UPDATE users SET 
        gmail_refresh_token = NULL, 
        gmail_access_token = NULL, 
        gmail_token_expiry = NULL,
        gmail_connected = FALSE,
        gmail_email = NULL,
        updated_at = NOW() 
      WHERE id = $1`,
      [userId]
    );
  }

  /**
   * Check if user has Gmail connected
   */
  async hasGmailConnected(userId: string): Promise<boolean> {
    const result = await this.postgres.query(
      'SELECT gmail_connected FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) return false;
    return result.rows[0].gmail_connected || false;
  }

  /**
   * Delete a user by ID
   * Note: This should only be called after deleting all related data (receipts, OAuth accounts, etc.)
   */
  async deleteUser(userId: string): Promise<boolean> {
    const result = await this.postgres.query(
      'DELETE FROM users WHERE id = $1',
      [userId]
    );
    return result.rowCount > 0;
  }

}
