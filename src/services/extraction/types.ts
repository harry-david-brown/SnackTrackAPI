/**
 * Receipt Extraction Types
 * 
 * Type definitions for the receipt extraction system
 */

/**
 * Supported service types for receipt classification
 */
export enum ServiceType {
  UBER_EATS = 'UBER_EATS',
  UBER_RIDE = 'UBER_RIDE',
  UBER_OTHER = 'UBER_OTHER',
  DOORDASH = 'DOORDASH',
  GRUBHUB = 'GRUBHUB',
  SKIP_THE_DISHES = 'SKIP_THE_DISHES',
  OTHER = 'OTHER'
}

/**
 * Supported currencies
 */
export enum Currency {
  CAD = 'CAD',
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  UNKNOWN = 'UNKNOWN'
}

/**
 * Email classification result
 */
export interface EmailClassification {
  isReceipt: boolean;
  confidence: number; // 0-1 scale
  reason: string;
  matchedKeywords: string[];
  tableWordHits: number;
}

/**
 * Raw email data structure
 */
export interface RawEmail {
  userId: string;
  from: string;
  to: string;
  body: string; // HTML body
  subject?: string;
}

/**
 * Parsed monetary amount with currency
 */
export interface MonetaryAmount {
  amount: number;
  currency: Currency;
  raw: string; // Original matched string
}

/**
 * Extracted receipt data
 */
export interface ExtractedReceiptData {
  // Core identifiers
  orderId: string | null;  // Added orderId
  service: ServiceType;
  merchant: string | null;

  // Timestamps
  orderDate: string | null;
  orderTime: string | null;
  parsedDate: Date | null;

  // Monetary values
  currency: Currency;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  deliveryFee: number | null;
  serviceFee: number | null;
  savings: number | null;

  // Additional metadata
  deliveryAddress: string | null;
  paymentMethod: string | null;

  // Source info
  subject: string;
  from: string;

  // Extraction metadata
  extractionConfidence: number;
  warnings: string[];
}

/**
 * Complete extraction result
 */
export interface ExtractionResult {
  classification: EmailClassification;
  data: ExtractedReceiptData | null;
  rawText: string;
  coreText: string;
}

/**
 * Configuration for the extractor
 */
export interface ExtractorConfig {
  receiptKeywords: string[];
  tableWords: string[];
  footerWords: string[];
  maxCoreLines: number;
  minTableWordHits: number;
}

/**
 * Default extractor configuration
 */
export const DEFAULT_EXTRACTOR_CONFIG: ExtractorConfig = {
  receiptKeywords: [
    'your receipt',
    'trip receipt',
    'uber receipt',
    'your order from',
    'thanks for ordering',
    'thanks for your order',
    'order confirmation',
    'order completed',
    'delivery receipt'
  ],
  tableWords: ['subtotal', 'tax', 'total', 'tip', 'delivery fee', 'service fee'],
  footerWords: [
    'unsubscribe', 'privacy', 'terms',
    'follow us', 'facebook', 'twitter', 'instagram',
    'contact support', 'my orders', 'forgot password'
  ],
  maxCoreLines: 20,
  minTableWordHits: 2
};

