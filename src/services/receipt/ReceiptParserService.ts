import { Receipt, ReceiptType, ReceiptItem, DataSource } from '../../models/Receipt';
import { Email } from '../email/Email';
import { 
  ReceiptExtractor, 
  RawEmail, 
  ServiceType, 
  ExtractedReceiptData 
} from '../extraction';

/**
 * Service responsible for parsing emails into receipts
 * Uses the new ReceiptExtractor for accurate data extraction
 */
export class ReceiptParserService {
  private extractor: ReceiptExtractor;
  
  constructor() {
    this.extractor = new ReceiptExtractor();
  }
  
  /**
   * Parse an email into a receipt
   */
  parseEmailToReceipt(email: Email): Receipt | null {
    // Convert to RawEmail format for the extractor
    const rawEmail: RawEmail = {
      userId: email.userId,
      from: email.from,
      to: email.to,
      body: email.body,
      subject: email.subject
    };
    
    // Use the new extraction system
    const result = this.extractor.extract(rawEmail);
    
    // Only convert to receipt if it's actually a receipt
    if (!result.classification.isReceipt || !result.data) {
      return null;
    }
    
    return this.convertToReceipt(email.userId, result.data);
  }

  /**
   * Parse multiple emails and return receipts
   */
  parseEmailsToReceipts(emails: Email[]): Receipt[] {
    const rawEmails: RawEmail[] = emails.map(email => ({
      userId: email.userId,
      from: email.from,
      to: email.to,
      body: email.body,
      subject: email.subject
    }));

    const results = this.extractor.extractReceipts(rawEmails);
    
    return results
      .filter(r => r.data !== null)
      .map((r, i) => this.convertToReceipt(emails[i].userId, r.data!))
      .filter((receipt): receipt is Receipt => receipt !== null);
  }

  /**
   * Check if an email is likely a receipt
   */
  isReceipt(email: Email): boolean {
    const rawEmail: RawEmail = {
      userId: email.userId,
      from: email.from,
      to: email.to,
      body: email.body,
      subject: email.subject
    };
    return this.extractor.isReceipt(rawEmail);
  }

  /**
   * Convert extracted data to Receipt model
   */
  private convertToReceipt(
    userId: string, 
    data: ExtractedReceiptData
  ): Receipt {
    const items: ReceiptItem[] = [];
    
    // Note: Individual items are not extracted from email receipts
    // as they require more sophisticated parsing. The total represents
    // the order as a single "item" for now.
    
    const receiptType = this.mapServiceToReceiptType(data.service);
    
    // Use "Unknown Restaurant" as default if merchant is not extracted
    const restaurantName = data.merchant || 'Unknown Restaurant';
    
    return new Receipt(
      userId,
      items,
      data.total ?? 0,
      receiptType,
      restaurantName,
      data.parsedDate ?? undefined,
      DataSource.EMAIL
    );
  }

  /**
   * Map ServiceType to ReceiptType
   */
  private mapServiceToReceiptType(service: ServiceType): ReceiptType {
    switch (service) {
      case ServiceType.UBER_EATS:
        return ReceiptType.UBER_EATS;
      case ServiceType.DOORDASH:
        return ReceiptType.DOORDASH;
      case ServiceType.GRUBHUB:
        return ReceiptType.GRUBHUB;
      case ServiceType.UBER_RIDE:
      case ServiceType.UBER_OTHER:
      case ServiceType.OTHER:
      default:
        return ReceiptType.UNKNOWN;
    }
  }
}
