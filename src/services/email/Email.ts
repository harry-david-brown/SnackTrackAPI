import { Receipt } from '../../models/Receipt';
import { EmailFilterService } from './EmailFilterService';
import { ReceiptParserService } from '../receipt/ReceiptParserService';

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