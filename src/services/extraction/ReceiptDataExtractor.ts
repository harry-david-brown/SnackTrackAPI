/**
 * Receipt Data Extractor
 *
 * Extracts structured receipt data from email HTML content
 */

import { ExtractedReceiptData, ServiceType, Currency, MonetaryAmount } from './types';
import { HtmlTextExtractor } from './HtmlTextExtractor';
import { decode } from 'html-entities';
import { isDoorDashReceiptEmail, parseDoorDashReceipt } from './DoorDashReceiptParser';

interface ExtractionMetadata {
  providerMessageId?: string;
  receivedAt?: Date;
  mailboxProvider?: 'gmail' | 'microsoft';
}

// Regex patterns for data extraction
const PATTERNS = {
  // Money patterns: CA$20.33, US$15.00, $30.87, €25.00, £18.50
  money: /(?<currency>CA\$|US\$|\$|€|£)\s*(?<amount>\d+(?:\.\d{2})?)/g,

  // Date patterns: November 15, 2022 | Nov 14, 2025 | 11/16/25
  dateWords:
    /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/gi,
  dateNumeric: /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g,

  // Time patterns: 8:17 PM, 9:56 AM, 10:14 am
  time: /\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|AM|PM)/gi,

  // Restaurant/merchant patterns
  orderFrom: /(?:order(?:ed)?\s+from|receipt\s+from|your\s+order\s+from)\s+([^,.]+)/gi,
  restaurantName: /Here's your receipt for ([^.]+)\./i,

  // Address patterns
  deliveryAddress: /(?:delivered?\s+to|delivery\s+to)[:\s]*([^<\n]+)/gi,

  // Payment method patterns
  paymentCard: /(Visa|Mastercard|Amex|American Express|Discover)\s*[•·…*]+\s*(\d{4})/gi,

  // Savings patterns
  // Savings patterns
  savings: /(?:saved?|savings?)[:\s]*(?:CA\$|US\$|\$|€|£)?\s*(\d+(?:\.\d{2})?)/gi,

  // Uber UUID patterns
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  orderUuidParam:
    /(?:order_uuid|eats_order_uuid|uuid)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  uberLinkUuid:
    /https?:\/\/[^\s"'<>]*uber[^\s"'<>]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
};

// Currency symbol to enum mapping
const CURRENCY_MAP: Record<string, Currency> = {
  CA$: Currency.CAD,
  US$: Currency.USD,
  $: Currency.USD, // Default $ to USD
  '€': Currency.EUR,
  '£': Currency.GBP,
};

export class ReceiptDataExtractor {
  private textExtractor: HtmlTextExtractor;

  constructor() {
    this.textExtractor = new HtmlTextExtractor();
  }

  /**
   * Extract all structured data from an email
   */
  extract(
    htmlBody: string,
    subject: string = '',
    from: string = '',
    metadata: ExtractionMetadata = {},
  ): ExtractedReceiptData {
    const plainText = this.textExtractor.htmlToText(htmlBody);
    const warnings: string[] = [];

    // Detect service type
    const service = this.detectService(subject, from, plainText);

    // Extract orderId
    let orderId = this.extractOrderId(htmlBody, plainText, service);

    // Extract merchant/restaurant name
    let merchant = this.extractMerchant(htmlBody, plainText, subject);

    // Extract date and time
    const extractedDateTime = this.extractDateTime(plainText, htmlBody);
    const { orderDate } = extractedDateTime;
    let { orderTime, parsedDate } = extractedDateTime;

    // Extract monetary values
    let total = this.extractAmountNear('total', plainText, htmlBody);
    let subtotal = this.extractAmountNear('subtotal', plainText, htmlBody);
    let tax = this.extractAmountNear('tax', plainText, htmlBody);
    let tip = this.extractAmountNear('tip', plainText, htmlBody);
    let deliveryFee = this.extractAmountNear('delivery fee', plainText, htmlBody);
    let serviceFee = this.extractAmountNear('service fee', plainText, htmlBody);
    let savings = this.extractSavings(plainText);

    let doorDashCurrency: Currency | null = null;
    if (service === ServiceType.DOORDASH) {
      const doorDash = parseDoorDashReceipt({
        html: htmlBody,
        text: plainText,
        subject,
        from,
        providerMessageId: metadata.providerMessageId,
        mailboxProvider: metadata.mailboxProvider,
      });
      orderId = doorDash.orderId;
      merchant = doorDash.merchant;
      total = doorDash.total;
      subtotal = doorDash.subtotal;
      tax = doorDash.tax;
      tip = doorDash.tip;
      deliveryFee = doorDash.deliveryFee;
      serviceFee = doorDash.serviceFee;
      savings = doorDash.savings;
      doorDashCurrency = doorDash.currency;
      warnings.push(...doorDash.warnings);

      // DoorDash confirmations generally show only an estimated delivery window,
      // not the order time. The provider timestamp is the safest available order
      // timestamp and avoids reinterpreting that delivery estimate as an order.
      orderTime = orderDate ? orderTime : null;
      if (
        !parsedDate &&
        metadata.receivedAt instanceof Date &&
        !Number.isNaN(metadata.receivedAt.getTime())
      ) {
        parsedDate = new Date(metadata.receivedAt.getTime());
        warnings.push('Order timestamp inferred from the DoorDash email timestamp');
      }
    }

    // Determine currency from extracted values
    let currency =
      doorDashCurrency ??
      this.determineCurrency(total, subtotal, tax, tip, deliveryFee, serviceFee);
    // Uber commonly renders Canadian receipts with a bare "$". Infer CAD only
    // when the template itself contains a strong Canadian entity/address cue.
    if (
      doorDashCurrency === null &&
      currency === Currency.USD &&
      /Uber Portier Canada|\bCanada\b|,\s*(?:ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|NT|NU|YT)\b/i.test(
        plainText,
      )
    ) {
      currency = Currency.CAD;
    }

    // Extract additional metadata
    const deliveryAddress = this.extractDeliveryAddress(plainText, htmlBody);
    const paymentMethod = this.extractPaymentMethod(plainText, htmlBody);

    // Calculate confidence based on extracted data
    const extractionConfidence = this.calculateConfidence({
      hasTotal: total !== null,
      hasMerchant: merchant !== null,
      hasDate: parsedDate !== null,
      hasSubtotal: subtotal !== null,
      hasTax: tax !== null,
    });

    // Add warnings for missing data
    if (total === null) warnings.push('Could not extract total amount');
    if (merchant === null) warnings.push('Could not extract merchant name');
    if (parsedDate === null) warnings.push('Could not extract order date');

    return {
      orderId,
      service,
      merchant,
      orderDate,
      orderTime,
      parsedDate,
      currency,
      total: total?.amount ?? null,
      subtotal: subtotal?.amount ?? null,
      tax: tax?.amount ?? null,
      tip: tip?.amount ?? null,
      deliveryFee: deliveryFee?.amount ?? null,
      serviceFee: serviceFee?.amount ?? null,
      savings,
      deliveryAddress,
      paymentMethod,
      subject,
      from,
      extractionConfidence,
      warnings,
    };
  }

  /**
   * Detect service type from email content
   */
  private detectService(subject: string, from: string, text: string): ServiceType {
    const combined = `${subject} ${from} ${text}`.toLowerCase();

    if (isDoorDashReceiptEmail({ from, subject, text })) {
      return ServiceType.DOORDASH;
    }

    if (combined.includes('uber eats') || combined.includes('ubereats')) {
      return ServiceType.UBER_EATS;
    }
    if (combined.includes('uber trip') || combined.includes('ride with uber')) {
      return ServiceType.UBER_RIDE;
    }
    if (combined.includes('uber')) {
      // Check context - if it mentions food/restaurant, it's likely Uber Eats
      if (
        combined.includes('order') ||
        combined.includes('delivery') ||
        combined.includes('restaurant') ||
        combined.includes('food')
      ) {
        return ServiceType.UBER_EATS;
      }
      return ServiceType.UBER_OTHER;
    }
    if (combined.includes('grubhub')) {
      return ServiceType.GRUBHUB;
    }
    if (combined.includes('skip') && combined.includes('dish')) {
      return ServiceType.SKIP_THE_DISHES;
    }

    return ServiceType.OTHER;
  }

  /**
   * Extract merchant/restaurant name
   */
  private extractMerchant(html: string, text: string, subject: string): string | null {
    // Try data-testid attribute first (Uber emails)
    const dataAttr = this.textExtractor.extractDataAttribute(html, 'merchant_name');
    if (dataAttr) return dataAttr;

    // Try "receipt for X" pattern
    const receiptFor = PATTERNS.restaurantName.exec(text);
    if (receiptFor) {
      return this.cleanMerchantName(receiptFor[1]);
    }

    // Try "ordered from X" or "order from X" pattern
    const combined = `${subject} ${text}`;
    const orderFromMatches = [...combined.matchAll(PATTERNS.orderFrom)];
    if (orderFromMatches.length > 0) {
      return this.cleanMerchantName(orderFromMatches[0][1]);
    }

    // Try "You ordered from X" in plain text
    const youOrdered = text.match(/You ordered from ([^\n]+)/i);
    if (youOrdered) {
      return this.cleanMerchantName(youOrdered[1]);
    }

    return null;
  }

  /**
   * Clean up extracted merchant name
   */
  private cleanMerchantName(name: string): string {
    return decode(name).replace(/\s+/g, ' ').replace(/[<>]/g, '').trim();
  }

  /**
   * Extract date and time from email
   */
  private extractDateTime(
    text: string,
    html: string,
  ): {
    orderDate: string | null;
    orderTime: string | null;
    parsedDate: Date | null;
  } {
    let orderDate: string | null = null;
    let orderTime: string | null = null;
    let parsedDate: Date | null = null;

    // Prefer the last timestamp in the receipt header. Saved Gmail pages add
    // their own sent time before the actual Uber body; tip-update emails also
    // repeat the later payment time below the receipt total.
    const bodyMarker = text.search(/Thanks for|Here's your receipt|Your order from|\bTotal\b/i);
    const headerText = bodyMarker > 0 ? text.slice(0, bodyMarker) : text;

    // Try word-based dates first (more reliable parsing)
    const wordDateMatches = headerText.match(PATTERNS.dateWords) || text.match(PATTERNS.dateWords);
    if (wordDateMatches?.length) {
      orderDate = wordDateMatches[wordDateMatches.length - 1];
      const match = orderDate.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
      if (match) {
        const month = new Date(`${match[1]} 1, 2000`).getUTCMonth();
        parsedDate = new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
      }
    }

    // Try numeric dates if no word date found
    if (!orderDate) {
      PATTERNS.dateNumeric.lastIndex = 0;
      const numericMatch = PATTERNS.dateNumeric.exec(headerText) || PATTERNS.dateNumeric.exec(text);
      if (numericMatch) {
        orderDate = numericMatch[0];
        // Parse MM/DD/YY format
        const [, month, day, year] = numericMatch;
        const fullYear = year.length === 2 ? `20${year}` : year;
        parsedDate = new Date(Date.UTC(parseInt(fullYear), parseInt(month) - 1, parseInt(day)));
        if (isNaN(parsedDate.getTime())) {
          parsedDate = null;
        }
      }
    }

    // Extract time
    const timeMatches = headerText.match(PATTERNS.time) || text.match(PATTERNS.time);
    if (timeMatches?.length) {
      orderTime = timeMatches[timeMatches.length - 1];

      // If we have both date and time, combine them
      if (parsedDate && orderTime) {
        const timeParts = orderTime.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|AM|PM)/i);
        if (timeParts) {
          let hours = parseInt(timeParts[1]);
          const minutes = parseInt(timeParts[2]);
          const isPM = /p\.?m\.?/i.test(timeParts[3]);

          if (isPM && hours !== 12) hours += 12;
          if (!isPM && hours === 12) hours = 0;

          parsedDate.setUTCHours(hours, minutes, 0, 0);
        }
      }
    }

    return { orderDate, orderTime, parsedDate };
  }

  /**
   * Extract monetary amount near a label
   */
  private extractAmountNear(label: string, text: string, html: string): MonetaryAmount | null {
    // Build regex to find label followed by amount
    const labelPattern = new RegExp(
      `${label}[:\\s]*(?<currency>CA\\$|US\\$|\\$|€|£)?\\s*(?<amount>\\d+(?:\\.\\d{2})?)`,
      'gi',
    );

    // Search in plain text first
    const textMatch = labelPattern.exec(text);
    if (textMatch?.groups) {
      const amount = parseFloat(textMatch.groups.amount);
      if (!isNaN(amount)) {
        const currencySymbol = textMatch.groups.currency || '$';
        return {
          amount,
          currency: CURRENCY_MAP[currencySymbol] || Currency.UNKNOWN,
          raw: textMatch[0],
        };
      }
    }

    // Try HTML data attributes for Uber emails
    const testIdMap: Record<string, string> = {
      total: 'total_fare_amount',
      subtotal: 'subtotal_amount',
      tax: 'tax_amount',
      tip: 'tip_amount',
    };

    const testId = testIdMap[label.toLowerCase()];
    if (testId) {
      const dataValue = this.textExtractor.extractDataAttribute(html, testId);
      if (dataValue) {
        const amount = this.parseAmountFromString(dataValue);
        if (amount) return amount;
      }
    }

    // Window-based search as fallback
    const window = this.textExtractor.extractNearLabel(text, label, 100);
    if (window) {
      const amount = this.parseAmountFromString(window);
      if (amount) return amount;
    }

    return null;
  }

  /**
   * Parse monetary amount from a string
   */
  private parseAmountFromString(str: string): MonetaryAmount | null {
    const match = str.match(/(?<currency>CA\$|US\$|\$|€|£)\s*(?<amount>\d+(?:\.\d{2})?)/);
    if (match?.groups) {
      const amount = parseFloat(match.groups.amount);
      if (!isNaN(amount)) {
        const currencySymbol = match.groups.currency;
        return {
          amount,
          currency: CURRENCY_MAP[currencySymbol] || Currency.UNKNOWN,
          raw: match[0],
        };
      }
    }
    return null;
  }

  /**
   * Extract savings amount
   */
  private extractSavings(text: string): number | null {
    const match = text.match(PATTERNS.savings);
    if (match) {
      const amountStr = match[0].match(/\d+(?:\.\d{2})?/);
      if (amountStr) {
        return parseFloat(amountStr[0]);
      }
    }
    return null;
  }

  /**
   * Extract delivery address
   */
  private extractDeliveryAddress(text: string, html: string): string | null {
    // Try data attribute
    const dataAddr = this.textExtractor.extractDataAttribute(html, 'address_point_1_address');
    if (dataAddr) return dataAddr;

    // Try regex pattern
    const match = text.match(PATTERNS.deliveryAddress);
    if (match) {
      return decode(match[1]).trim();
    }

    return null;
  }

  /**
   * Extract payment method
   */
  private extractPaymentMethod(text: string, html: string): string | null {
    const match = text.match(PATTERNS.paymentCard);
    if (match) {
      return match[0];
    }
    return null;
  }

  /**
   * Determine primary currency from extracted values
   */
  private determineCurrency(...amounts: (MonetaryAmount | null)[]): Currency {
    for (const amount of amounts) {
      if (amount && amount.currency !== Currency.UNKNOWN) {
        return amount.currency;
      }
    }
    return Currency.UNKNOWN;
  }

  /**
   * Calculate extraction confidence score
   */
  private calculateConfidence(extracted: {
    hasTotal: boolean;
    hasMerchant: boolean;
    hasDate: boolean;
    hasSubtotal: boolean;
    hasTax: boolean;
  }): number {
    let score = 0;
    const weights = {
      hasTotal: 0.35,
      hasMerchant: 0.25,
      hasDate: 0.2,
      hasSubtotal: 0.1,
      hasTax: 0.1,
    };

    for (const [key, weight] of Object.entries(weights)) {
      if (extracted[key as keyof typeof extracted]) {
        score += weight;
      }
    }

    return Math.round(score * 100) / 100;
  }

  /**
   * Extract Uber orderId from email content
   */
  private extractOrderId(html: string, text: string, service: ServiceType): string | null {
    // Only try for Uber-related services
    if (
      service !== ServiceType.UBER_EATS &&
      service !== ServiceType.UBER_RIDE &&
      service !== ServiceType.UBER_OTHER
    ) {
      return null;
    }

    // 1) Strongest signal: explicit order_uuid or uuid query param
    const paramMatch = html.match(PATTERNS.orderUuidParam);
    if (paramMatch) {
      return paramMatch[1].toLowerCase();
    }

    // 2) Next: UUID embedded in an Uber URL
    const linkMatch = html.match(PATTERNS.uberLinkUuid);
    if (linkMatch) {
      return linkMatch[1].toLowerCase();
    }

    // 3) Fallback: first UUID in the HTML, but only if Uber-related
    // Note: We use the generic UUID pattern here but scoped to the UBER check above
    const genericMatch = html.match(PATTERNS.uuid);
    if (genericMatch) {
      return genericMatch[0].toLowerCase();
    }

    // 4) Last fallback: order number pattern (text based)
    const orderNum = text.match(/order\s*(number|no\.?)\s*[:#]\s*([A-Z0-9-]+)/i);
    if (orderNum) return orderNum[2].trim();

    return null;
  }
}
