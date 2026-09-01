/**
 * Receipt Classifier
 *
 * Determines whether an email is a receipt based on content analysis
 */

import { EmailClassification, ExtractorConfig, DEFAULT_EXTRACTOR_CONFIG } from './types';
import { HtmlTextExtractor } from './HtmlTextExtractor';
import { isDoorDashReceiptEmail } from './DoorDashReceiptParser';

export class ReceiptClassifier {
  private config: ExtractorConfig;
  private textExtractor: HtmlTextExtractor;

  constructor(config: Partial<ExtractorConfig> = {}) {
    this.config = { ...DEFAULT_EXTRACTOR_CONFIG, ...config };
    this.textExtractor = new HtmlTextExtractor(this.config);
  }

  /**
   * Classify an email as receipt or non-receipt
   * Uses keyword matching and table word detection
   */
  classify(htmlBody: string, subject?: string, from: string = ''): EmailClassification {
    const plainText = this.textExtractor.htmlToText(htmlBody);
    const coreText = this.textExtractor.extractCoreText(htmlBody);
    const subjectLower = (subject || '').toLowerCase();
    const combinedText = `${subjectLower} ${coreText}`;

    if (isDoorDashReceiptEmail({ from, subject: subject || '', text: plainText })) {
      const matchedKeywords = ['doordash order confirmation', 'your receipt'];
      const tableWordHits = this.config.tableWords.filter((word) =>
        plainText.toLowerCase().includes(word),
      ).length;
      return {
        isReceipt: true,
        confidence: 0.99,
        reason: 'Trusted DoorDash sender with receipt confirmation and monetary breakdown',
        matchedKeywords,
        tableWordHits,
      };
    }

    // Check for receipt keywords (strong indicators)
    const matchedKeywords = this.config.receiptKeywords.filter((keyword) =>
      combinedText.includes(keyword),
    );

    // Check for table words (subtotal, tax, total, tip, etc.)
    const tableWordHits = this.config.tableWords.filter((word) =>
      combinedText.includes(word),
    ).length;

    // Determine if it's a receipt
    let isReceipt = false;
    let confidence = 0;
    let reason = '';

    if (matchedKeywords.length > 0) {
      isReceipt = true;
      confidence = 0.9 + matchedKeywords.length * 0.02; // Max ~0.98
      reason = `Matched receipt keywords: ${matchedKeywords.join(', ')}`;
    } else if (tableWordHits >= this.config.minTableWordHits) {
      isReceipt = true;
      confidence = 0.7 + tableWordHits * 0.05; // 0.8-0.95 range
      reason = `Found ${tableWordHits} table words indicating money breakdown`;
    } else {
      isReceipt = false;
      confidence = 0.1;
      reason = 'No receipt indicators found';
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);

    return {
      isReceipt,
      confidence,
      reason,
      matchedKeywords,
      tableWordHits,
    };
  }

  /**
   * Quick check for receipt status
   */
  isReceipt(htmlBody: string, subject?: string, from: string = ''): boolean {
    return this.classify(htmlBody, subject, from).isReceipt;
  }
}
