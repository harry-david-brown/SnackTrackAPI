/**
 * Receipt Extraction Module
 * 
 * A comprehensive system for extracting receipt data from email content.
 * 
 * ## Architecture
 * 
 * The module is organized into focused, single-responsibility components:
 * 
 * - **types.ts**: Type definitions and configuration
 * - **HtmlTextExtractor**: HTML to text conversion utilities
 * - **ReceiptClassifier**: Email classification (receipt vs non-receipt)
 * - **ReceiptDataExtractor**: Structured data extraction from receipts
 * - **ReceiptExtractor**: Main orchestrator combining all components
 * 
 * ## Usage
 * 
 * ```typescript
 * import { ReceiptExtractor, RawEmail } from './extraction';
 * 
 * const extractor = new ReceiptExtractor();
 * 
 * // Single email extraction
 * const result = extractor.extract({
 *   userId: 'user-123',
 *   from: 'noreply@uber.com',
 *   to: 'user@example.com',
 *   body: '<html>...</html>',
 *   subject: 'Your order with Uber Eats'
 * });
 * 
 * if (result.classification.isReceipt && result.data) {
 *   console.log(`Total: ${result.data.currency}${result.data.total}`);
 *   console.log(`Merchant: ${result.data.merchant}`);
 * }
 * 
 * // Batch processing
 * const results = extractor.extractBatch(emails);
 * const summary = extractor.getSummary(results);
 * console.log(`Processed ${summary.totalReceipts} receipts`);
 * console.log(`Total spent: $${summary.totalAmount}`);
 * ```
 * 
 * ## Configuration
 * 
 * The extractor can be configured with custom keywords and settings:
 * 
 * ```typescript
 * const extractor = new ReceiptExtractor({
 *   receiptKeywords: [...DEFAULT_EXTRACTOR_CONFIG.receiptKeywords, 'custom keyword'],
 *   maxCoreLines: 25
 * });
 * ```
 */

// Types
export {
  ServiceType,
  Currency,
  EmailClassification,
  RawEmail,
  MonetaryAmount,
  ExtractedReceiptData,
  ExtractionResult,
  ExtractorConfig,
  DEFAULT_EXTRACTOR_CONFIG
} from './types';

// Components
export { HtmlTextExtractor } from './HtmlTextExtractor';
export { ReceiptClassifier } from './ReceiptClassifier';
export { ReceiptDataExtractor } from './ReceiptDataExtractor';

// Main orchestrator
export { ReceiptExtractor, ReceiptSummary, receiptExtractor } from './ReceiptExtractor';

