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
    const emailClient = this.emailClientFactory.createClient(user.type);
    return await emailClient.getEmails(user);
  }
} 