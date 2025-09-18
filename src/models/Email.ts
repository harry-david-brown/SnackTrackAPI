import { Receipt, ReceiptType, ReceiptItem } from './Receipt';

export class Email {
  constructor(
    public userId: string,
    public from: string,
    public to: string,
    public body: string,
    public subject?: string
  ) {}

  toReceipt(): Receipt {
    const body = this.body.toLowerCase();
    const subject = this.subject?.toLowerCase() || '';
    
    // Detect receipt type
    const receiptType = this.detectReceiptType(this.from, subject, body);
    
    // Parse based on receipt type
    switch (receiptType) {
      case ReceiptType.UBER_EATS:
        return this.parseUberEatsReceipt();
      case ReceiptType.DOORDASH:
        return this.parseDoorDashReceipt();
      default:
        return this.parseGenericReceipt();
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

  private parseUberEatsReceipt(): Receipt {
    const body = this.body;
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
    const totalMatch = body.match(/total[:\s]*\$?(\d+\.?\d*)/i);
    if (totalMatch) {
      totalAmount = parseFloat(totalMatch[1]);
    }

    // Extract subtotal
    const subtotalMatch = body.match(/subtotal[:\s]*\$?(\d+\.?\d*)/i);
    if (subtotalMatch) {
      subtotal = parseFloat(subtotalMatch[1]);
    }

    // Extract tax
    const taxMatch = body.match(/tax[:\s]*\$?(\d+\.?\d*)/i);
    if (taxMatch) {
      tax = parseFloat(taxMatch[1]);
    }

    // Extract tip
    const tipMatch = body.match(/tip[:\s]*\$?(\d+\.?\d*)/i);
    if (tipMatch) {
      tip = parseFloat(tipMatch[1]);
    }

    // Extract delivery fee
    const deliveryMatch = body.match(/delivery[:\s]*\$?(\d+\.?\d*)/i);
    if (deliveryMatch) {
      deliveryFee = parseFloat(deliveryMatch[1]);
    }

    // Extract service fee
    const serviceMatch = body.match(/service[:\s]*\$?(\d+\.?\d*)/i);
    if (serviceMatch) {
      serviceFee = parseFloat(serviceMatch[1]);
    }

    // Extract items (look for item patterns)
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
      this.userId,
      items,
      totalAmount,
      ReceiptType.UBER_EATS,
      restaurantName,
      orderDate,
      this.from,
      this.to,
      this.subject,
      this.body,
      subtotal,
      tax,
      tip,
      deliveryFee,
      serviceFee
    );
  }

  private parseDoorDashReceipt(): Receipt {
    // Similar parsing logic for DoorDash
    return this.parseGenericReceipt();
  }

  private parseGenericReceipt(): Receipt {
    // Fallback parsing for unknown receipt types
    const body = this.body.toLowerCase();
    const items: ReceiptItem[] = [];
    let totalAmount = 0;

    // Extract total amount
    const totalMatch = this.body.match(/\$(\d+\.?\d*)/g);
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
      this.userId,
      items,
      totalAmount,
      ReceiptType.UNKNOWN,
      undefined,
      undefined,
      this.from,
      this.to,
      this.subject,
      this.body
    );
  }
} 