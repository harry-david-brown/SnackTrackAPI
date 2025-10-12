import { User } from '../../models/User';
import { Receipt } from '../../models/Receipt';
import { Email } from '../email/Email';
import { EmailClient, EmailClientFactory } from '../email/EmailClient';

/**
 * Service for fetching user receipts from various sources
 * Uses dependency injection to reduce tight coupling with specific email clients
 */
export class ReceiptLookupService {
  constructor(private emailClientFactory: typeof EmailClientFactory = EmailClientFactory) {}

  async getUserReceipts(user: User): Promise<Receipt[]> {
    const emails = await this.getUserEmails(user);
    return emails
      .map(email => email.toReceipt())
      .filter(receipt => receipt !== null) as Receipt[];
  }

  async getUserEmails(user: User): Promise<Email[]> {
    // Default to gmail for now - user.type not implemented yet
    const emailClient = this.emailClientFactory.createClient('gmail' as any);
    return await emailClient.getEmails(user);
  }
} 