import { User } from '../../models/User';
import { Email } from './Email';

/**
 * Interface for email clients
 * Allows for easy swapping of different email providers
 */
export interface EmailClient {
  getEmails(user: User, options?: { after?: Date }): Promise<Email[]>;
}
