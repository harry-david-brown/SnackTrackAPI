import { User } from '../../models/User';
import { UserRepository } from '../data/UserRepository';
import { ReceiptRepository } from '../data/ReceiptRepository';

/**
 * Service for business logic operations
 * Uses repositories for data access to maintain separation of concerns
 */
export class DatabaseService {
  constructor(
    private userRepository: UserRepository,
    private receiptRepository: ReceiptRepository
  ) {}

  async createUser(email: string, timezone?: string): Promise<string> {
    return await this.userRepository.createUser(email, timezone);
  }


  async getUser(id: string): Promise<User | undefined> {
    return await this.userRepository.findById(id);
  }

  async getUserTotalSpent(id: string): Promise<number> {
    return await this.receiptRepository.getTotalSpentByUserId(id);
  }

  async updateUserTimezone(userId: string, timezone: string): Promise<void> {
    return await this.userRepository.updateTimezone(userId, timezone);
  }

}
