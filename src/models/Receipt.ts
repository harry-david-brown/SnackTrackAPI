export enum ReceiptType {
  UBER_EATS = 'uber_eats',
  DOORDASH = 'doordash',
  GRUBHUB = 'grubhub',
  POSTMATES = 'postmates',
  CAVIAR = 'caviar',
  UNKNOWN = 'unknown'
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  category?: string;
}

export class Receipt {
  constructor(
    public userId: string,
    public items: ReceiptItem[],
    public amountSpent: number,
    public receiptType: ReceiptType,
    public restaurantName?: string,
    public orderDate?: Date,
    public emailFrom?: string,
    public emailTo?: string,
    public emailSubject?: string,
    public emailBody?: string,
    public subtotal?: number,
    public tax?: number,
    public tip?: number,
    public deliveryFee?: number,
    public serviceFee?: number
  ) {}

  // Helper method to get total items count
  getTotalItems(): number {
    return this.items.reduce((total, item) => total + item.quantity, 0);
  }

  // Helper method to get items by category
  getItemsByCategory(category: string): ReceiptItem[] {
    return this.items.filter(item => item.category === category);
  }

  // Helper method to get spending breakdown
  getSpendingBreakdown() {
    return {
      subtotal: this.subtotal || 0,
      tax: this.tax || 0,
      tip: this.tip || 0,
      deliveryFee: this.deliveryFee || 0,
      serviceFee: this.serviceFee || 0,
      total: this.amountSpent
    };
  }
} 