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
  WeekendWarrior
} from './WrappedAnalyticsTypes';

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
      weekendWarrior
    ] = await Promise.all([
      // Shame analytics
      this.calculateLateNightOrders(receipts),
      this.calculateLaziestDay(receipts),
      this.calculateLongestStreak(receipts),
      this.calculateSingleItemOrders(receipts),
      this.calculateChainDependency(receipts),
      
      // Flex analytics
      this.calculateMostExpensiveOrder(receipts),
      this.calculateCoffeeAddiction(receipts),
      this.calculateNightOwl(receipts),
      
      // Comparative analytics
      this.calculateSpentThisYear(receipts),
      this.calculateCouldHaveBought(receipts),
      this.calculateMissedInvestment(receipts),
      this.calculateCostPerMeal(receipts),
      
      // Pattern analytics
      this.calculatePeakHungerHour(receipts),
      this.calculateWeekendWarrior(receipts)
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
        weekendWarrior
      }
    };
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
        data_source as "dataSource"
      FROM receipts
      WHERE user_id = $1
      ORDER BY order_date DESC
    `;

    const result = await this.pool.query(query, [userId]);
    return result.rows.map(row => ({
      ...row,
      amountSpent: parseFloat(row.amountSpent),
      orderDate: row.orderDate ? new Date(row.orderDate) : null,
      items: Array.isArray(row.items) ? row.items : []
    }));
  }

  /**
   * Calculate 3am Regret Orders
   * Orders placed between midnight and 6am
   */
  private async calculateLateNightOrders(receipts: ReceiptForAnalytics[]): Promise<LateNightOrders | undefined> {
    const lateNightReceipts = receipts.filter(r => {
      if (!r.orderDate) return false;
      const hour = r.orderDate.getHours();
      return hour >= 0 && hour < 6;
    });

    if (lateNightReceipts.length === 0) return undefined;

    const totalSpent = lateNightReceipts.reduce((sum, r) => sum + r.amountSpent, 0);
    
    // Find latest order
    const latest = lateNightReceipts.reduce((latest, r) => {
      if (!r.orderDate) return latest;
      if (!latest.orderDate) return r;
      return r.orderDate.getHours() > latest.orderDate.getHours() ? r : latest;
    }, lateNightReceipts[0]);

    // Find worst offender (most expensive late night order)
    const worstOffender = lateNightReceipts.reduce((worst, r) => 
      r.amountSpent > worst.amountSpent ? r : worst
    , lateNightReceipts[0]);

    return {
      count: lateNightReceipts.length,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      latestOrder: latest.orderDate ? this.formatTime(latest.orderDate) : 'Unknown',
      worstOffender: worstOffender.orderDate ? {
        restaurant: worstOffender.restaurantName || 'Unknown',
        time: this.formatTime(worstOffender.orderDate),
        amount: worstOffender.amountSpent,
        items: worstOffender.items.map(i => i.name)
      } : undefined
    };
  }

  /**
   * Calculate Laziest Day
   * Day with most orders
   */
  private async calculateLaziestDay(receipts: ReceiptForAnalytics[]): Promise<LaziestDay | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Group by date
    const dayGroups = new Map<string, ReceiptForAnalytics[]>();
    validReceipts.forEach(r => {
      if (!r.orderDate) return;
      const dateKey = r.orderDate.toISOString().split('T')[0];
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
   * Consecutive days ordering
   */
  private async calculateLongestStreak(receipts: ReceiptForAnalytics[]): Promise<LongestStreak | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Get unique dates (sorted)
    const uniqueDates = Array.from(new Set(
      validReceipts.map(r => r.orderDate!.toISOString().split('T')[0])
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
      const date = r.orderDate!.toISOString().split('T')[0];
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
   * Calculate Night Owl Badge
   */
  private async calculateNightOwl(receipts: ReceiptForAnalytics[]): Promise<NightOwl | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    const nightOrders = validReceipts.filter(r => r.orderDate!.getHours() >= 22);
    if (nightOrders.length === 0) return undefined;

    const totalSpent = nightOrders.reduce((sum, r) => sum + r.amountSpent, 0);
    const percentage = Math.round((nightOrders.length / validReceipts.length) * 100);

    // Find latest order
    const latest = nightOrders.reduce((latest, r) => 
      r.orderDate!.getHours() > latest.orderDate!.getHours() ? r : latest
    , nightOrders[0]);

    return {
      percentage,
      count: nightOrders.length,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      latestOrder: this.formatTime(latest.orderDate!),
      message: `${percentage}% of your orders were after 10pm`
    };
  }

  /**
   * Calculate Spent This Year
   * Total spending for the current calendar year
   */
  private async calculateSpentThisYear(receipts: ReceiptForAnalytics[]): Promise<SpentThisYear | undefined> {
    const currentYear = new Date().getFullYear();
    const yearStart = new Date(currentYear, 0, 1); // January 1st of current year
    const yearEnd = new Date(currentYear, 11, 31, 23, 59, 59); // December 31st of current year

    // Filter receipts from current year
    const thisYearReceipts = receipts.filter(r => {
      if (!r.orderDate) return false;
      return r.orderDate >= yearStart && r.orderDate <= yearEnd;
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
      { item: "Used Honda Civic", price: 10000, unit: "car" },
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
   * Calculate Cost Per Meal
   */
  private async calculateCostPerMeal(receipts: ReceiptForAnalytics[]): Promise<CostPerMeal | undefined> {
    if (receipts.length === 0) return undefined;

    const totalSpent = receipts.reduce((sum, r) => sum + r.amountSpent, 0);
    const deliveryAverage = totalSpent / receipts.length;
    const groceryEstimate = 7.50; // Average meal cooked at home
    const difference = deliveryAverage - groceryEstimate;
    const annualWaste = difference * receipts.length;

    return {
      deliveryAverage: parseFloat(deliveryAverage.toFixed(2)),
      groceryEstimate,
      difference: parseFloat(difference.toFixed(2)),
      annualWaste: parseFloat(annualWaste.toFixed(2)),
      message: `You paid $${difference.toFixed(2)} extra per meal for convenience`
    };
  }

  /**
   * Calculate Peak Hunger Hour
   */
  private async calculatePeakHungerHour(receipts: ReceiptForAnalytics[]): Promise<PeakHungerHour | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Group by hour
    const hourCounts = new Map<number, number>();
    validReceipts.forEach(r => {
      const hour = r.orderDate!.getHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
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
   * Calculate Weekend Warrior
   */
  private async calculateWeekendWarrior(receipts: ReceiptForAnalytics[]): Promise<WeekendWarrior | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    let weekendOrders = 0;
    let weekdayOrders = 0;
    let weekendSpending = 0;
    let weekdaySpending = 0;

    validReceipts.forEach(r => {
      const day = r.orderDate!.getDay();
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

