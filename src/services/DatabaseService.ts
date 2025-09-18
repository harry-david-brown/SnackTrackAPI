import { User } from '../models/User';
import { Receipt } from '../models/Receipt';
import { CreateUserDTO } from '../models/CreateUserDTO';
import { AccountType } from '../models/AccountType';
import { Email } from '../models/Email';
import { LookupService } from './LookupService';
import { PostgresService } from './PostgresService';
import { v4 as uuidv4 } from 'uuid';

export class DatabaseService {
  constructor(
    private lookup: LookupService,
    private postgres: PostgresService
  ) {}

  async createUser(dto: CreateUserDTO): Promise<string> {
    const userId = uuidv4();
    const result = await this.postgres.query(
      'INSERT INTO users (id, email, account_type) VALUES ($1, $2, $3) RETURNING id',
      [userId, dto.email, AccountType.Gmail]
    );
    return result.rows[0].id;
  }

  async getUser(id: string): Promise<User | undefined> {
    const result = await this.postgres.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      type: row.account_type as AccountType
    };
  }

  async getUserTotalSpent(id: string): Promise<number> {
    const result = await this.postgres.query(
      'SELECT COALESCE(SUM(amount_spent), 0) as total FROM receipts WHERE user_id = $1',
      [id]
    );
    return parseFloat(result.rows[0].total);
  }

  async updateUserReceipts(): Promise<void> {
    const users = await this.postgres.query('SELECT * FROM users');
    for (const userRow of users.rows) {
      const user: User = {
        id: userRow.id,
        email: userRow.email,
        type: userRow.account_type as AccountType
      };
      await this.updateUserReceiptsForUser(user.id);
    }
  }

  async updateUserReceiptsForUser(userId: string): Promise<void> {
    const user = await this.getUser(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const newOrders = await this.lookup.getUserReceipts(user);
    
    // Clear existing receipts for this user to avoid duplicates
    await this.postgres.query('DELETE FROM receipts WHERE user_id = $1', [userId]);
    
    // Insert new receipts
    for (const receipt of newOrders) {
      await this.postgres.query(
        'INSERT INTO receipts (user_id, amount_spent, items, email_from, email_to, email_body) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, receipt.amountSpent, receipt.items, receipt.emailFrom, receipt.emailTo, receipt.emailBody]
      );
    }
    
    console.log(`📊 Updated receipts for user ${user.email}: ${newOrders.length} receipts, total: $${newOrders.reduce((sum, r) => sum + r.amountSpent, 0)}`);
  }
} 