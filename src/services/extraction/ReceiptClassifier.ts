/**
 * Receipt Classifier
 *
 * Determines whether an email is a receipt based on content analysis
 */

import { EmailClassification, ExtractorConfig, DEFAULT_EXTRACTOR_CONFIG } from './types';
import { HtmlTextExtractor } from './HtmlTextExtractor';
import { isDoorDashReceiptEmail } from './DoorDashReceiptParser';
import { extractEmailOrderEvidence } from './ReceiptOrderEvidenceExtractor';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';

export function orderAdjustmentProvider(
  from: string,
  text: string,
): 'uber_eats' | 'doordash' | undefined {
  const address = (from.match(/<([^<>]+)>/)?.[1] ?? from).trim();
  const domain = address.match(/^[^\s<>@]+@([a-z\d.-]+)$/i)?.[1]?.toLowerCase();
  const provider =
    domain && /(?:^|\.)doordash\.com$/.test(domain)
      ? 'doordash'
      : domain && /(?:^|\.)(?:uber\.com|ubereats\.com)$/.test(domain)
        ? 'uber_eats'
        : undefined;
  if (!provider || !/\border\b/i.test(text)) return undefined;
  const evidence = extractEmailOrderEvidence({ text, total: null });
  return evidence.documentKind === 'cancellation' ||
    (['refund', 'updated'].includes(evidence.documentKind) &&
      (evidence.recordedTotal !== null ||
        evidence.refundConfirmed === true ||
        evidence.refundAmount !== undefined ||
        evidence.payments.length > 0))
    ? provider
    : undefined;
}

export class ReceiptClassifier {
  private config: ExtractorConfig;
  private textExtractor: HtmlTextExtractor;

  constructor(
    config: Partial<ExtractorConfig> = {},
    private readonly policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY,
  ) {
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

    if (this.policyVersion === 3 && orderAdjustmentProvider(from, plainText)) {
      return {
        isReceipt: true,
        confidence: 0.99,
        reason:
          'Supported provider order adjustment with explicit financial or cancellation evidence',
        matchedKeywords: ['order adjustment'],
        tableWordHits: 0,
      };
    }

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
