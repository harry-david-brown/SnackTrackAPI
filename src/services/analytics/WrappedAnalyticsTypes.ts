/**
 * Wrapped Analytics Types
 * Spotify Wrapped-style shareable analytics
 */

// Shame-Based Analytics

export interface LateNightOrders {
  count: number;
  totalSpent: number;
  latestOrder: string; // "4:37 AM"
  worstOffender?: {
    restaurant: string;
    time: string;
    amount: number;
    items: string[];
  };
}

export interface LaziestDay {
  date: string; // "2025-07-14"
  dayOfWeek: string;
  orderCount: number;
  totalSpent: number;
  restaurants: string[];
  message: string;
}

export interface LongestStreak {
  days: number;
  startDate: string;
  endDate: string;
  totalSpent: number;
  message: string;
}

export interface SingleItemOrders {
  count: number;
  totalSpent: number;
  averageAmount: number;
  message: string;
  mostCommon: string; // "Coffee (87 times)"
}

export interface ChainDependency {
  worstOffender: string;
  orderCount: number;
  totalSpent: number;
  percentage: number;
  message: string;
  allChains: Array<{
    name: string;
    count: number;
    spent: number;
  }>;
}

// Flex-Worthy Analytics

export interface MostExpensiveOrder {
  amount: number;
  restaurant: string;
  date: string;
  items: Array<{
    name: string;
    price: number;
  }>;
  message: string;
}

export interface CoffeeAddiction {
  orderCount: number;
  totalSpent: number;
  averagePrice: number;
  mostOrdered: string; // "Iced Caramel Macchiato (23 times)"
  message: string;
  disclaimer?: string;
}

export interface NightOwl {
  percentage: number;
  count: number;
  totalSpent: number;
  latestOrder: string;
  message: string;
}

// Comparative Analytics

export interface SpentThisYear {
  totalSpent: number;
  year: number;
  orderCount: number;
  averagePerOrder: number;
  message: string;
}

export interface CouldHaveBought {
  totalSpent: number;
  comparisons: Array<{
    item: string;
    quantity: number;
    message: string;
  }>;
}

export interface MissedInvestment {
  amountSpent: number;
  firstOrderDate: string;
  daysElapsed: number;
  sp500Return: number;
  wouldBeWorth: number;
  missedGains: number;
  message: string;
}

export interface CostPerMeal {
  totalDeliveryFees: number; // Sum of all delivery fees
  averageDeliveryFee: number; // Average fee per order
  averageDeliveryFeePerMeal: number; // Average fee per meal (if applicable)
  totalOrders: number; // Number of orders used in calculation
  message: string;
}

export interface FeePeriod {
  quarter: string;
  orderCount: number;
  averageDeliveryFee: number;
  averageServiceFee: number;
  averageCompanyFees: number;
}

export interface DeliveryFeeTrend {
  currency: string;
  coveredOrderCount: number;
  coverageStart: string;
  coverageEnd: string;
  earliestPeriod: FeePeriod;
  latestPeriod: FeePeriod;
  deliveryFeeChangePercent: number;
  companyFeeChangePercent: number;
  trend: 'increased' | 'decreased' | 'flat';
  series: FeePeriod[];
}

// Pattern-Based Analytics

export interface PeakHungerHour {
  hour: number;
  hourDisplay: string; // "7:00 PM"
  orderCount: number;
  percentageOfTotal: number;
  message: string;
}

export interface WeekendWarrior {
  weekendOrders: number;
  weekdayOrders: number;
  weekendSpending: number;
  weekdaySpending: number;
  ratio: number;
  message: string;
}

export interface DeliveryWaits {
  totalMinutes: number; // Total time spent waiting across all orders
  averageMinutes: number; // Average wait time per order
  totalOrders: number; // Number of orders with valid wait times
  longestWait?: {
    minutes: number;
    restaurant: string;
    amount: number;
    message: string;
  };
  fastestDelivery?: {
    minutes: number;
    restaurant: string;
  };
}

// Community Percentiles

export interface PercentileStanding {
  /** Share of ranked users strictly below this user, 0–100. */
  percentile: number;
  /** "Top X%" framing: 100 − percentile, clamped to [1, 100]. */
  topPercent: number;
}

export interface WrappedPercentiles {
  /** Users in the comparison pool (only accounts with enough receipts rank). */
  sampleSize: number;
  totalSpent?: PercentileStanding;
  orderCount?: PercentileStanding;
  nightOwl?: PercentileStanding;
}

export interface WrappedCoverage {
  /** Number of imported receipts represented by this Wrapped payload. */
  orderCount: number;
  /** Earliest known order in SnackTrack; null when no dated receipt exists. */
  earliestOrderDate: string | null;
  /** Latest known order in SnackTrack; null when no dated receipt exists. */
  latestOrderDate: string | null;
  /** Imported sources represented in the payload (for example email or csv). */
  dataSources: string[];
  /** True when at least one uploaded CSV/ZIP export contributed receipts. */
  hasExportData: boolean;
}

// Main Wrapped Analytics Response

export interface WrappedAnalytics {
  /** What SnackTrack actually reviewed; never implies exhaustive history. */
  coverage: WrappedCoverage;
  /** Cross-user standings; omitted when the pool is too small to be meaningful. */
  percentiles?: WrappedPercentiles;
  shame: {
    lateNightOrders?: LateNightOrders;
    laziestDay?: LaziestDay;
    longestStreak?: LongestStreak;
    singleItemOrders?: SingleItemOrders;
    chainDependency?: ChainDependency;
  };
  flex: {
    mostExpensiveOrder?: MostExpensiveOrder;
    coffeeAddiction?: CoffeeAddiction;
    nightOwl?: NightOwl;
  };
  comparative: {
    spentThisYear?: SpentThisYear;
    couldHaveBought?: CouldHaveBought;
    missedInvestment?: MissedInvestment;
    costPerMeal?: CostPerMeal;
    deliveryFeeTrend?: DeliveryFeeTrend;
  };
  patterns: {
    peakHungerHour?: PeakHungerHour;
    weekendWarrior?: WeekendWarrior;
    deliveryWaits?: DeliveryWaits;
  };
}

// Receipt with database fields for analytics
export interface ReceiptForAnalytics {
  id: string;
  userId: string;
  restaurantName: string | null;
  orderDate: Date | null;
  amountSpent: number;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
  }>;
  receiptType: string;
  dataSource: string;
  /** Optional until receipt currency is persisted for every historical source. */
  currency?: 'CAD' | 'USD' | 'EUR' | 'GBP' | 'UNKNOWN';
  deliveryTime?: Date | null; // Delivery time (for DoorDash wait time analytics)
  currencyCode?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  tip?: number | null;
  deliveryFee?: number | null;
  serviceFee?: number | null;
  savings?: number | null;
}
