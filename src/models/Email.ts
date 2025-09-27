import { Receipt } from './Receipt';
import { EmailFilterService } from '../services/email/EmailFilterService';
import { ReceiptParserService } from '../services/receipt/ReceiptParserService';

export class Email {
  private static filterService = new EmailFilterService();
  private static parserService = new ReceiptParserService();

  constructor(
    public userId: string,
    public from: string,
    public to: string,
    public body: string,
    public subject?: string
  ) {}

  /**
   * Check if this email is likely a receipt before processing
   */
  isReceipt(): boolean {
    return Email.filterService.shouldProcessEmail(this);
  }

  /**
   * Get detailed classification of this email
   */
  getClassification() {
    return Email.filterService.classifyEmail(this);
  }

  /**
   * Convert email to receipt using the dedicated parser service
   */
  toReceipt(): Receipt | null {
    return Email.parserService.parseEmailToReceipt(this);
  }

} 