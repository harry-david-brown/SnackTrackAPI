import { User } from '../../models/User';
import { PostgresService } from './PostgresService';
import { v4 as uuidv4 } from 'uuid';

/**
 * Repository for user data access operations
 * Separated from DatabaseService to follow single responsibility principle
 */
export class UserRepository {
  constructor(private postgres: PostgresService) {}

  async createUser(email: string): Promise<string> {
    // First check if user already exists
    const existingUser = await this.findByEmail(email);
    if (existingUser) {
      return existingUser.id;
    }

    // Create new user if doesn't exist
    const userId = uuidv4();
    try {
      const result = await this.postgres.query(
        'INSERT INTO users (id, email) VALUES ($1, $2) RETURNING id',
        [userId, email]
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
      'SELECT id, email, email_verified, created_at FROM users WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified || false,
      createdAt: row.created_at
    };
  }

  async findAll(): Promise<User[]> {
    const result = await this.postgres.query('SELECT id, email, email_verified, created_at FROM users');
    return result.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified || false,
      createdAt: row.created_at
    }));
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      'SELECT id, email, email_verified, created_at FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified || false,
      createdAt: row.created_at
    };
  }

  async findByEmailWithPassword(email: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      'SELECT id, email, password, email_verified, created_at FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      password: row.password,
      emailVerified: row.email_verified || false,
      createdAt: row.created_at
    };
  }

  async createUserWithPassword(email: string, hashedPassword: string): Promise<string> {
    // First check if user already exists
    const existingUser = await this.findByEmail(email);
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    // Create new user with password (email_verified defaults to false)
    const userId = uuidv4();
    try {
      const result = await this.postgres.query(
        'INSERT INTO users (id, email, password, email_verified, created_at) VALUES ($1, $2, $3, FALSE, NOW()) RETURNING id',
        [userId, email, hashedPassword]
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

}
