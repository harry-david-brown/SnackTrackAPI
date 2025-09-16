import { User } from '../../models/User';
import { Email } from '../../models/Email';

export class OutlookClient {
  async getEmails(user: User): Promise<Email[]> {
    throw new Error('Not implemented');
  }
} 