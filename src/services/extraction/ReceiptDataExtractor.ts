/**
 * Receipt Data Extractor
 * 
 * Extracts structured receipt data from email HTML content
 */

import {
  ExtractedReceiptData,
  ServiceType,
  Currency,
  MonetaryAmount
} from './types';
import { HtmlTextExtractor } from './HtmlTextExtractor';
import { decode } from 'html-entities';

// Regex patterns for data extraction
const PATTERNS = {
  // Money patterns: CA$20.33, US$15.00, $30.87, €25.00, £18.50
  money: /(?<currency>CA\$|US\$|\$|€|£)\s*(?<amount>\d+(?:\.\d{2})?)/g,
  
  // Date patterns: November 15, 2022 | Nov 14, 2025 | 11/16/25
  dateWords: /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/gi,
  dateNumeric: /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g,
  
  // Time patterns: 8:17 PM, 9:56 AM, 10:14 am
  time: /\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|AM|PM)/gi,
  
  // Restaurant/merchant patterns
  orderFrom: /(?:order(?:ed)?\s+from|receipt\s+from|your\s+order\s+from)\s+([^,.]+)/gi,
  restaurantName: /Here's your receipt for ([^.]+)\./i,
  
  // Address patterns
  deliveryAddress: /(?:delivered?\s+to|delivery\s+to)[:\s]*([^<\n]+)/gi,
  
  // Payment method patterns  
  paymentCard: /(Visa|Mastercard|Amex|American Express|Discover)\s*[•·…\*]+\s*(\d{4})/gi,
  
  // Savings patterns
  savings: /(?:saved?|savings?)[:\s]*(?:CA\$|US\$|\$|€|£)?\s*(\d+(?:\.\d{2})?)/gi
};

// Currency symbol to enum mapping
const CURRENCY_MAP: Record<string, Currency> = {
  'CA$': Currency.CAD,
  'US$': Currency.USD,
  '$': Currency.USD, // Default $ to USD
  '€': Currency.EUR,
  '£': Currency.GBP
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
    from: string = ''
  ): ExtractedReceiptData {
    const plainText = this.textExtractor.htmlToText(htmlBody);
    const warnings: string[] = [];
    
    // Detect service type
    const service = this.detectService(subject, from, plainText);
    
    // Extract merchant/restaurant name
    const merchant = this.extractMerchant(htmlBody, plainText, subject);
    
    // Extract date and time
    const { orderDate, orderTime, parsedDate } = this.extractDateTime(plainText, htmlBody);
    
    // Extract monetary values
    const total = this.extractAmountNear('total', plainText, htmlBody);
    const subtotal = this.extractAmountNear('subtotal', plainText, htmlBody);
    const tax = this.extractAmountNear('tax', plainText, htmlBody);
    const tip = this.extractAmountNear('tip', plainText, htmlBody);
    const deliveryFee = this.extractAmountNear('delivery fee', plainText, htmlBody);
    const serviceFee = this.extractAmountNear('service fee', plainText, htmlBody);
    const savings = this.extractSavings(plainText);
    
    // Determine currency from extracted values
    const currency = this.determineCurrency(
      total, subtotal, tax, tip, deliveryFee, serviceFee
    );
    
    // Extract additional metadata
    const deliveryAddress = this.extractDeliveryAddress(plainText, htmlBody);
    const paymentMethod = this.extractPaymentMethod(plainText, htmlBody);
    
    // Calculate confidence based on extracted data
    const extractionConfidence = this.calculateConfidence({
      hasTotal: total !== null,
      hasMerchant: merchant !== null,
      hasDate: parsedDate !== null,
      hasSubtotal: subtotal !== null,
      hasTax: tax !== null
    });

    // Add warnings for missing data
    if (total === null) warnings.push('Could not extract total amount');
    if (merchant === null) warnings.push('Could not extract merchant name');
    if (parsedDate === null) warnings.push('Could not extract order date');

    return {
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
      warnings
    };
  }

  /**
   * Detect service type from email content
   */
  private detectService(subject: string, from: string, text: string): ServiceType {
    const combined = `${subject} ${from} ${text}`.toLowerCase();

    if (combined.includes('uber eats') || combined.includes('ubereats')) {
      return ServiceType.UBER_EATS;
    }
    if (combined.includes('uber trip') || combined.includes('ride with uber')) {
      return ServiceType.UBER_RIDE;
    }
    if (combined.includes('uber')) {
      // Check context - if it mentions food/restaurant, it's likely Uber Eats
      if (combined.includes('order') || combined.includes('delivery') || 
          combined.includes('restaurant') || combined.includes('food')) {
        return ServiceType.UBER_EATS;
      }
      return ServiceType.UBER_OTHER;
    }
    if (combined.includes('doordash')) {
      return ServiceType.DOORDASH;
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
  private extractMerchant(
    html: string,
    text: string,
    subject: string
  ): string | null {
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
    return decode(name)
      .replace(/\s+/g, ' ')
      .replace(/[<>]/g, '')
      .trim();
  }

  /**
   * Extract date and time from email
   */
  private extractDateTime(text: string, html: string): {
    orderDate: string | null;
    orderTime: string | null;
    parsedDate: Date | null;
  } {
    let orderDate: string | null = null;
    let orderTime: string | null = null;
    let parsedDate: Date | null = null;

    // Try word-based dates first (more reliable parsing)
    const wordDateMatch = text.match(PATTERNS.dateWords);
    if (wordDateMatch) {
      orderDate = wordDateMatch[0];
      parsedDate = new Date(orderDate);
      if (isNaN(parsedDate.getTime())) {
        parsedDate = null;
      }
    }

    // Try numeric dates if no word date found
    if (!orderDate) {
      const numericMatch = PATTERNS.dateNumeric.exec(text);
      if (numericMatch) {
        orderDate = numericMatch[0];
        // Parse MM/DD/YY format
        const [, month, day, year] = numericMatch;
        const fullYear = year.length === 2 ? `20${year}` : year;
        parsedDate = new Date(parseInt(fullYear), parseInt(month) - 1, parseInt(day));
        if (isNaN(parsedDate.getTime())) {
          parsedDate = null;
        }
      }
    }

    // Extract time
    const timeMatch = text.match(PATTERNS.time);
    if (timeMatch) {
      orderTime = timeMatch[0];
      
      // If we have both date and time, combine them
      if (parsedDate && orderTime) {
        const timeParts = orderTime.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|AM|PM)/i);
        if (timeParts) {
          let hours = parseInt(timeParts[1]);
          const minutes = parseInt(timeParts[2]);
          const isPM = /p\.?m\.?/i.test(timeParts[3]);
          
          if (isPM && hours !== 12) hours += 12;
          if (!isPM && hours === 12) hours = 0;
          
          parsedDate.setHours(hours, minutes, 0, 0);
        }
      }
    }

    return { orderDate, orderTime, parsedDate };
  }

  /**
   * Extract monetary amount near a label
   */
  private extractAmountNear(
    label: string,
    text: string,
    html: string
  ): MonetaryAmount | null {
    // Build regex to find label followed by amount
    const labelPattern = new RegExp(
      `${label}[:\\s]*(?<currency>CA\\$|US\\$|\\$|€|£)?\\s*(?<amount>\\d+(?:\\.\\d{2})?)`,
      'gi'
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
          raw: textMatch[0]
        };
      }
    }

    // Try HTML data attributes for Uber emails
    const testIdMap: Record<string, string> = {
      'total': 'total_fare_amount',
      'subtotal': 'subtotal_amount',
      'tax': 'tax_amount',
      'tip': 'tip_amount'
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
          raw: match[0]
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
    const dataAddr = this.textExtractor.extractDataAttribute(
      html, 
      'address_point_1_address'
    );
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
      hasDate: 0.20,
      hasSubtotal: 0.10,
      hasTax: 0.10
    };

    for (const [key, weight] of Object.entries(weights)) {
      if (extracted[key as keyof typeof extracted]) {
        score += weight;
      }
    }

    return Math.round(score * 100) / 100;
  }
}

