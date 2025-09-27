import { User } from '../../models/User';
import { Email } from './Email';

/**
 * Interface for email clients
 * Allows for easy swapping of different email providers
 */
export interface EmailClient {
  getEmails(user: User): Promise<Email[]>;
}

/**
 * Factory for creating email clients based on account type
 * Reduces tight coupling in LookupService
 */
export class EmailClientFactory {
  static createClient(accountType: string): EmailClient {
    switch (accountType) {
      case 'Gmail':
        return new (require('./GmailClient').GmailClient)();
      case 'Outlook':
        return new (require('./OutlookClient').OutlookClient)();
      default:
        throw new Error(`Unsupported account type: ${accountType}`);
    }
  }
}
