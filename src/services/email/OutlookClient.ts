import { User } from '../../models/User';
import { Email } from './Email';
import { EmailClient } from './EmailClient';

export class OutlookClient implements EmailClient {
  async getEmails(user: User): Promise<Email[]> {
    throw new Error('Not implemented');
  }
} 