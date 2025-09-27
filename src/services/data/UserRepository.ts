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
    const userId = uuidv4();
    const result = await this.postgres.query(
      'INSERT INTO users (id, email) VALUES ($1, $2) RETURNING id',
      [userId, email]
    );
    return result.rows[0].id;
  }

  async findById(id: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email
    };
  }

  async findAll(): Promise<User[]> {
    const result = await this.postgres.query('SELECT * FROM users');
    return result.rows.map((row: any) => ({
      id: row.id,
      email: row.email
    }));
  }

}
