import { Email } from './Email';
import { config } from '../../config/AppConfig';
import { ReceiptClassifier, EmailClassification as ExtractorClassification } from '../extraction';

export interface EmailClassification {
  isReceipt: boolean;
  confidence: number; // 0-1 scale
  reason: string;
  receiptType?: string;
}

export class EmailFilterService {
  private contentClassifier: ReceiptClassifier;

  constructor() {
    this.contentClassifier = new ReceiptClassifier();
  }
  
  /**
   * Determines if an email is a Uber Eats receipt
   * Uses sender verification + content-based classification
   */
  classifyEmail(email: Email): EmailClassification {
    const from = email.from.toLowerCase();
    const subject = email.subject?.toLowerCase() || '';
    
    // List of known Uber senders
    const uberSenders = [
      'noreply@uber.com',
      'noreply@ubereats.com',
      'uber.com',
      'ubereats.com'
    ];
    
    // Check if it's from Uber
    const isFromUber = uberSenders.some(sender => from.includes(sender));
    
    if (isFromUber) {
      // Use content-based classification to verify it's a receipt
      const contentClassification = this.contentClassifier.classify(email.body, email.subject);
      
      if (contentClassification.isReceipt) {
        return {
          isReceipt: true,
          confidence: Math.max(0.95, contentClassification.confidence),
          reason: `Email from Uber with receipt indicators: ${contentClassification.reason}`,
          receiptType: 'uber'
        };
      } else {
        // From Uber but not a receipt (could be promo, account notification, etc.)
        return {
          isReceipt: false,
          confidence: contentClassification.confidence,
          reason: 'Email from Uber but no receipt indicators found - likely promotional or notification',
          receiptType: undefined
        };
      }
    }
    
    // Check for forwarded receipts if enabled in config
    if (config.shouldAllowForwardedReceipts()) {
      const forwardedSender = config.getForwardedReceiptSender();
      const isFromForwardedSender = from.includes(forwardedSender);
      
      if (isFromForwardedSender) {
        // Use content classification for forwarded emails
        const contentClassification = this.contentClassifier.classify(email.body, email.subject);
        
        if (contentClassification.isReceipt) {
          return {
            isReceipt: true,
            confidence: 0.90,
            reason: `Forwarded email from ${forwardedSender} with receipt content in ${config.isDevelopment() ? 'development' : 'production'} mode`,
            receiptType: 'uber'
          };
        }
      }
    }
    
    // Reject everything else
    return {
      isReceipt: false,
      confidence: 0,
      reason: 'Not from a recognized receipt sender'
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
