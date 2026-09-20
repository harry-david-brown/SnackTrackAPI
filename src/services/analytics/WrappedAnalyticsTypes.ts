import type { HistoricalInvestmentResult } from './shared/historicalInvestment';
/**
 * Wrapped Analytics Types
 * Spotify Wrapped-style shareable analytics
 */

import type { ItemEvidence, ReceiptResolution } from '../../models/ReceiptResolution';
import type { OrderMetrics, DeliveryDayRanking, CurrencyOrderMetrics } from './shared/orderMetrics';

export interface WrappedSpending {
  /** Null when a single total would hide unknown prices or combine currencies. */
  totalSpent: number | null;
  /** Policy-3 net costs for exactly the story's cohort, including wallet payments. */
  spending?: CurrencyOrderMetrics[];
}

// Shame-Based Analytics

export interface LateNightOrders extends WrappedSpending {
  count: number;
  latestOrder: string; // "4:37 AM"
  worstOffender?: {
    restaurant: string;
    time: string;
    amount: number;
    items: string[];
  };
}

export interface LaziestDay extends WrappedSpending {
  date: string; // "2025-07-14"
  dayOfWeek: string;
  orderCount: number;
  restaurants: string[];
  message: string;
}

export interface LongestStreak extends WrappedSpending {
  days: number;
  startDate: string;
  endDate: string;
  message: string;
}

export interface SingleItemOrders extends WrappedSpending {
  count: number;
  averageAmount: number;
  message: string;
  mostCommon: string; // "Coffee (87 times)"
}

export interface ChainDependency extends WrappedSpending {
  worstOffender: string;
  orderCount: number;
  percentage: number;
  message: string;
  allChains: Array<{
    name: string;
    count: number;
    spent: number | null;
    spending?: CurrencyOrderMetrics[];
  }>;
}

// Flex-Worthy Analytics

export interface MostExpensiveOrder {
  amount: number;
  currencyCode?: string;
  includesEstimates?: boolean;
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
  /** Policy 3 does not allocate basket discounts/refunds to individual items. */
  totalSpent: number | null;
  averagePrice: number | null;
  mostOrdered: string; // "Iced Caramel Macchiato (23 times)"
  message: string;
  disclaimer?: string;
}

export interface NightOwl extends WrappedSpending {
  percentage: number;
  count: number;
  latestOrder: string;
  message: string;
}

// Comparative Analytics

export interface SpentThisYear extends WrappedSpending {
  year: number;
  orderCount: number;
  averagePerOrder: number | null;
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
  basis?: 'unadjusted_deliveries';
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
  weekendSpending: number | null;
  weekdaySpending: number | null;
  weekendCosts?: CurrencyOrderMetrics[];
  weekdayCosts?: CurrencyOrderMetrics[];
  ratio: number | null;
  ratioBasis?: 'deliveries_per_day';
  message: string;
}

export interface DeliveryWaits {
  totalMinutes: number; // Total time spent waiting across all orders
  averageMinutes: number; // Average wait time per order
  totalOrders: number; // Number of orders with valid wait times
  longestWait?: {
    minutes: number;
    restaurant: string;
    amount: number | null;
    currencyCode?: string;
    message: string;
  };
  fastestDelivery?: {
    minutes: number;
    restaurant: string;
  };
}

// Community Percentiles

export interface PercentileStanding {
  /** Policy-3 metrics have independent eligible comparison populations. */
  sampleSize?: number;
  /** Share of ranked users strictly below this user, 0–100. */
  percentile: number;
  /** "Top X%" framing: 100 − percentile, clamped to [1, 100]. */
  topPercent: number;
}

export interface WrappedPercentiles {
  /** Omitted for the legacy all-receipt comparison cohort. */
  policyVersion?: 3;
  /** Users in the comparison pool (only accounts with enough receipts rank). */
  sampleSize: number;
  currencyCode?: string;
  methodology?: string;
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
  recap?: import('./shared/recapStories').RecapStoryCollection;
  /** Reject pre-evidence behavior projections in the shared Summary cache. */
  behaviorPolicyVersion?: 1;
  orderMetrics?: OrderMetrics;
  deliveryDayRanking?: DeliveryDayRanking;
  currencyCode?: string;
  totalsByCurrency?: Record<string, { total: number; count: number }>;
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
    historicalInvestment?: HistoricalInvestmentResult;
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
  resolution?: ReceiptResolution;
  timezone?: string;
  id: string;
  userId: string;
  restaurantName: string | null;
  orderDate: Date | null;
  amountSpent: number;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
    customizations?: string[];
    evidence?: ItemEvidence;
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
