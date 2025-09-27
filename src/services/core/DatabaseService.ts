import { User } from '../../models/User';
import { Receipt } from '../../models/Receipt';
import { CreateUserDTO } from '../../models/CreateUserDTO';
import { ReceiptLookupService } from '../receipt/ReceiptLookupService';
import { UserRepository } from '../data/UserRepository';
import { ReceiptRepository } from '../data/ReceiptRepository';

/**
 * Service for business logic operations
 * Uses repositories for data access to maintain separation of concerns
 */
export class DatabaseService {
  constructor(
    private receiptLookup: ReceiptLookupService,
    private userRepository: UserRepository,
    private receiptRepository: ReceiptRepository
  ) {}

  async createUser(dto: CreateUserDTO): Promise<string> {
    return await this.userRepository.createUser(dto);
  }

  async createCsvUser(): Promise<string> {
    return await this.userRepository.createCsvUser();
  }

  async getUser(id: string): Promise<User | undefined> {
    return await this.userRepository.findById(id);
  }

  async getUserTotalSpent(id: string): Promise<number> {
    return await this.receiptRepository.getTotalSpentByUserId(id);
  }

  async updateUserReceipts(): Promise<void> {
    const users = await this.userRepository.findAll();
    for (const user of users) {
      await this.updateUserReceiptsForUser(user.id);
    }
  }

  async updateUserReceiptsForUser(userId: string): Promise<void> {
    const user = await this.getUser(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const newOrders = await this.receiptLookup.getUserReceipts(user);
    
    // Clear existing receipts for this user to avoid duplicates
    await this.receiptRepository.deleteByUserId(userId);
    
    // Filter and insert only actual receipts
    let actualReceipts = 0;
    let skippedEmails = 0;
    
    for (const receipt of newOrders) {
      // Only store receipts with actual spending (amount > 0)
      if (receipt.amountSpent > 0) {
        await this.receiptRepository.save(receipt);
        actualReceipts++;
      } else {
        skippedEmails++;
      }
    }
    
    console.log(`📊 Updated receipts for user ${user.email}: ${actualReceipts} actual receipts stored, ${skippedEmails} non-receipt emails skipped, total: $${newOrders.filter(r => r.amountSpent > 0).reduce((sum, r) => sum + r.amountSpent, 0)}`);
  }
} 