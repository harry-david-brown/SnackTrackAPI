import {
  WrappedAnalytics,
  WrappedPercentiles,
  PercentileStanding,
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
import {
  formatTimeInTimezone,
  getLocalDateKey,
  getLocalDay,
  getLocalHour,
  getLocalMinuteOfDay,
  getLocalYear,
} from '../../utils/timezone';
import {
  isLateNightHour,
} from './shared/timeWindows';
import {
  calculateHypotheticalInvestment,
  HYPOTHETICAL_ANNUAL_RETURN_PERCENT,
} from './shared/investment';
import { WrappedAnalyticsQueryRepository } from './WrappedAnalyticsQueryRepository';
import logger from '../../config/logger';

/**
 * Wrapped Analytics Service
 * Calculates Spotify Wrapped-style analytics for maximum shareability
 */
export class WrappedAnalyticsService {
  /** Accounts need at least this many receipts to enter the percentile pool. */
  private static readonly PERCENTILE_MIN_RECEIPTS = 3;
  /** Below this pool size, percentiles are noise — omit them entirely. */
  private static readonly PERCENTILE_MIN_SAMPLE = 100;

  constructor(private readonly queries: WrappedAnalyticsQueryRepository) {}

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
      this.calculateMostExpensiveOrder(receipts, userTimezone),
      this.calculateCoffeeAddiction(receipts),
      this.calculateNightOwl(receipts, userTimezone),
      
      // Comparative analytics
      this.calculateSpentThisYear(receipts, userTimezone),
      this.calculateCouldHaveBought(receipts),
      this.calculateMissedInvestment(receipts, userTimezone),
      this.calculateCostPerMeal(receipts),
      
      // Pattern analytics
      this.calculatePeakHungerHour(receipts, userTimezone),
      this.calculateWeekendWarrior(receipts, userTimezone),
      this.calculateDeliveryWaits(receipts)
    ]);

    const coverage = this.calculateCoverage(receipts);

    // Cross-user standings (single aggregate query; independent of the
    // per-receipt analytics above).
    const percentiles = await this.calculatePercentiles(userId);

    return {
      coverage,
      percentiles,
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
   * Describe only the receipt coverage SnackTrack can verify. An uploaded
   * export strengthens the source mix but never proves exhaustive history.
   */
  private calculateCoverage(receipts: ReceiptForAnalytics[]) {
    const datedReceipts = receipts
      .filter((receipt): receipt is ReceiptForAnalytics & { orderDate: Date } => Boolean(receipt.orderDate))
      .sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime());
    const dataSources = Array.from(new Set(
      receipts
        .map(receipt => receipt.dataSource)
        .filter((source): source is string => Boolean(source))
    )).sort();

    return {
      orderCount: receipts.length,
      earliestOrderDate: datedReceipts[0]?.orderDate.toISOString() ?? null,
      latestOrderDate: datedReceipts[datedReceipts.length - 1]?.orderDate.toISOString() ?? null,
      dataSources,
      hasExportData: dataSources.includes('csv'),
    };
  }

  /**
   * Fetch user timezone from database
   */
  private async fetchUserTimezone(userId: string): Promise<string> {
    return this.queries.getUserTimezone(userId);
  }

  /**
   * Fetch all receipts for analytics
   */
  private async fetchUserReceipts(userId: string): Promise<ReceiptForAnalytics[]> {
    return this.queries.getUserReceipts(userId);
  }

  /**
   * Rank this user against every other account with enough data.
   *
   * One aggregate query: per-user totals + PERCENT_RANK window functions.
   * night_owl_pct mirrors calculateNightOwl (share of orders from 10pm–4am,
   * in each user's own timezone; order_date is stored as a UTC instant).
   * Returns undefined when the user isn't in the pool (too few receipts) or
   * the pool itself is too small for percentiles to mean anything.
   */
  private async calculatePercentiles(userId: string): Promise<WrappedPercentiles | undefined> {
    try {
      const row = await this.queries.getPercentileRanks(
        userId,
        WrappedAnalyticsService.PERCENTILE_MIN_RECEIPTS,
      );
      if (!row) return undefined;

      const sampleSize = row.sampleSize;
      if (sampleSize < WrappedAnalyticsService.PERCENTILE_MIN_SAMPLE) return undefined;

      const standing = (rank: unknown): PercentileStanding => {
        const fraction = Math.max(0, Math.min(1, Number(rank)));
        return {
          percentile: Math.round(fraction * 100),
          topPercent: Math.min(100, Math.max(1, Math.round((1 - fraction) * 100)))
        };
      };

      return {
        sampleSize,
        totalSpent: standing(row.spentRank),
        orderCount: standing(row.ordersRank),
        nightOwl: standing(row.nightOwlRank)
      };
    } catch (error) {
      // Percentiles are a garnish on the summary — never fail the whole
      // analytics payload over them.
      logger.warn('Wrapped percentile calculation unavailable', { error });
      return undefined;
    }
  }

  /**
   * Calculate late-night orders using the shared 10pm–4am local window.
   */
  private async calculateLateNightOrders(receipts: ReceiptForAnalytics[], timezone: string): Promise<LateNightOrders | undefined> {
    const lateNightReceipts = receipts.filter(r => {
      if (!r.orderDate) return false;
      const hour = getLocalHour(r.orderDate, timezone);
      return isLateNightHour(hour);
    });

    if (lateNightReceipts.length === 0) return undefined;

    const totalSpent = lateNightReceipts.reduce((sum, r) => sum + r.amountSpent, 0);
    
    // Find latest order (by hour in user's timezone)
    const latest = lateNightReceipts.reduce((latest, r) => {
      if (!r.orderDate) return latest;
      if (!latest.orderDate) return r;
      const rMinute = getLocalMinuteOfDay(r.orderDate, timezone) ?? -1;
      const latestMinute = getLocalMinuteOfDay(latest.orderDate, timezone) ?? -1;
      return rMinute > latestMinute ? r : latest;
    }, lateNightReceipts[0]);

    // Find worst offender (most expensive late night order)
    const worstOffender = lateNightReceipts.reduce((worst, r) => 
      r.amountSpent > worst.amountSpent ? r : worst
    , lateNightReceipts[0]);

    // Format times in user's local timezone
    const formatLocalTime = (date: Date) => formatTimeInTimezone(date, timezone) || 'Unknown';

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
      const dateKey = getLocalDateKey(r.orderDate, timezone);
      if (!dateKey) return;
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
    const dayOfWeek = this.getDayOfWeek(laziestDate);

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
        return getLocalDateKey(r.orderDate!, timezone);
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
      const date = getLocalDateKey(r.orderDate!, timezone);
      if (!date) return false;
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
   * Orders with 1-2 items under $20, excluding receipts with Unknown items
   */
  private async calculateSingleItemOrders(receipts: ReceiptForAnalytics[]): Promise<SingleItemOrders | undefined> {
    const singleOrders = receipts.filter(r => {
      const itemCount = r.items.reduce((sum, item) => sum + item.quantity, 0);
      // Exclude receipts with any "Unknown" items (case-insensitive)
      const hasUnknownItems = r.items.some(item => 
        item.name.toLowerCase() === 'unknown' || 
        item.name.trim() === '' || 
        !item.name
      );
      return r.items.length > 0 && itemCount === 1 && r.amountSpent < 20 && !hasUnknownItems;
    });

    if (singleOrders.length === 0) return undefined;

    const totalSpent = singleOrders.reduce((sum, r) => sum + r.amountSpent, 0);
    const averageAmount = totalSpent / singleOrders.length;

    // Find most common single item (excluding "Unknown")
    const itemCounts = new Map<string, number>();
    singleOrders.forEach(r => {
      r.items.forEach(item => {
        // Skip Unknown/invalid items when counting (case-insensitive)
        const itemName = item.name?.trim();
        if (itemName && itemName.toLowerCase() !== 'unknown') {
          const count = itemCounts.get(itemName) || 0;
          itemCounts.set(itemName, count + item.quantity);
        }
      });
    });

    // If no valid items found, return undefined
    if (itemCounts.size === 0) return undefined;

    let mostCommon = 'Various items';
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
      "Popeyes", "Panera", "Jimmy John's", "Five Guys", "Shake Shack",
      "Tim Hortons", "Pizza Pizza", "Harvey's", "Swiss Chalet",
      "Mary Brown's", "A&W", "Booster Juice"
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
      .sort((a, b) => b.count - a.count || b.spent - a.spent || a.name.localeCompare(b.name));

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
  private async calculateMostExpensiveOrder(receipts: ReceiptForAnalytics[], timezone: string): Promise<MostExpensiveOrder | undefined> {
    if (receipts.length === 0) return undefined;

    const mostExpensive = receipts.reduce((max, r) => 
      r.amountSpent > max.amountSpent ? r : max
    , receipts[0]);

    return {
      amount: mostExpensive.amountSpent,
      restaurant: mostExpensive.restaurantName || 'Unknown',
      date: mostExpensive.orderDate ? getLocalDateKey(mostExpensive.orderDate, timezone) || 'Unknown' : 'Unknown',
      items: mostExpensive.items.map(i => ({ name: i.name, price: i.price })),
      message: `You once spent $${mostExpensive.amountSpent.toFixed(2)} on a single order`
    };
  }

  /**
   * Calculate Coffee Addiction
   */
  private async calculateCoffeeAddiction(receipts: ReceiptForAnalytics[]): Promise<CoffeeAddiction | undefined> {
    const coffeeTerms = ['coffee', 'latte', 'espresso', 'cappuccino', 'americano', 'mocha', 'frappe', 'cold brew', 'macchiato', 'iced capp'];
    
    const coffeeOrders = receipts.filter(r => 
      r.items.some(item => 
        coffeeTerms.some(term => item.name.toLowerCase().includes(term))
      )
    );

    if (coffeeOrders.length === 0) return undefined;

    let totalSpent = 0;
    let totalCoffeeItems = 0;

    // Find most ordered coffee drink
    const coffeeCounts = new Map<string, number>();
    coffeeOrders.forEach(r => {
      r.items.forEach(item => {
        if (coffeeTerms.some(term => item.name.toLowerCase().includes(term))) {
          const count = coffeeCounts.get(item.name) || 0;
          coffeeCounts.set(item.name, count + item.quantity);
          totalCoffeeItems += item.quantity;
          totalSpent += item.price * item.quantity;
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
      averagePrice: parseFloat((totalSpent / Math.max(1, totalCoffeeItems)).toFixed(2)),
      mostOrdered,
      message: `You spent $${totalSpent.toFixed(2)} on coffee items`
    };
  }

  /**
   * Calculate Night Owl Badge using the shared 10pm–4am local window.
   */
  private async calculateNightOwl(receipts: ReceiptForAnalytics[], timezone: string): Promise<NightOwl | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    const nightOrders = validReceipts.filter(r => {
      const hour = getLocalHour(r.orderDate!, timezone);
      return isLateNightHour(hour);
    });
    if (nightOrders.length === 0) return undefined;

    const totalSpent = nightOrders.reduce((sum, r) => sum + r.amountSpent, 0);
    const percentage = Math.round((nightOrders.length / validReceipts.length) * 100);

    // Find latest order (by hour in user's timezone)
    const latest = nightOrders.reduce((latest, r) => {
      const rMinute = getLocalMinuteOfDay(r.orderDate!, timezone) ?? -1;
      const latestMinute = getLocalMinuteOfDay(latest.orderDate!, timezone) ?? -1;
      return rMinute > latestMinute ? r : latest;
    }, nightOrders[0]);

    const formatLocalTime = (date: Date) => formatTimeInTimezone(date, timezone) || 'Unknown';

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
    const currentYear = getLocalYear(now, timezone) ?? now.getUTCFullYear();
    
    // Filter receipts from current year (comparing UTC dates, but year is determined by local timezone)
    const thisYearReceipts = receipts.filter(r => {
      if (!r.orderDate) return false;
      const receiptYear = getLocalYear(r.orderDate, timezone);
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
  private async calculateCouldHaveBought(_receipts: ReceiptForAnalytics[]): Promise<CouldHaveBought | undefined> {
    // Accurate comparisons require a receipt currency plus current, localized
    // comparison prices. Neither is represented in the current analytics
    // schema, so omit this metric instead of presenting false equivalences.
    return undefined;
  }

  /**
   * Calculate Missed Investment
   * 
   * Calculates a hypothetical value using the shared fixed annual return from each
   * receipt date. This is illustrative, not historical market performance.
   */
  private async calculateMissedInvestment(receipts: ReceiptForAnalytics[], timezone: string): Promise<MissedInvestment | undefined> {
    const validReceipts = receipts.filter(r => r.orderDate && Number.isFinite(r.amountSpent) && r.amountSpent > 0).sort((a, b) =>
      a.orderDate!.getTime() - b.orderDate!.getTime()
    );
    
    if (validReceipts.length === 0) return undefined;

    const firstOrder = validReceipts[0];
    const now = new Date();
    const daysElapsed = Math.floor((now.getTime() - firstOrder.orderDate!.getTime()) / (1000 * 60 * 60 * 24));

    const sp500Return = HYPOTHETICAL_ANNUAL_RETURN_PERCENT;
    const investment = calculateHypotheticalInvestment(
      validReceipts.map(receipt => ({ amount: receipt.amountSpent, occurredAt: receipt.orderDate! })),
      now,
    );
    const totalSpent = investment.contributed;
    const wouldBeWorth = investment.futureValue;
    const missedGains = investment.gains;

    return {
      amountSpent: parseFloat(totalSpent.toFixed(2)),
      firstOrderDate: getLocalDateKey(firstOrder.orderDate!, timezone) || firstOrder.orderDate!.toISOString().split('T')[0],
      daysElapsed,
      sp500Return,
      wouldBeWorth: parseFloat(wouldBeWorth.toFixed(2)),
      missedGains: parseFloat(missedGains.toFixed(2)),
      message: `At a hypothetical ${sp500Return}% annual return, it could have grown to $${wouldBeWorth.toFixed(2)}`
    };
  }

  /**
   * Cost-per-meal requires explicit fee, tax, tip, promotion, and item subtotal
   * fields. It remains omitted until the receipt model can represent them.
   */
  private async calculateCostPerMeal(_receipts: ReceiptForAnalytics[]): Promise<CostPerMeal | undefined> {
    // Order total minus item subtotal is not a delivery fee: it also mixes tax,
    // tips, service fees, promotions, and substitutions. The current receipt
    // model does not store those components, so do not publish a false metric.
    return undefined;
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
        
        // Ignore corrupt/cross-day timestamps. Even scheduled grocery orders
        // should not be presented as a continuous food-delivery wait over 12h.
        if (waitMinutes > 0 && waitMinutes <= 12 * 60) {
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

    // Two weekend days should not be compared directly with five weekdays.
    // Normalize both totals to an average weekday-category day.
    const weekendDailySpending = weekendSpending / 2;
    const weekdayDailySpending = weekdaySpending / 5;
    const ratio = weekdayDailySpending > 0
      ? weekendDailySpending / weekdayDailySpending
      : weekendDailySpending > 0 ? 5 : 0;
    const message = ratio > 1
      ? "Weekend delivery champion"
      : "You spend more per day on weekdays";

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

  private formatHour(hour: number): string {
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:00 ${ampm}`;
  }

  private getDayOfWeek(dateKey: string): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const [year, month, day] = dateKey.split('-').map(Number);
    return days[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  }

  private getEmptyAnalytics(): WrappedAnalytics {
    return {
      coverage: {
        orderCount: 0,
        earliestOrderDate: null,
        latestOrderDate: null,
        dataSources: [],
        hasExportData: false,
      },
      shame: {},
      flex: {},
      comparative: {},
      patterns: {}
    };
  }
}
