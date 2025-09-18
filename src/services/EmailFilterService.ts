import { Email } from '../models/Email';
import { config } from '../config/AppConfig';

export interface EmailClassification {
  isReceipt: boolean;
  confidence: number; // 0-1 scale
  reason: string;
  receiptType?: string;
}

export class EmailFilterService {
  
  /**
   * Determines if an email is a Uber Eats receipt
   * Only processes emails from Uber - rejects everything else to avoid duplicates
   */
  classifyEmail(email: Email): EmailClassification {
    const from = email.from.toLowerCase();
    const subject = email.subject?.toLowerCase() || '';
    const body = email.body.toLowerCase();
    
    // Only accept emails from Uber
    const uberSenders = [
      'noreply@uber.com',
      'noreply@ubereats.com',
      'uber.com',
      'ubereats.com'
    ];
    
    // Check if it's from Uber
    const isFromUber = uberSenders.some(sender => from.includes(sender));
    
    if (isFromUber) {
      return {
        isReceipt: true,
        confidence: 0.95,
        reason: 'Email from Uber - processing as receipt',
        receiptType: 'uber'
      };
    }
    
    // Check for forwarded receipts if enabled in config
    if (config.shouldAllowForwardedReceipts()) {
      const forwardedSender = config.getForwardedReceiptSender();
      const isFromForwardedSender = from.includes(forwardedSender);
      
      if (isFromForwardedSender) {
        return {
          isReceipt: true,
          confidence: 0.90,
          reason: `Email from ${forwardedSender} (forwarded Uber receipts) in ${config.isDevelopment() ? 'development' : 'production'} mode`,
          receiptType: 'uber'
        };
      }
    }
    
    // Reject everything else
    return {
      isReceipt: false,
      confidence: 0,
      reason: 'Not from Uber - rejecting to avoid duplicates with credit card/PayPal receipts'
    };
  }
  
  /**
   * Quick check to see if email should be processed at all
   */
  shouldProcessEmail(email: Email): boolean {
    const classification = this.classifyEmail(email);
    return classification.isReceipt;
  }
  
}
