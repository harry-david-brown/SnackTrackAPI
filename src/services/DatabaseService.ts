import { User } from '../models/User';
import { Receipt } from '../models/Receipt';
import { CreateUserDTO } from '../models/CreateUserDTO';
import { AccountType } from '../models/AccountType';
import { Email } from '../models/Email';
import { LookupService } from './LookupService';
import { v4 as uuidv4 } from 'uuid';

export class DatabaseService {
  private users: User[] = [];
  private receipts: Receipt[] = [];
  constructor(private lookup: LookupService) {}

  async createUser(dto: CreateUserDTO): Promise<string> {
    const user: User = {
      id: uuidv4(),
      email: dto.email,
      type: AccountType.Gmail // TODO: Only Gmail supported for now
    };
    this.users.push(user);
    return user.id;
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.find(user => user.id === id);
  }

  async getUserTotalSpent(id: string): Promise<number> {
    const receipts = this.receipts.filter(r => r.userId === id);
    return receipts.reduce((sum, r) => sum + r.amountSpent, 0);
  }

  async updateUserReceipts(): Promise<void> {
    for (const user of this.users) {
      const newOrders = await this.lookup.getUserReceipts(user);
      this.receipts.push(...newOrders);
      // TODO: Use email - time received and order price to determine uniqueness
    }
  }

  async updateUserReceiptsForUser(userId: string): Promise<void> {
    const user = this.users.find(u => u.id === userId);
    if (user) {
      const newOrders = await this.lookup.getUserReceipts(user);
      // Remove existing receipts for this user to avoid duplicates
      this.receipts = this.receipts.filter(r => r.userId !== userId);
      this.receipts.push(...newOrders);
      console.log(`📊 Updated receipts for user ${user.email}: ${newOrders.length} receipts, total: $${newOrders.reduce((sum, r) => sum + r.amountSpent, 0)}`);
    }
  }
} 