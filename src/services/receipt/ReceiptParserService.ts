import { Receipt, ReceiptType, ReceiptItem } from '../../models/Receipt';
import { Email } from '../../models/Email';

/**
 * Service responsible for parsing emails into receipts
 * Separated from Email class to follow single responsibility principle
 */
export class ReceiptParserService {
  
  /**
   * Parse an email into a receipt
   */
  parseEmailToReceipt(email: Email): Receipt | null {
    // Only convert to receipt if it's actually a receipt
    if (!email.isReceipt()) {
      return null;
    }
    
    const body = email.body.toLowerCase();
    const subject = email.subject?.toLowerCase() || '';
    
    // Detect receipt type
    const receiptType = this.detectReceiptType(email.from, subject, body);
    
    // Parse based on receipt type
    switch (receiptType) {
      case ReceiptType.UBER_EATS:
        return this.parseUberEatsReceipt(email);
      case ReceiptType.DOORDASH:
        return this.parseDoorDashReceipt(email);
      default:
        return this.parseGenericReceipt(email);
    }
  }

  private detectReceiptType(from: string, subject: string, body: string): ReceiptType {
    const fromLower = from.toLowerCase();
    const combined = `${fromLower} ${subject} ${body}`;

    if (combined.includes('uber') || combined.includes('ubereats')) {
      return ReceiptType.UBER_EATS;
    }
    if (combined.includes('doordash')) {
      return ReceiptType.DOORDASH;
    }
    if (combined.includes('grubhub')) {
      return ReceiptType.GRUBHUB;
    }
    if (combined.includes('postmates')) {
      return ReceiptType.POSTMATES;
    }
    if (combined.includes('caviar')) {
      return ReceiptType.CAVIAR;
    }
    
    return ReceiptType.UNKNOWN;
  }

  private parseUberEatsReceipt(email: Email): Receipt {
    const body = email.body;
    const items: ReceiptItem[] = [];
    let totalAmount = 0;
    let restaurantName = '';
    let orderDate: Date | undefined;
    let subtotal = 0;
    let tax = 0;
    let tip = 0;
    let deliveryFee = 0;
    let serviceFee = 0;

    // Extract restaurant name
    const restaurantMatch = body.match(/from\s+([^,\n]+)/i) || body.match(/at\s+([^,\n]+)/i);
    if (restaurantMatch) {
      restaurantName = restaurantMatch[1].trim();
    }

    // Extract order date
    const dateMatch = body.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      orderDate = new Date(dateMatch[1]);
    }

    // Extract total amount (look for "Total" or "Order Total")
    // Handle various currency formats: $30.87, CA$30.87, Total $30.87, Total CA$30.87
    const totalMatch = body.match(/total[:\s]*(?:[A-Z]{2}\$)?\$?(\d+\.?\d*)/i);
    if (totalMatch) {
      totalAmount = parseFloat(totalMatch[1]);
    }

    // Extract subtotal
    const subtotalMatch = body.match(/subtotal[:\s]*(?:[A-Z]{2}\$)?\$?(\d+\.?\d*)/i);
    if (subtotalMatch) {
      subtotal = parseFloat(subtotalMatch[1]);
    }

    // Extract tax
    const taxMatch = body.match(/tax[:\s]*(?:[A-Z]{2}\$)?\$?(\d+\.?\d*)/i);
    if (taxMatch) {
      tax = parseFloat(taxMatch[1]);
    }

    // Extract tip
    const tipMatch = body.match(/tip[:\s]*(?:[A-Z]{2}\$)?\$?(\d+\.?\d*)/i);
    if (tipMatch) {
      tip = parseFloat(tipMatch[1]);
    }

    // Extract delivery fee
    const deliveryMatch = body.match(/delivery[:\s]*(?:[A-Z]{2}\$)?\$?(\d+\.?\d*)/i);
    if (deliveryMatch) {
      deliveryFee = parseFloat(deliveryMatch[1]);
    }

    // Extract service fee
    const serviceMatch = body.match(/service[:\s]*(?:[A-Z]{2}\$)?\$?(\d+\.?\d*)/i);
    if (serviceMatch) {
      serviceFee = parseFloat(serviceMatch[1]);
    }

    // Extract items (look for item patterns) - but skip for forwarded emails to avoid parsing HTML/URLs
    if (!body.includes('---------- Forwarded message ---------')) {
      const itemMatches = body.match(/(\d+)\s*x\s*([^$]+)\s*\$?(\d+\.?\d*)/gi);
      if (itemMatches) {
        for (const match of itemMatches) {
          const parts = match.match(/(\d+)\s*x\s*([^$]+)\s*\$?(\d+\.?\d*)/i);
          if (parts) {
            items.push({
              name: parts[2].trim(),
              quantity: parseInt(parts[1]),
              price: parseFloat(parts[3])
            });
          }
        }
      }
    }

    // If no structured items found, try to extract from common patterns
    if (items.length === 0) {
      const commonItems = ['latte', 'muffin', 'burger', 'fries', 'burrito', 'chips', 'coffee', 'sandwich', 'pizza', 'salad'];
      for (const item of commonItems) {
        if (body.includes(item)) {
          items.push({
            name: item,
            quantity: 1,
            price: 0 // We don't have individual prices
          });
        }
      }
    }

    return new Receipt(
      email.userId,
      items,
      totalAmount,
      ReceiptType.UBER_EATS,
      restaurantName,
      orderDate,
      email.from,
      email.to,
      email.subject,
      email.body,
      subtotal,
      tax,
      tip,
      deliveryFee,
      serviceFee
    );
  }

  private parseDoorDashReceipt(email: Email): Receipt {
    // Similar parsing logic for DoorDash
    return this.parseGenericReceipt(email);
  }

  private parseGenericReceipt(email: Email): Receipt {
    // Fallback parsing for unknown receipt types
    const body = email.body.toLowerCase();
    const items: ReceiptItem[] = [];
    let totalAmount = 0;

    // Extract total amount
    const totalMatch = email.body.match(/\$(\d+\.?\d*)/g);
    if (totalMatch && totalMatch.length > 0) {
      const lastAmount = totalMatch[totalMatch.length - 1];
      totalAmount = parseFloat(lastAmount.replace('$', ''));
    }

    // Extract basic items
    const commonItems = ['latte', 'muffin', 'burger', 'fries', 'burrito', 'chips', 'coffee', 'sandwich'];
    for (const item of commonItems) {
      if (body.includes(item)) {
        items.push({
          name: item,
          quantity: 1,
          price: 0
        });
      }
    }

    return new Receipt(
      email.userId,
      items,
      totalAmount,
      ReceiptType.UNKNOWN,
      undefined,
      undefined,
      email.from,
      email.to,
      email.subject,
      email.body
    );
  }
}
