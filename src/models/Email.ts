import { Receipt } from './Receipt';

export class Email {
  constructor(
    public userId: string,
    public from: string,
    public to: string,
    public body: string
  ) {}

  toReceipt(): Receipt {
    // Basic parsing logic for testing
    const body = this.body.toLowerCase();
    const items: string[] = [];
    let totalAmount = 0;

    // Extract total amount (look for $X.XX pattern)
    const totalMatch = this.body.match(/\$(\d+\.?\d*)/g);
    if (totalMatch && totalMatch.length > 0) {
      // Use the last (usually largest) amount found
      const lastAmount = totalMatch[totalMatch.length - 1];
      totalAmount = parseFloat(lastAmount.replace('$', ''));
    }

    // Extract items (look for "Items:" or similar patterns)
    const itemsMatch = this.body.match(/items?[:\s]+(.*?)(?:\n|$)/i);
    if (itemsMatch) {
      const itemsText = itemsMatch[1];
      // Split by common separators
      const itemList = itemsText.split(/[,;]/).map(item => item.trim()).filter(item => item.length > 0);
      items.push(...itemList);
    }

    // If no items found, try to extract from common patterns
    if (items.length === 0) {
      const commonItems = ['latte', 'muffin', 'burger', 'fries', 'burrito', 'chips', 'coffee', 'sandwich'];
      for (const item of commonItems) {
        if (body.includes(item)) {
          items.push(item);
        }
      }
    }

    return new Receipt(this.userId, items, totalAmount);
  }
} 