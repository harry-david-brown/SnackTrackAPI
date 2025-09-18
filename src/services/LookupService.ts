import { User } from '../models/User';
import { Receipt } from '../models/Receipt';
import { Email } from '../models/Email';
import { AccountType } from '../models/AccountType';
import { GmailClient } from '../services/email/GmailClient';
// import { OutlookClient } from '../services/email/OutlookClient';

export class LookupService {
  async getUserReceipts(user: User): Promise<Receipt[]> {
    const emails = await this.getUserEmails(user);
    return emails
      .map(email => email.toReceipt())
      .filter(receipt => receipt !== null) as Receipt[];
  }

  async getUserEmails(user: User): Promise<Email[]> {
    switch (user.type) {
      case AccountType.Gmail:
        return await new GmailClient().getEmails(user);
      // case AccountType.Outlook:
      //   return await new OutlookClient().getEmails(user);
      default:
        throw new Error('Unsupported account type');
    }
  }
} 