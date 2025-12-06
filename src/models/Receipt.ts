export enum ReceiptType {
  UBER_EATS = 'uber_eats',
  DOORDASH = 'doordash',
  GRUBHUB = 'grubhub',
  POSTMATES = 'postmates',
  CAVIAR = 'caviar',
  UNKNOWN = 'unknown'
}

export enum DataSource {
  CSV = 'csv',
  EMAIL = 'email',
  API = 'api'
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  category?: string;
}

/**
 * Streamlined Receipt model - development focused
 * Only essential fields for MVP
 */
export class Receipt {
  constructor(
    public userId: string,
    public items: ReceiptItem[],
    public amountSpent: number,
    public receiptType: ReceiptType,
    public restaurantName?: string,
    public orderDate?: Date,
    // Data source tracking
    public dataSource: DataSource = DataSource.CSV,
    // Delivery time for DoorDash (time when order was delivered)
    public deliveryTime?: Date,
    // External Provider ID (e.g. Uber Order UUID) for deduplication
    public externalId?: string
  ) { }

  // Helper method to get total items count
  getTotalItems(): number {
    return this.items.reduce((total, item) => total + item.quantity, 0);
  }

  // Helper method to get items by category
  getItemsByCategory(category: string): ReceiptItem[] {
    return this.items.filter(item => item.category === category);
  }

  // Helper method to check if this is an email-based receipt
  isEmailBased(): boolean {
    return this.dataSource === DataSource.EMAIL;
  }

  // Helper method to check if this is a CSV-based receipt
  isCsvBased(): boolean {
    return this.dataSource === DataSource.CSV;
  }

  // Helper method to get clean receipt data for API responses
  toApiResponse() {
    return {
      id: (this as any).id, // Will be set by database
      userId: this.userId,
      items: this.items,
      amountSpent: this.amountSpent,
      receiptType: this.receiptType,
      restaurantName: this.restaurantName,
      orderDate: this.orderDate,
      dataSource: this.dataSource,
      deliveryTime: this.deliveryTime,
      externalId: (this as any).externalId
    };
  }
}