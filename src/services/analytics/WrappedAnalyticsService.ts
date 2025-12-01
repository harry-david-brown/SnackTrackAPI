import { Pool } from 'pg';
import {
  WrappedAnalytics,
  ReceiptForAnalytics,
  LateNightOrders,
  LaziestDay,
  LongestStreak,
  SingleItemOrders,
  ChainDependency,
  MostExpensiveOrder,
  CoffeeAddiction,
  NightOwl,
  SpentThisYear,
  CouldHaveBought,
  MissedInvestment,
  CostPerMeal,
  PeakHungerHour,
  WeekendWarrior,
  DeliveryWaits
} from './WrappedAnalyticsTypes';
import { getLocalDate, getLocalHour, getLocalDay } from '../../utils/timezone';

/**
 * Wrapped Analytics Service
 * Calculates Spotify Wrapped-style analytics for maximum shareability
 */
export class WrappedAnalyticsService {
  constructor(private pool: Pool) {}

  /**
   * Calculate all wrapped analytics for a user
   */
  async calculateWrappedAnalytics(userId: string): Promise<WrappedAnalytics> {
    // Fetch user timezone (default to 'America/New_York' if not set)
    const userTimezone = await this.fetchUserTimezone(userId);
    
    // Fetch all receipts for the user
    const receipts = await this.fetchUserReceipts(userId);

    // Return empty if no data
    if (receipts.length === 0) {
      return this.getEmptyAnalytics();
    }

    // Calculate all analytics categories
    const [
      lateNightOrders,
      laziestDay,
      longestStreak,
      singleItemOrders,
      chainDependency,
      mostExpensiveOrder,
      coffeeAddiction,
      nightOwl,
      spentThisYear,
      couldHaveBought,
      missedInvestment,
      costPerMeal,
      peakHungerHour,
      weekendWarrior,
      deliveryWaits
    ] = await Promise.all([
      // Shame analytics
      this.calculateLateNightOrders(receipts, userTimezone),
      this.calculateLaziestDay(receipts, userTimezone),
      this.calculateLongestStreak(receipts, userTimezone),
      this.calculateSingleItemOrders(receipts),
      this.calculateChainDependency(receipts),
      
      // Flex analytics
      this.calculateMostExpensiveOrder(receipts),
      this.calculateCoffeeAddiction(receipts),
      this.calculateNightOwl(receipts, userTimezone),
      
      // Comparative analytics
      this.calculateSpentThisYear(receipts, userTimezone),
      this.calculateCouldHaveBought(receipts),
      this.calculateMissedInvestment(receipts),
      this.calculateCostPerMeal(receipts),
      
      // Pattern analytics
      this.calculatePeakHungerHour(receipts, userTimezone),
      this.calculateWeekendWarrior(receipts, userTimezone),
      this.calculateDeliveryWaits(receipts)
    ]);

    return {
      shame: {
        lateNightOrders,
        laziestDay,
        longestStreak,
        singleItemOrders,
        chainDependency
      },
      flex: {
        mostExpensiveOrder,
        coffeeAddiction,
        nightOwl
      },
      comparative: {
        spentThisYear,
        couldHaveBought,
        missedInvestment,
        costPerMeal
      },
      patterns: {
        peakHungerHour,
        weekendWarrior,
        deliveryWaits
      }
    };
  }

  /**
   * Fetch user timezone from database
   */
  private async fetchUserTimezone(userId: string): Promise<string> {
    const query = `SELECT timezone FROM users WHERE id = $1`;
    const result = await this.pool.query(query, [userId]);
    return result.rows[0]?.timezone || 'America/New_York';
  }

  /**
   * Fetch all receipts for analytics
   */
  private async fetchUserReceipts(userId: string): Promise<ReceiptForAnalytics[]> {
    const query = `
      SELECT 
        id,
        user_id as "userId",
        restaurant_name as "restaurantName",
        order_date as "orderDate",
        amount_spent as "amountSpent",
        items,
        receipt_type as "receiptType",
        data_source as "dataSource",
        delivery_time as "deliveryTime"
      FROM receipts
      WHERE user_id = $1
      ORDER BY order_date DESC
    `;

    const result = await this.pool.query(query, [userId]);
    return result.rows.map(row => ({
      ...row,
      amountSpent: parseFloat(row.amountSpent),
      orderDate: row.orderDate ? new Date(row.orderDate) : null,
      deliveryTime: row.deliveryTime ? new Date(row.deliveryTime) : null,
      items: Array.isArray(row.items) ? row.items : []
    }));
  }

  /**
   * Calculate 3am Regret Orders
   * Orders placed between midnight and 6am (in user's local timezone)
   */
  private async calculateLateNightOrders(receipts: ReceiptForAnalytics[], timezone: string): Promise<LateNightOrders | undefined> {
    const lateNightReceipts = receipts.filter(r => {
      if (!r.orderDate) return false;
      const hour = getLocalHour(r.orderDate, timezone);
      return hour !== null && hour >= 0 && hour < 6;
    });

    if (lateNightReceipts.length === 0) return undefined;

    const totalSpent = lateNightReceipts.reduce((sum, r) => sum + r.amountSpent, 0);
    
    // Find latest order (by hour in user's timezone)
    const latest = lateNightReceipts.reduce((latest, r) => {
      if (!r.orderDate) return latest;
      if (!latest.orderDate) return r;
      const rHour = getLocalHour(r.orderDate, timezone) || 0;
      const latestHour = getLocalHour(latest.orderDate, timezone) || 0;
      return rHour > latestHour ? r : latest;
    }, lateNightReceipts[0]);

    // Find worst offender (most expensive late night order)
    const worstOffender = lateNightReceipts.reduce((worst, r) => 
      r.amountSpent > worst.amountSpent ? r : worst
    , lateNightReceipts[0]);

    // Format times in user's local timezone
    const formatLocalTime = (date: Date) => {
      const localDate = getLocalDate(date, timezone);
      return localDate ? this.formatTime(localDate) : 'Unknown';
    };

    return {
      count: lateNightReceipts.length,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      latestOrder: latest.orderDate ? formatLocalTime(latest.orderDate) : 'Unknown',
      worstOffender: worstOffender.orderDate ? {
        restaurant: worstOffender.restaurantName || 'Unknown',
        time: formatLocalTime(worstOffender.orderDate),
        amount: worstOffender.amountSpent,
        items: worstOffender.items.map(i => i.name)
      } : undefined
    };
  }

  /**
   * Calculate Laziest Day
   * Day with most orders (using user's local timezone)
   */
  private async calculateLaziestDay(receipts: ReceiptForAnalytics[], timezone: string): Promise<LaziestDay | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Group by date in user's local timezone
    const dayGroups = new Map<string, ReceiptForAnalytics[]>();
    validReceipts.forEach(r => {
      if (!r.orderDate) return;
      // Get the date string in user's timezone (YYYY-MM-DD)
      const localDate = getLocalDate(r.orderDate, timezone);
      if (!localDate) return;
      const dateKey = localDate.toISOString().split('T')[0];
      if (!dayGroups.has(dateKey)) {
        dayGroups.set(dateKey, []);
      }
      dayGroups.get(dateKey)!.push(r);
    });

    // Find day with most orders
    let laziestDate = '';
    let laziestReceipts: ReceiptForAnalytics[] = [];
    let maxOrders = 0;

    dayGroups.forEach((receipts, date) => {
      if (receipts.length > maxOrders) {
        maxOrders = receipts.length;
        laziestDate = date;
        laziestReceipts = receipts;
      }
    });

    if (maxOrders < 3) return undefined; // Only show if 3+ orders

    const totalSpent = laziestReceipts.reduce((sum: number, r: ReceiptForAnalytics) => sum + r.amountSpent, 0);
    const dayOfWeek = this.getDayOfWeek(new Date(laziestDate));

    return {
      date: laziestDate,
      dayOfWeek,
      orderCount: laziestReceipts.length,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      restaurants: laziestReceipts.map((r: ReceiptForAnalytics) => r.restaurantName || 'Unknown'),
      message: `${laziestReceipts.length} orders in one day? Go outside.`
    };
  }

  /**
   * Calculate Longest Streak
   * Consecutive days ordering (using user's local timezone)
   */
  private async calculateLongestStreak(receipts: ReceiptForAnalytics[], timezone: string): Promise<LongestStreak | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Get unique dates in user's local timezone (sorted)
    const uniqueDates = Array.from(new Set(
      validReceipts.map(r => {
        const localDate = getLocalDate(r.orderDate!, timezone);
        return localDate ? localDate.toISOString().split('T')[0] : null;
      }).filter((d): d is string => d !== null)
    )).sort();

    if (uniqueDates.length < 3) return undefined; // Need at least 3 days

    // Find longest consecutive streak
    let longestStreak = 1;
    let currentStreak = 1;
    let streakStart = 0;
    let longestStreakStart = 0;

    for (let i = 1; i < uniqueDates.length; i++) {
      const prevDate = new Date(uniqueDates[i - 1]);
      const currDate = new Date(uniqueDates[i]);
      const daysDiff = Math.floor((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));

      if (daysDiff === 1) {
        currentStreak++;
        if (currentStreak > longestStreak) {
          longestStreak = currentStreak;
          longestStreakStart = streakStart;
        }
      } else {
        currentStreak = 1;
        streakStart = i;
      }
    }

    if (longestStreak < 3) return undefined; // Only show if 3+ days

    const startDate = uniqueDates[longestStreakStart];
    const endDate = uniqueDates[longestStreakStart + longestStreak - 1];

    // Calculate total spent during streak
    const streakReceipts = validReceipts.filter(r => {
      const localDate = getLocalDate(r.orderDate!, timezone);
      if (!localDate) return false;
      const date = localDate.toISOString().split('T')[0];
      return date >= startDate && date <= endDate;
    });
    const totalSpent = streakReceipts.reduce((sum, r) => sum + r.amountSpent, 0);

    return {
      days: longestStreak,
      startDate,
      endDate,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      message: `${longestStreak} days straight without cooking`
    };
  }

  /**
   * Calculate Single Item Orders
   * Orders with 1-2 items under $20
   */
  private async calculateSingleItemOrders(receipts: ReceiptForAnalytics[]): Promise<SingleItemOrders | undefined> {
    const singleOrders = receipts.filter(r => {
      const itemCount = r.items.reduce((sum, item) => sum + item.quantity, 0);
      return itemCount <= 2 && r.amountSpent < 20;
    });

    if (singleOrders.length === 0) return undefined;

    const totalSpent = singleOrders.reduce((sum, r) => sum + r.amountSpent, 0);
    const averageAmount = totalSpent / singleOrders.length;

    // Find most common single item
    const itemCounts = new Map<string, number>();
    singleOrders.forEach(r => {
      r.items.forEach(item => {
        const count = itemCounts.get(item.name) || 0;
        itemCounts.set(item.name, count + 1);
      });
    });

    let mostCommon = 'Unknown';
    let maxCount = 0;
    itemCounts.forEach((count, item) => {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = `${item} (${count} times)`;
      }
    });

    return {
      count: singleOrders.length,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      averageAmount: parseFloat(averageAmount.toFixed(2)),
      message: `${singleOrders.length} times you couldn't just go get it`,
      mostCommon
    };
  }

  /**
   * Calculate Chain Dependency
   * Major chain frequency
   */
  private async calculateChainDependency(receipts: ReceiptForAnalytics[]): Promise<ChainDependency | undefined> {
    const majorChains = [
      "McDonald's", "Starbucks", "Chipotle", "Taco Bell", "Subway",
      "Dunkin'", "Wendy's", "Burger King", "KFC", "Chick-fil-A",
      "Popeyes", "Panera", "Jimmy John's", "Five Guys", "Shake Shack"
    ];

    const chainCounts = new Map<string, { count: number; spent: number }>();

    receipts.forEach(r => {
      if (!r.restaurantName) return;
      
      const chain = majorChains.find(c => 
        r.restaurantName!.toLowerCase().includes(c.toLowerCase())
      );
      
      if (chain) {
        const data = chainCounts.get(chain) || { count: 0, spent: 0 };
        data.count++;
        data.spent += r.amountSpent;
        chainCounts.set(chain, data);
      }
    });

    if (chainCounts.size === 0) return undefined;

    // Sort by count
    const sortedChains = Array.from(chainCounts.entries())
      .map(([name, data]) => ({ name, count: data.count, spent: parseFloat(data.spent.toFixed(2)) }))
      .sort((a, b) => b.count - a.count);

    const worstOffender = sortedChains[0];
    const percentage = Math.round((worstOffender.count / receipts.length) * 100);

    return {
      worstOffender: worstOffender.name,
      orderCount: worstOffender.count,
      totalSpent: worstOffender.spent,
      percentage,
      message: `${percentage}% of your orders were ${worstOffender.name}`,
      allChains: sortedChains
    };
  }

  /**
   * Calculate Most Expensive Order
   */
  private async calculateMostExpensiveOrder(receipts: ReceiptForAnalytics[]): Promise<MostExpensiveOrder | undefined> {
    if (receipts.length === 0) return undefined;

    const mostExpensive = receipts.reduce((max, r) => 
      r.amountSpent > max.amountSpent ? r : max
    , receipts[0]);

    return {
      amount: mostExpensive.amountSpent,
      restaurant: mostExpensive.restaurantName || 'Unknown',
      date: mostExpensive.orderDate ? mostExpensive.orderDate.toISOString().split('T')[0] : 'Unknown',
      items: mostExpensive.items.map(i => ({ name: i.name, price: i.price })),
      message: `You once spent $${mostExpensive.amountSpent.toFixed(2)} on a single order`
    };
  }

  /**
   * Calculate Coffee Addiction
   */
  private async calculateCoffeeAddiction(receipts: ReceiptForAnalytics[]): Promise<CoffeeAddiction | undefined> {
    const coffeeTerms = ['coffee', 'latte', 'espresso', 'cappuccino', 'americano', 'mocha', 'frappe', 'cold brew', 'macchiato'];
    
    const coffeeOrders = receipts.filter(r => 
      r.items.some(item => 
        coffeeTerms.some(term => item.name.toLowerCase().includes(term))
      )
    );

    if (coffeeOrders.length === 0) return undefined;

    const totalSpent = coffeeOrders.reduce((sum, r) => sum + r.amountSpent, 0);
    const averagePrice = totalSpent / coffeeOrders.length;

    // Find most ordered coffee drink
    const coffeeCounts = new Map<string, number>();
    coffeeOrders.forEach(r => {
      r.items.forEach(item => {
        if (coffeeTerms.some(term => item.name.toLowerCase().includes(term))) {
          const count = coffeeCounts.get(item.name) || 0;
          coffeeCounts.set(item.name, count + 1);
        }
      });
    });

    let mostOrdered = 'Unknown';
    let maxCount = 0;
    coffeeCounts.forEach((count, item) => {
      if (count > maxCount) {
        maxCount = count;
        mostOrdered = `${item} (${count} times)`;
      }
    });

    return {
      orderCount: coffeeOrders.length,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      averagePrice: parseFloat(averagePrice.toFixed(2)),
      mostOrdered,
      message: `You spent $${totalSpent.toFixed(2)} on coffee`,
      disclaimer: "This doesn't even count the Starbucks® ones"
    };
  }

  /**
   * Calculate Night Owl Badge (orders after 10pm in user's local timezone)
   */
  private async calculateNightOwl(receipts: ReceiptForAnalytics[], timezone: string): Promise<NightOwl | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    const nightOrders = validReceipts.filter(r => {
      const hour = getLocalHour(r.orderDate!, timezone);
      return hour !== null && hour >= 22;
    });
    if (nightOrders.length === 0) return undefined;

    const totalSpent = nightOrders.reduce((sum, r) => sum + r.amountSpent, 0);
    const percentage = Math.round((nightOrders.length / validReceipts.length) * 100);

    // Find latest order (by hour in user's timezone)
    const latest = nightOrders.reduce((latest, r) => {
      const rHour = getLocalHour(r.orderDate!, timezone) || 0;
      const latestHour = getLocalHour(latest.orderDate!, timezone) || 0;
      return rHour > latestHour ? r : latest;
    }, nightOrders[0]);

    const formatLocalTime = (date: Date) => {
      const localDate = getLocalDate(date, timezone);
      return localDate ? this.formatTime(localDate) : 'Unknown';
    };

    return {
      percentage,
      count: nightOrders.length,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      latestOrder: formatLocalTime(latest.orderDate!),
      message: `${percentage}% of your orders were after 10pm`
    };
  }

  /**
   * Calculate Spent This Year
   * Total spending for the current calendar year (in user's local timezone)
   */
  private async calculateSpentThisYear(receipts: ReceiptForAnalytics[], timezone: string): Promise<SpentThisYear | undefined> {
    // Get current year in user's timezone
    const now = new Date();
    const localNow = getLocalDate(now, timezone) || now;
    const currentYear = localNow.getFullYear();
    
    // Create year boundaries in user's timezone
    // We need to convert local year boundaries back to UTC for comparison
    const yearStartLocal = new Date(currentYear, 0, 1); // Jan 1 in server timezone
    const yearEndLocal = new Date(currentYear, 11, 31, 23, 59, 59); // Dec 31 in server timezone
    
    // Filter receipts from current year (comparing UTC dates, but year is determined by local timezone)
    const thisYearReceipts = receipts.filter(r => {
      if (!r.orderDate) return false;
      const localDate = getLocalDate(r.orderDate, timezone);
      if (!localDate) return false;
      const receiptYear = localDate.getFullYear();
      return receiptYear === currentYear;
    });

    if (thisYearReceipts.length === 0) return undefined;

    const totalSpent = thisYearReceipts.reduce((sum, r) => sum + r.amountSpent, 0);
    const orderCount = thisYearReceipts.length;
    const averagePerOrder = totalSpent / orderCount;

    return {
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      year: currentYear,
      orderCount,
      averagePerOrder: parseFloat(averagePerOrder.toFixed(2)),
      message: `You've spent $${totalSpent.toFixed(2)} on delivery this year`
    };
  }

  /**
   * Calculate Could Have Bought
   */
  private async calculateCouldHaveBought(receipts: ReceiptForAnalytics[]): Promise<CouldHaveBought | undefined> {
    const totalSpent = receipts.reduce((sum, r) => sum + r.amountSpent, 0);
    if (totalSpent === 0) return undefined;

    const comparisons = [
      { item: "Used Honda Civic", price: 5000, unit: "car" },
      { item: "Round-trip flights to Europe", price: 1200, unit: "trip" },
      { item: "Months of groceries", price: 300, unit: "month" },
      { item: "iPhone 15 Pro Max", price: 1199, unit: "phone" },
      { item: "Gym memberships", price: 50, unit: "month" },
      { item: "Netflix subscriptions", price: 15.49, unit: "month" }
    ];

    return {
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      comparisons: comparisons
        .map(c => {
          const quantity = parseFloat((totalSpent / c.price).toFixed(1));
          if (quantity >= 0.5) {
            return {
              item: c.item,
              quantity,
              message: quantity >= 1 
                ? `${Math.floor(quantity)} ${c.item.toLowerCase()}`
                : `${(quantity * 100).toFixed(0)}% of a ${c.unit}`
            };
          }
          return null;
        })
        .filter(c => c !== null) as Array<{ item: string; quantity: number; message: string }>
    };
  }

  /**
   * Calculate Missed Investment
   * 
   * Calculates what each receipt would be worth if invested in S&P 500
   * from the date it was spent, then sums all values.
   */
  private async calculateMissedInvestment(receipts: ReceiptForAnalytics[]): Promise<MissedInvestment | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate).sort((a, b) => 
      a.orderDate!.getTime() - b.orderDate!.getTime()
    );
    
    if (validReceipts.length === 0) return undefined;

    const totalSpent = receipts.reduce((sum, r) => sum + r.amountSpent, 0);
    const firstOrder = validReceipts[0];
    const now = new Date();
    const daysElapsed = Math.floor((now.getTime() - firstOrder.orderDate!.getTime()) / (1000 * 60 * 60 * 24));

    // Average S&P 500 annual return ~10%
    const sp500Return = 10; // Simplified 10% annual
    const annualReturnRate = sp500Return / 100;
    
    // Calculate compound interest for each receipt based on when it was spent
    let wouldBeWorth = 0;
    validReceipts.forEach(receipt => {
      const daysSinceReceipt = Math.floor((now.getTime() - receipt.orderDate!.getTime()) / (1000 * 60 * 60 * 24));
      const yearsSinceReceipt = daysSinceReceipt / 365;
      // Only calculate if the receipt date is in the past
      if (yearsSinceReceipt > 0) {
        wouldBeWorth += receipt.amountSpent * Math.pow(1 + annualReturnRate, yearsSinceReceipt);
      } else {
        // For future dates (shouldn't happen, but handle gracefully), just add the amount
        wouldBeWorth += receipt.amountSpent;
      }
    });
    
    const missedGains = wouldBeWorth - totalSpent;

    return {
      amountSpent: parseFloat(totalSpent.toFixed(2)),
      firstOrderDate: firstOrder.orderDate!.toISOString().split('T')[0],
      daysElapsed,
      sp500Return,
      wouldBeWorth: parseFloat(wouldBeWorth.toFixed(2)),
      missedGains: parseFloat(missedGains.toFixed(2)),
      message: `If you'd invested this in the S&P 500, you'd have $${wouldBeWorth.toFixed(2)}`
    };
  }

  /**
   * Calculate Cost Per Meal (Delivery Tax)
   * Calculates all extra costs beyond base food prices:
   * extraCosts = totalOrderAmount - sum(itemPrices)
   * 
   * Where totalOrderAmount (amountSpent) includes:
   * - Base food item prices
   * - Delivery fee
   * - Service fee
   * - Tax
   * - Tip
   * 
   * This gives us the true "delivery tax" - all costs beyond getting the food yourself.
   * 
   * Note: DoorDash CSV exports don't include the total order amount with fees,
   * so we skip DoorDash receipts for this calculation.
   */
  private async calculateCostPerMeal(receipts: ReceiptForAnalytics[]): Promise<CostPerMeal | undefined> {
    if (receipts.length === 0) return undefined;

    // Filter out DoorDash receipts - their CSV doesn't include total order amount with fees
    // DoorDash CSV only has item subtotals, not the final total including delivery fees, tax, etc.
    const receiptsWithTotalAmount = receipts.filter(r => r.receiptType !== 'doordash');
    
    if (receiptsWithTotalAmount.length === 0) {
      return undefined;
    }

    // Calculate extra costs for each receipt
    // extraCosts = amountSpent - sum(item.price * item.quantity)
    // amountSpent is the final total including delivery fee, service fee, tax, and tip
    const receiptsWithExtraCosts: Array<{ receipt: ReceiptForAnalytics; extraCosts: number; itemCount: number }> = [];
    
    receiptsWithTotalAmount.forEach(receipt => {
      // Calculate sum of item prices (base food cost)
      const itemSubtotal = receipt.items.reduce((sum, item) => {
        // Only count items with valid prices (> 0)
        if (item.price > 0) {
          return sum + (item.price * item.quantity);
        }
        return sum;
      }, 0);

      const itemCount = receipt.items.reduce((sum, item) => sum + item.quantity, 0);

      // Validate we can calculate extra costs
      if (itemCount === 0 || itemSubtotal <= 0 || itemSubtotal >= receipt.amountSpent) {
        return;
      }

      // Calculate extra costs (delivery fee + service fee + tax + tip)
      // This is the difference between what was paid and the base food cost
      const extraCosts = receipt.amountSpent - itemSubtotal;
      
      // Only include if extra costs are positive (should always be, but safety check)
      if (extraCosts > 0) {
        receiptsWithExtraCosts.push({ receipt, extraCosts, itemCount });
      }
    });

    // Need at least some receipts with valid data
    if (receiptsWithExtraCosts.length === 0) {
      return undefined;
    }

    // Aggregate extra costs
    const totalDeliveryFees = receiptsWithExtraCosts.reduce((sum, r) => sum + r.extraCosts, 0);
    const averageDeliveryFee = totalDeliveryFees / receiptsWithExtraCosts.length;
    
    // Each order is a meal, so averageDeliveryFeePerMeal = averageDeliveryFee
    // (We don't divide by item count - each order represents one meal/delivery)
    const averageDeliveryFeePerMeal = averageDeliveryFee;

    return {
      totalDeliveryFees: parseFloat(totalDeliveryFees.toFixed(2)),
      averageDeliveryFee: parseFloat(averageDeliveryFee.toFixed(2)),
      averageDeliveryFeePerMeal: parseFloat(averageDeliveryFeePerMeal.toFixed(2)),
      totalOrders: receiptsWithExtraCosts.length,
      message: `You paid $${averageDeliveryFeePerMeal.toFixed(2)} extra per meal in delivery fees`
    };
  }

  /**
   * Calculate Peak Hunger Hour (in user's local timezone)
   */
  private async calculatePeakHungerHour(receipts: ReceiptForAnalytics[], timezone: string): Promise<PeakHungerHour | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Group by hour in user's local timezone
    const hourCounts = new Map<number, number>();
    validReceipts.forEach(r => {
      const hour = getLocalHour(r.orderDate!, timezone);
      if (hour !== null) {
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
      }
    });

    // Find peak hour
    let peakHour = 0;
    let maxCount = 0;
    hourCounts.forEach((count, hour) => {
      if (count > maxCount) {
        maxCount = count;
        peakHour = hour;
      }
    });

    const percentage = Math.round((maxCount / validReceipts.length) * 100);

    return {
      hour: peakHour,
      hourDisplay: this.formatHour(peakHour),
      orderCount: maxCount,
      percentageOfTotal: percentage,
      message: `You're hungriest at ${this.formatHour(peakHour)}`
    };
  }

  /**
   * Calculate Delivery Waits (DoorDash and Uber Eats)
   * Calculates total and average time spent waiting for deliveries
   */
  private async calculateDeliveryWaits(receipts: ReceiptForAnalytics[]): Promise<DeliveryWaits | undefined> {
    // Calculate for DoorDash and Uber Eats receipts that have both order date and delivery time
    const receiptsWithWaitTime = receipts.filter(r => 
      (r.receiptType === 'doordash' || r.receiptType === 'uber_eats') && 
      r.orderDate && 
      r.deliveryTime
    );

    if (receiptsWithWaitTime.length === 0) {
      return undefined;
    }

    // Calculate wait time for each order (in minutes)
    const waitTimes: Array<{
      receipt: ReceiptForAnalytics;
      minutes: number;
    }> = [];

    receiptsWithWaitTime.forEach(receipt => {
      if (receipt.orderDate && receipt.deliveryTime) {
        const waitMs = receipt.deliveryTime.getTime() - receipt.orderDate.getTime();
        const waitMinutes = Math.round(waitMs / (1000 * 60));
        
        // Only include valid wait times (positive)
        if (waitMinutes > 0) {
          waitTimes.push({ receipt, minutes: waitMinutes });
        }
      }
    });

    if (waitTimes.length === 0) {
      return undefined;
    }

    // Calculate total and average wait time
    const totalMinutes = waitTimes.reduce((sum, wt) => sum + wt.minutes, 0);
    const averageMinutes = Math.round(totalMinutes / waitTimes.length);

    // Find longest wait
    const longestWait = waitTimes.reduce((longest, current) => 
      current.minutes > longest.minutes ? current : longest
    );

    // Find fastest delivery
    const fastestDelivery = waitTimes.reduce((fastest, current) => 
      current.minutes < fastest.minutes ? current : fastest
    );

    return {
      totalMinutes,
      averageMinutes,
      totalOrders: waitTimes.length,
      longestWait: {
        minutes: longestWait.minutes,
        restaurant: longestWait.receipt.restaurantName || 'Unknown',
        amount: longestWait.receipt.amountSpent,
        message: `Your longest wait was ${longestWait.minutes} minutes for ${longestWait.receipt.restaurantName || 'Unknown'}`
      },
      fastestDelivery: {
        minutes: fastestDelivery.minutes,
        restaurant: fastestDelivery.receipt.restaurantName || 'Unknown'
      }
    };
  }

  /**
   * Calculate Weekend Warrior (using user's local timezone)
   */
  private async calculateWeekendWarrior(receipts: ReceiptForAnalytics[], timezone: string): Promise<WeekendWarrior | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    let weekendOrders = 0;
    let weekdayOrders = 0;
    let weekendSpending = 0;
    let weekdaySpending = 0;

    validReceipts.forEach(r => {
      const day = getLocalDay(r.orderDate!, timezone);
      if (day === null) return;
      const isWeekend = day === 0 || day === 6; // Sunday or Saturday

      if (isWeekend) {
        weekendOrders++;
        weekendSpending += r.amountSpent;
      } else {
        weekdayOrders++;
        weekdaySpending += r.amountSpent;
      }
    });

    const ratio = weekdaySpending > 0 ? weekendSpending / weekdaySpending : 0;
    const message = weekdaySpending > weekendSpending 
      ? "You spend more on weekdays (cooking challenged all week)"
      : "Weekend delivery champion";

    return {
      weekendOrders,
      weekdayOrders,
      weekendSpending: parseFloat(weekendSpending.toFixed(2)),
      weekdaySpending: parseFloat(weekdaySpending.toFixed(2)),
      ratio: parseFloat(ratio.toFixed(2)),
      message
    };
  }

  // Helper methods

  private formatTime(date: Date): string {
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  }

  private formatHour(hour: number): string {
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:00 ${ampm}`;
  }

  private getDayOfWeek(date: Date): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[date.getDay()];
  }

  private getEmptyAnalytics(): WrappedAnalytics {
    return {
      shame: {},
      flex: {},
      comparative: {},
      patterns: {}
    };
  }
}

