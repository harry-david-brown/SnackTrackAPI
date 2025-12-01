/**
 * Receipt Extractor
 * 
 * Main orchestrator for receipt extraction from emails
 * Combines classification and data extraction into a unified interface
 */

import {
  RawEmail,
  ExtractionResult,
  ExtractedReceiptData,
  EmailClassification,
  ExtractorConfig,
  DEFAULT_EXTRACTOR_CONFIG
} from './types';
import { HtmlTextExtractor } from './HtmlTextExtractor';
import { ReceiptClassifier } from './ReceiptClassifier';
import { ReceiptDataExtractor } from './ReceiptDataExtractor';

export class ReceiptExtractor {
  private textExtractor: HtmlTextExtractor;
  private classifier: ReceiptClassifier;
  private dataExtractor: ReceiptDataExtractor;
  private config: ExtractorConfig;

  constructor(config: Partial<ExtractorConfig> = {}) {
    this.config = { ...DEFAULT_EXTRACTOR_CONFIG, ...config };
    this.textExtractor = new HtmlTextExtractor(this.config);
    this.classifier = new ReceiptClassifier(this.config);
    this.dataExtractor = new ReceiptDataExtractor();
  }

  /**
   * Process a single email and extract receipt data
   */
  extract(email: RawEmail): ExtractionResult {
    const { body, subject = '', from = '' } = email;
    
    // Generate text representations
    const rawText = this.textExtractor.htmlToText(body);
    const coreText = this.textExtractor.extractCoreText(body);
    
    // Classify the email
    const classification = this.classifier.classify(body, subject);
    
    // Extract data if it's a receipt
    let data: ExtractedReceiptData | null = null;
    if (classification.isReceipt) {
      data = this.dataExtractor.extract(body, subject, from);
    }
    
    return {
      classification,
      data,
      rawText,
      coreText
    };
  }

  /**
   * Process multiple emails in batch
   */
  extractBatch(emails: RawEmail[]): ExtractionResult[] {
    return emails.map(email => this.extract(email));
  }

  /**
   * Filter emails to only receipts and extract their data
   */
  extractReceipts(emails: RawEmail[]): ExtractionResult[] {
    return this.extractBatch(emails).filter(result => result.classification.isReceipt);
  }

  /**
   * Quick check if an email is a receipt
   */
  isReceipt(email: RawEmail): boolean {
    return this.classifier.isReceipt(email.body, email.subject);
  }

  /**
   * Get just the classification without full extraction
   */
  classify(email: RawEmail): EmailClassification {
    return this.classifier.classify(email.body, email.subject);
  }

  /**
   * Get summary statistics from a batch of receipts
   */
  getSummary(results: ExtractionResult[]): ReceiptSummary {
    const receipts = results.filter(r => r.classification.isReceipt && r.data);
    
    let totalAmount = 0;
    let totalTax = 0;
    let totalTip = 0;
    let totalDeliveryFee = 0;
    let totalServiceFee = 0;
    let totalSavings = 0;
    const merchants = new Map<string, number>();
    const dateRange = { earliest: null as Date | null, latest: null as Date | null };

    for (const result of receipts) {
      const data = result.data!;
      
      if (data.total !== null) totalAmount += data.total;
      if (data.tax !== null) totalTax += data.tax;
      if (data.tip !== null) totalTip += data.tip;
      if (data.deliveryFee !== null) totalDeliveryFee += data.deliveryFee;
      if (data.serviceFee !== null) totalServiceFee += data.serviceFee;
      if (data.savings !== null) totalSavings += data.savings;
      
      if (data.merchant) {
        merchants.set(data.merchant, (merchants.get(data.merchant) || 0) + 1);
      }
      
      if (data.parsedDate) {
        if (!dateRange.earliest || data.parsedDate < dateRange.earliest) {
          dateRange.earliest = data.parsedDate;
        }
        if (!dateRange.latest || data.parsedDate > dateRange.latest) {
          dateRange.latest = data.parsedDate;
        }
      }
    }

    // Sort merchants by order count
    const topMerchants = [...merchants.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return {
      totalReceipts: receipts.length,
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      totalTip: Math.round(totalTip * 100) / 100,
      totalDeliveryFees: Math.round(totalDeliveryFee * 100) / 100,
      totalServiceFees: Math.round(totalServiceFee * 100) / 100,
      totalSavings: Math.round(totalSavings * 100) / 100,
      averageOrderAmount: receipts.length > 0 
        ? Math.round((totalAmount / receipts.length) * 100) / 100 
        : 0,
      topMerchants,
      dateRange
    };
  }
}

/**
 * Summary statistics from extracted receipts
 */
export interface ReceiptSummary {
  totalReceipts: number;
  totalAmount: number;
  totalTax: number;
  totalTip: number;
  totalDeliveryFees: number;
  totalServiceFees: number;
  totalSavings: number;
  averageOrderAmount: number;
  topMerchants: Array<{ name: string; count: number }>;
  dateRange: {
    earliest: Date | null;
    latest: Date | null;
  };
}

// Export singleton instance for convenience
export const receiptExtractor = new ReceiptExtractor();

