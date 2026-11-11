import { isSingleItemOrder, singleItemDisplayName } from './shared/singleItemOrders';
import { calculateHistoricalInvestment, type InvestmentContext } from './shared/historicalInvestment';
import { classifyItemPersonality } from './dashboard/itemPersonalities';
import { normalizeRestaurantName as normalizeRestaurant } from './dashboard/normalization';
import { wrappedNetAmount, wrappedSpending } from './shared/wrappedSpending';
import { projectReceiptForAnalytics } from './ReceiptAnalyticsProjection';
import {
  buildOrderComparisonProfile,
  selectOrderComparisonStandings,
  type OrderComparisonProfile,
  type OrderComparisonRank,
  type WrappedPercentileRanks,
} from './shared/orderComparisons';
import type { WrappedReceiptSnapshot } from '../ports/ProjectionPorts';
import { overnightMinute, spendingByCurrency, currencyOf } from './shared/receiptMetrics';
import {
  hasOrderTimeEvidence,
  mostDeliveriesDay,
  orderMetricEligibility,
  summarizeOrderMetrics,
  usesOrderEventMetrics,
} from './shared/orderMetrics';
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
  DeliveryFeeTrend,
  FeePeriod,
  PeakHungerHour,
  WeekendWarrior,
  DeliveryWaits,
} from './WrappedAnalyticsTypes';
import {
  formatTimeInTimezone,
  getLocalDateKey,
  getLocalDay,
  getLocalHour,
  getLocalMinuteOfDay,
  getLocalYear,
} from '../../utils/timezone';
import { isLateNightHour } from './shared/timeWindows';
import { buildRecapStories } from './shared/recapStories';
import { usableItemUnitPrice } from '../receipt/ItemPrice';
import {
  calculateHypotheticalInvestment,
  HYPOTHETICAL_ANNUAL_RETURN_PERCENT,
} from './shared/investment';
export interface WrappedAnalyticsQueryPort {
  getRecapCoverage?(userId: string): Promise<import('./shared/recapStories').RecapCoverageInterval[]>;
  getUserTimezone(userId: string): Promise<string>;
  getUserReceipts(userId: string): Promise<ReceiptForAnalytics[]>;
  getPercentileRanks(
    userId: string,
    minimumReceipts: number,
    target?: OrderComparisonProfile,
  ): Promise<WrappedPercentileRanks | null>;
}

export interface WrappedAnalyticsLogPort {
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
}

/** Import/row order must not choose a different merchant when records tie. */
const compareReceiptTie = (left: ReceiptForAnalytics, right: ReceiptForAnalytics): number => {
  const date = (receipt: ReceiptForAnalytics) => {
    const value = receipt.orderDate?.getTime();
    return value !== undefined && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return (
    date(left) - date(right) ||
    (left.restaurantName ?? '').localeCompare(right.restaurantName ?? '') ||
    (left.id ?? '').localeCompare(right.id ?? '')
  );
};

/** Pure receipt-to-analytics calculation policy. */
export class WrappedAnalyticsCalculator {
  /**
   * Calculate all wrapped analytics for a user
   */
  async calculate(
    receipts: ReceiptForAnalytics[],
    userTimezone: string,
    percentiles?: WrappedPercentiles,
    market?: InvestmentContext,
  ): Promise<WrappedAnalytics> {
    const eventMetrics = usesOrderEventMetrics(receipts);
    if (receipts.length === 0) {
      return {
        ...this.getEmptyAnalytics(),
        ...(eventMetrics
          ? {
              behaviorPolicyVersion: 1,
              orderMetrics: summarizeOrderMetrics(receipts),
              deliveryDayRanking: mostDeliveriesDay(receipts, userTimezone),
              currencyCode: 'UNKNOWN',
              totalsByCurrency: {},
            }
          : {}),
      };
    }

    // Export event timezones outrank later account preferences for every story.
    receipts = receipts.map((r) => ({
      ...r,
      timezone: r.resolution?.timestamp?.timezone ?? r.timezone ?? userTimezone,
    }));
    if (eventMetrics) receipts.sort(compareReceiptTie);
    const allReceipts = receipts;
    const orderMetrics = eventMetrics ? summarizeOrderMetrics(receipts) : undefined;
    // User-facing delivery records rank dated, completed deliveries, just like
    // dashboard delivery stories. Other evidence remains in orderMetrics.
    const deliveryDayRanking = eventMetrics
      ? mostDeliveriesDay(receipts.filter((r) => orderMetricEligibility(r).delivered &&
          r.orderDate && Number.isFinite(r.orderDate.getTime())), userTimezone)
      : undefined;
    const spending = spendingByCurrency(receipts);
    const established = eventMetrics
      ? receipts.filter((r) => orderMetricEligibility(r).establishedAttempt)
      : receipts;
    receipts = eventMetrics
      ? established.filter((r) => orderMetricEligibility(r).delivered)
      : receipts;
    // Keep policy-3 evidence intact. Unknown/foreign costs are not zero-priced
    // deliveries; each story derives its own currency-aware financial cohort.
    receipts = eventMetrics
      ? receipts
      : receipts.map((r) =>
          currencyOf(r) === spending.primary
            ? {
                ...r,
                amountSpent: r.amountSpent,
              }
            : {
                ...r,
                amountSpent: 0,
                subtotal: null,
                tax: null,
                tip: null,
                deliveryFee: null,
                serviceFee: null,
                savings: null,
                items: r.items.map((i) => ({ ...i, price: 0 })),
              },
        );
    const timed = eventMetrics ? receipts.filter(hasOrderTimeEvidence) : receipts;
    const financialActivity =
      eventMetrics && spending.primary !== 'UNKNOWN'
        ? receipts.filter(
            (r) =>
              currencyOf(r) === spending.primary && orderMetricEligibility(r).netAmount !== null,
          )
        : eventMetrics
          ? []
          : receipts;
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
      deliveryFeeTrend,
      peakHungerHour,
      weekendWarrior,
      deliveryWaits,
    ] = await Promise.all([
      // Shame analytics
      this.calculateLateNightOrders(timed, userTimezone),
      // An uncertain all-account daily record must not suppress unrelated stories.
      !eventMetrics || deliveryDayRanking?.status === 'available'
        ? this.calculateLaziestDay(receipts, userTimezone) : undefined,
      this.calculateLongestStreak(receipts, userTimezone),
      // This story has a price threshold. Unknown/other-currency costs cannot
      // become zero-priced candidates through the display-only money projection.
      this.calculateSingleItemOrders(financialActivity),
      this.calculateChainDependency(receipts),

      // Flex analytics
      this.calculateMostExpensiveOrder(financialActivity, userTimezone),
      this.calculateCoffeeAddiction(receipts),
      this.calculateNightOwl(timed, userTimezone),

      // Comparative analytics
      this.calculateSpentThisYear(
        eventMetrics ? established : receipts,
        userTimezone,
        eventMetrics,
      ),
      this.calculateCouldHaveBought(receipts),
      // This is a hypothetical spending illustration, not a payment-ledger return.
      market?.mode === 'historical' ? undefined : this.calculateMissedInvestment(financialActivity, userTimezone),
      this.calculateCostPerMeal(financialActivity),
      this.calculateDeliveryFeeTrend(financialActivity, userTimezone),

      // Pattern analytics
      this.calculatePeakHungerHour(timed, userTimezone),
      this.calculateWeekendWarrior(receipts, userTimezone),
      this.calculateDeliveryWaits(timed),
    ]);

    const coverage = this.calculateCoverage(eventMetrics ? established : receipts);
    // The new ranking's count and spend must come from exactly the same delivered cohort.
    let deliveredDay = laziestDay;
    if (deliveryDayRanking?.status === 'available') {
      const day = deliveryDayRanking.day;
      deliveredDay = {
        date: day,
        dayOfWeek: this.getDayOfWeek(day),
        orderCount: deliveryDayRanking.deliveries,
        ...wrappedSpending(
          allReceipts.filter(
            (r) =>
              orderMetricEligibility(r).delivered &&
              r.orderDate &&
              getLocalDateKey(r.orderDate, r.timezone ?? userTimezone) === day,
          ),
          true,
        ),
        restaurants: allReceipts
          .filter(
            (r) =>
              orderMetricEligibility(r).delivered &&
              r.orderDate &&
              getLocalDateKey(
                r.orderDate,
                r.resolution?.timestamp?.timezone ?? r.timezone ?? userTimezone,
              ) === day,
          )
          .map((r) => r.restaurantName ?? 'Unknown'),
        message: `${deliveryDayRanking.deliveries} deliveries on your busiest delivery day.`,
      };
    }

    return {
      coverage,
      ...(orderMetrics
        ? {
            behaviorPolicyVersion: 1,
            orderMetrics,
            deliveryDayRanking,
            currencyCode: spending.primary,
            totalsByCurrency: spending.buckets,
          }
        : {}),
      // All-time comparison eligibility is independent of whether a daily record can be proven.
      percentiles: eventMetrics
        ? selectOrderComparisonStandings(
            percentiles,
            buildOrderComparisonProfile(allReceipts, userTimezone),
          )
        : percentiles,
      shame: {
        lateNightOrders,
        laziestDay: deliveredDay,
        longestStreak,
        singleItemOrders,
        chainDependency,
      },
      flex: {
        mostExpensiveOrder,
        coffeeAddiction,
        nightOwl,
      },
      comparative: {
        spentThisYear,
        couldHaveBought,
        missedInvestment,
        historicalInvestment: market?.mode === 'historical' ? calculateHistoricalInvestment(
          financialActivity.filter(r => r.orderDate).map(r => ({ amount: wrappedNetAmount(r) ?? NaN,
            date: getLocalDateKey(r.orderDate!, r.timezone ?? userTimezone) ?? '' })), spending.primary, market,
        ) : undefined,
        costPerMeal,
        deliveryFeeTrend,
      },
      patterns: {
        peakHungerHour,
        weekendWarrior,
        deliveryWaits,
      },
    };
  }

  /**
   * Describe only the receipt coverage SnackTrack can verify. An uploaded
   * export strengthens the source mix but never proves exhaustive history.
   */
  private calculateCoverage(receipts: ReceiptForAnalytics[]) {
    const datedReceipts = receipts
      .filter((receipt): receipt is ReceiptForAnalytics & { orderDate: Date } =>
        Boolean(receipt.orderDate),
      )
      .sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime());
    const dataSources = Array.from(
      new Set(
        receipts
          .flatMap((receipt) => receipt.resolution?.sources ?? [receipt.dataSource])
          .filter((source): source is string => Boolean(source)),
      ),
    ).sort();

    return {
      orderCount: receipts.length,
      earliestOrderDate: datedReceipts[0]?.orderDate.toISOString() ?? null,
      latestOrderDate: datedReceipts[datedReceipts.length - 1]?.orderDate.toISOString() ?? null,
      dataSources,
      hasExportData: dataSources.includes('csv'),
    };
  }

  /**
   * Calculate late-night orders using the shared 10pm–4am local window.
   */
  private async calculateLateNightOrders(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<LateNightOrders | undefined> {
    const lateNightReceipts = receipts.filter((r) => {
      if (!r.orderDate) return false;
      const hour = getLocalHour(r.orderDate, r.timezone ?? timezone);
      return isLateNightHour(hour);
    });

    if (lateNightReceipts.length === 0) return undefined;

    const costs = wrappedSpending(lateNightReceipts);

    // Find latest order (by hour in user's timezone)
    const latest = lateNightReceipts.reduce((latest, r) => {
      if (!r.orderDate) return latest;
      if (!latest.orderDate) return r;
      const rMinute = getLocalMinuteOfDay(r.orderDate, r.timezone ?? timezone) ?? -1;
      const latestMinute = getLocalMinuteOfDay(latest.orderDate, latest.timezone ?? timezone) ?? -1;
      const difference = overnightMinute(rMinute) - overnightMinute(latestMinute);
      return difference > 0 || (difference === 0 && compareReceiptTie(r, latest) < 0) ? r : latest;
    }, lateNightReceipts[0]);

    // Find worst offender (most expensive late night order)
    const worstOffender =
      costs.totalSpent === null
        ? undefined
        : lateNightReceipts.reduce((worst, r) => {
            const difference = wrappedNetAmount(r)! - wrappedNetAmount(worst)!;
            return difference > 0 || (difference === 0 && compareReceiptTie(r, worst) < 0)
              ? r
              : worst;
          }, lateNightReceipts[0]);

    // Format times in user's local timezone
    const formatLocalTime = (date: Date, eventTimezone = timezone) =>
      formatTimeInTimezone(date, eventTimezone) || 'Unknown';

    return {
      count: lateNightReceipts.length,
      ...costs,
      latestOrder: latest.orderDate
        ? formatLocalTime(latest.orderDate, latest.timezone ?? timezone)
        : 'Unknown',
      worstOffender: worstOffender?.orderDate
        ? {
            restaurant: worstOffender.restaurantName || 'Unknown',
            time: formatLocalTime(worstOffender.orderDate, worstOffender.timezone ?? timezone),
            amount: wrappedNetAmount(worstOffender)!,
            items: worstOffender.items.map((i) => i.name),
          }
        : undefined,
    };
  }

  /**
   * Calculate Laziest Day
   * Day with most orders (using user's local timezone)
   */
  private async calculateLaziestDay(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<LaziestDay | undefined> {
    const validReceipts = receipts.filter((r) => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Group by date in user's local timezone
    const dayGroups = new Map<string, ReceiptForAnalytics[]>();
    validReceipts.forEach((r) => {
      if (!r.orderDate) return;
      // Get the date string in user's timezone (YYYY-MM-DD)
      const dateKey = getLocalDateKey(r.orderDate, r.timezone ?? timezone);
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

    const dayOfWeek = this.getDayOfWeek(laziestDate);

    return {
      date: laziestDate,
      dayOfWeek,
      orderCount: laziestReceipts.length,
      ...wrappedSpending(laziestReceipts),
      restaurants: laziestReceipts.map((r: ReceiptForAnalytics) => r.restaurantName || 'Unknown'),
      message: `${laziestReceipts.length} orders in one day? Go outside.`,
    };
  }

  /**
   * Calculate Longest Streak
   * Consecutive days ordering (using user's local timezone)
   */
  private async calculateLongestStreak(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<LongestStreak | undefined> {
    const validReceipts = receipts.filter((r) => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Get unique dates in user's local timezone (sorted)
    const uniqueDates = Array.from(
      new Set(
        validReceipts
          .map((r) => {
            return getLocalDateKey(r.orderDate!, r.timezone ?? timezone);
          })
          .filter((d): d is string => d !== null),
      ),
    ).sort();

    if (uniqueDates.length < 3) return undefined; // Need at least 3 days

    // Find longest consecutive streak
    let longestStreak = 1;
    let currentStreak = 1;
    let streakStart = 0;
    let longestStreakStart = 0;

    for (let i = 1; i < uniqueDates.length; i++) {
      const prevDate = new Date(uniqueDates[i - 1]);
      const currDate = new Date(uniqueDates[i]);
      const daysDiff = Math.floor(
        (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24),
      );

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
    const streakReceipts = validReceipts.filter((r) => {
      const date = getLocalDateKey(r.orderDate!, r.timezone ?? timezone);
      if (!date) return false;
      return date >= startDate && date <= endDate;
    });

    return {
      days: longestStreak,
      startDate,
      endDate,
      ...wrappedSpending(streakReceipts),
      message: usesOrderEventMetrics(receipts)
        ? `${longestStreak} consecutive days with completed deliveries`
        : `${longestStreak} days straight without cooking`,
    };
  }

  /**
   * Calculate Single Item Orders
   * Orders with one standalone menu item under $20. A meal remains a
   * composite order even when the provider exports it as one purchased line.
   */
  private async calculateSingleItemOrders(
    receipts: ReceiptForAnalytics[],
  ): Promise<SingleItemOrders | undefined> {
    const eventMetrics = usesOrderEventMetrics(receipts);
    const singleOrders = receipts.filter(r => isSingleItemOrder(r, eventMetrics));

    if (singleOrders.length === 0) return undefined;

    const costs = wrappedSpending(singleOrders);
    const totalSpent = costs.totalSpent!; // The caller supplies one known currency.
    const averageAmount = totalSpent / singleOrders.length;

    // Find most common single item (excluding "Unknown")
    const itemCounts = new Map<string, number>();
    singleOrders.forEach((receipt) => {
      receipt.items.forEach((item) => {
        // Skip Unknown/invalid items when counting (case-insensitive)
        const itemName = singleItemDisplayName(receipt, item);
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
    [...itemCounts]
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([item, count]) => {
        if (count > maxCount) {
          maxCount = count;
          mostCommon = `${item} (${count} times)`;
        }
      });

    return {
      count: singleOrders.length,
      ...costs,
      averageAmount: parseFloat(averageAmount.toFixed(2)),
      message: usesOrderEventMetrics(receipts)
        ? 'Single-item restaurant deliveries with a recorded net cost under 20 in the displayed currency, after refunds'
        : `${singleOrders.length} times you couldn't just go get it`,
      mostCommon,
    };
  }

  /**
   * Calculate Chain Dependency
   * Major chain frequency
   */
  private async calculateChainDependency(
    receipts: ReceiptForAnalytics[],
  ): Promise<ChainDependency | undefined> {
    const majorChains = [
      "McDonald's",
      'Starbucks',
      'Chipotle',
      'Taco Bell',
      'Subway',
      "Dunkin'",
      "Wendy's",
      'Burger King',
      'KFC',
      'Chick-fil-A',
      'Popeyes',
      'Panera',
      "Jimmy John's",
      'Five Guys',
      'Shake Shack',
      'Tim Hortons',
      'Pizza Pizza',
      "Harvey's",
      'Swiss Chalet',
      "Mary Brown's",
      'A&W',
      'Booster Juice',
    ];

    const eventMetrics = usesOrderEventMetrics(receipts);
    const chainCounts = new Map<string, ReceiptForAnalytics[]>();

    receipts.forEach((r) => {
      if (!r.restaurantName) return;

      const restaurant = normalizeRestaurant(r.restaurantName);
      const chain = majorChains.find((c) =>
        eventMetrics
          ? restaurant?.key === normalizeRestaurant(c)?.key
          : r.restaurantName!.toLowerCase().includes(c.toLowerCase()),
      );

      if (chain) {
        const group = chainCounts.get(chain) ?? [];
        group.push(r);
        chainCounts.set(chain, group);
      }
    });

    if (chainCounts.size === 0) return undefined;

    // Sort by count
    const sortedChains = Array.from(chainCounts.entries())
      .map(([name, group]) => {
        const costs = wrappedSpending(group);
        return {
          name,
          count: group.length,
          spent: costs.totalSpent,
          ...(costs.spending ? { spending: costs.spending } : {}),
        };
      })
      // Frequency ties cannot be broken by incomparable or missing money.
      .sort(
        (a, b) =>
          b.count - a.count ||
          (eventMetrics ? 0 : (b.spent ?? 0) - (a.spent ?? 0)) ||
          a.name.localeCompare(b.name),
      );

    const worstOffender = sortedChains[0];
    const percentage = Math.round((worstOffender.count / receipts.length) * 100);

    return {
      worstOffender: worstOffender.name,
      orderCount: worstOffender.count,
      totalSpent: worstOffender.spent,
      ...(worstOffender.spending ? { spending: worstOffender.spending } : {}),
      percentage,
      message: `${percentage}% of your ${eventMetrics ? 'completed deliveries' : 'orders'} were ${worstOffender.name}`,
      allChains: sortedChains,
    };
  }

  /**
   * Calculate Most Expensive Order
   */
  private async calculateMostExpensiveOrder(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<MostExpensiveOrder | undefined> {
    if (receipts.length === 0) return undefined;

    const mostExpensive = receipts.reduce((max, r) => {
      const difference = wrappedNetAmount(r)! - wrappedNetAmount(max)!;
      return difference > 0 || (difference === 0 && compareReceiptTie(r, max) < 0) ? r : max;
    }, receipts[0]);

    return {
      amount: wrappedNetAmount(mostExpensive)!,
      ...(usesOrderEventMetrics(receipts)
        ? {
            currencyCode: currencyOf(mostExpensive),
            includesEstimates: receipts.some((r) => orderMetricEligibility(r).estimatedAmount),
          }
        : {}),
      restaurant: mostExpensive.restaurantName || 'Unknown',
      date: mostExpensive.orderDate
        ? getLocalDateKey(mostExpensive.orderDate, mostExpensive.timezone ?? timezone) || 'Unknown'
        : 'Unknown',
      items: mostExpensive.items.map((item) => ({
        name: item.name,
        price: usableItemUnitPrice(item, mostExpensive) ?? 0,
      })),
      message: usesOrderEventMetrics(receipts)
        ? `Highest net cost among your completed deliveries in ${currencyOf(mostExpensive)}`
        : `You once spent $${mostExpensive.amountSpent.toFixed(2)} on a single order`,
    };
  }

  /**
   * Calculate Coffee Addiction
   */
  private async calculateCoffeeAddiction(
    receipts: ReceiptForAnalytics[],
  ): Promise<CoffeeAddiction | undefined> {
    const eventMetrics = usesOrderEventMetrics(receipts);
    const coffeeOrders = receipts.filter(
      (r) =>
        (!eventMetrics ||
          normalizeRestaurant(r.restaurantName ?? undefined)?.merchantClass === 'restaurant') &&
        r.items.some((item) => classifyItemPersonality(item.name.toLowerCase()) === 'coffee'),
    );

    if (coffeeOrders.length === 0) return undefined;

    let totalSpent = 0;
    let pricedCoffeeItems = 0;

    // Find most ordered coffee drink
    const coffeeCounts = new Map<string, number>();
    coffeeOrders.forEach((r) => {
      r.items.forEach((item) => {
        if (classifyItemPersonality(item.name.toLowerCase()) === 'coffee') {
          const count = coffeeCounts.get(item.name) || 0;
          coffeeCounts.set(item.name, count + item.quantity);
          if (!eventMetrics) {
            const unitPrice = usableItemUnitPrice(item, r);
            if (unitPrice !== undefined) {
              totalSpent += unitPrice * item.quantity;
              pricedCoffeeItems += item.quantity;
            }
          }
        }
      });
    });

    let mostOrdered = 'Unknown';
    let maxCount = 0;
    [...coffeeCounts]
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([item, count]) => {
        if (count > maxCount) {
          maxCount = count;
          mostOrdered = `${item} (${count} times)`;
        }
      });

    return {
      orderCount: coffeeOrders.length,
      totalSpent: eventMetrics ? null : parseFloat(totalSpent.toFixed(2)),
      averagePrice: eventMetrics
        ? null
        : pricedCoffeeItems > 0 ? parseFloat((totalSpent / pricedCoffeeItems).toFixed(2)) : null,
      mostOrdered,
      message: eventMetrics
        ? `${coffeeOrders.length} completed restaurant deliveries included coffee items`
        : `You spent $${totalSpent.toFixed(2)} on coffee items`,
      ...(eventMetrics
        ? {
            disclaimer:
              'Items ordered, not verified consumption. Discounts, fees and refunds cannot be allocated to coffee alone.',
          }
        : {}),
    };
  }

  /**
   * Calculate Night Owl Badge using the shared 10pm–4am local window.
   */
  private async calculateNightOwl(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<NightOwl | undefined> {
    const validReceipts = receipts.filter((r) => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    const nightOrders = validReceipts.filter((r) => {
      const hour = getLocalHour(r.orderDate!, r.timezone ?? timezone);
      return isLateNightHour(hour);
    });
    if (nightOrders.length === 0) return undefined;

    const percentage = Math.round((nightOrders.length / validReceipts.length) * 100);

    // Find latest order (by hour in user's timezone)
    const latest = nightOrders.reduce((latest, r) => {
      const rMinute = getLocalMinuteOfDay(r.orderDate!, r.timezone ?? timezone) ?? -1;
      const latestMinute =
        getLocalMinuteOfDay(latest.orderDate!, latest.timezone ?? timezone) ?? -1;
      const difference = overnightMinute(rMinute) - overnightMinute(latestMinute);
      return difference > 0 || (difference === 0 && compareReceiptTie(r, latest) < 0) ? r : latest;
    }, nightOrders[0]);

    const formatLocalTime = (date: Date, eventTimezone = timezone) =>
      formatTimeInTimezone(date, eventTimezone) || 'Unknown';

    return {
      percentage,
      count: nightOrders.length,
      ...wrappedSpending(nightOrders),
      latestOrder: formatLocalTime(latest.orderDate!, latest.timezone ?? timezone),
      message: `${percentage}% of your orders were between 10pm and 4am`,
    };
  }

  /**
   * Calculate Spent This Year
   * Total spending for the current calendar year (in user's local timezone)
   */
  private async calculateSpentThisYear(
    receipts: ReceiptForAnalytics[],
    timezone: string,
    eventMetrics = usesOrderEventMetrics(receipts),
  ): Promise<SpentThisYear | undefined> {
    // Get current year in user's timezone
    const now = new Date();
    const currentYear = getLocalYear(now, timezone) ?? now.getUTCFullYear();

    // Filter receipts from current year (comparing UTC dates, but year is determined by local timezone)
    const thisYearReceipts = receipts.filter((r) => {
      if (!r.orderDate) return false;
      const receiptYear = getLocalYear(r.orderDate, r.timezone ?? timezone);
      return receiptYear === currentYear;
    });

    if (thisYearReceipts.length === 0) return undefined;

    const costs = wrappedSpending(thisYearReceipts, eventMetrics);
    const orderCount = thisYearReceipts.length;

    return {
      ...costs,
      year: currentYear,
      orderCount,
      averagePerOrder:
        costs.totalSpent === null ? null : Number((costs.totalSpent / orderCount).toFixed(2)),
      message: eventMetrics
        ? `Net costs for ${orderCount} established order attempts this year, including charged cancellations and wallet payments`
        : `You've spent $${costs.totalSpent!.toFixed(2)} on delivery this year`,
    };
  }

  /**
   * Calculate Could Have Bought
   */
  private async calculateCouldHaveBought(
    _receipts: ReceiptForAnalytics[],
  ): Promise<CouldHaveBought | undefined> {
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
  private async calculateMissedInvestment(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<MissedInvestment | undefined> {
    const validReceipts = receipts
      .map((r) => ({ ...r, amountSpent: wrappedNetAmount(r) ?? NaN }))
      .filter((r) => r.orderDate && Number.isFinite(r.amountSpent) && r.amountSpent > 0)
      .sort((a, b) => a.orderDate!.getTime() - b.orderDate!.getTime());

    if (validReceipts.length === 0) return undefined;

    const firstOrder = validReceipts[0];
    const now = new Date();
    const daysElapsed = Math.floor(
      (now.getTime() - firstOrder.orderDate!.getTime()) / (1000 * 60 * 60 * 24),
    );

    const sp500Return = HYPOTHETICAL_ANNUAL_RETURN_PERCENT;
    const investment = calculateHypotheticalInvestment(
      validReceipts.map((receipt) => ({
        amount: receipt.amountSpent,
        occurredAt: receipt.orderDate!,
      })),
      now,
    );
    const totalSpent = investment.contributed;
    const wouldBeWorth = investment.futureValue;
    const missedGains = investment.gains;

    return {
      amountSpent: parseFloat(totalSpent.toFixed(2)),
      firstOrderDate:
        getLocalDateKey(firstOrder.orderDate!, firstOrder.timezone ?? timezone) ||
        firstOrder.orderDate!.toISOString().split('T')[0],
      daysElapsed,
      sp500Return,
      wouldBeWorth: parseFloat(wouldBeWorth.toFixed(2)),
      missedGains: parseFloat(missedGains.toFixed(2)),
      message: `At a hypothetical ${sp500Return}% annual return, it could have grown to $${wouldBeWorth.toFixed(2)}`,
    };
  }

  /**
   * Cost-per-meal requires explicit fee, tax, tip, promotion, and item subtotal
   * fields. It remains omitted until the receipt model can represent them.
   */
  private async calculateCostPerMeal(
    _receipts: ReceiptForAnalytics[],
  ): Promise<CostPerMeal | undefined> {
    // Order total minus item subtotal is not a delivery fee: it also mixes tax,
    // tips, service fees, promotions, and substitutions. The current receipt
    // model does not store those components, so do not publish a false metric.
    return undefined;
  }

  private async calculateDeliveryFeeTrend(
    receipts: ReceiptForAnalytics[],
    timezone = 'UTC',
  ): Promise<DeliveryFeeTrend | undefined> {
    const eventMetrics = usesOrderEventMetrics(receipts);
    const qualifying = receipts
      .filter((receipt) => {
        if (!eventMetrics) return true;
        const outcome = receipt.resolution?.orderOutcome;
        // A basket refund does not establish which fee was refunded. Only use
        // unadjusted completed orders with a confirmed original/net balance.
        return (
          orderMetricEligibility(receipt).delivered &&
          outcome?.financialConfidence === 'confirmed' &&
          outcome.refundStatus === 'none_established' &&
          outcome.originalCharge !== null &&
          outcome.originalCharge === outcome.netAmount
        );
      })
      .filter(
        (
          receipt,
        ): receipt is ReceiptForAnalytics & {
          orderDate: Date;
          currencyCode: string;
          deliveryFee: number;
          serviceFee: number;
        } =>
          Boolean(
            receipt.orderDate &&
            receipt.currencyCode &&
            receipt.currencyCode !== 'UNKNOWN' &&
            Number.isFinite(receipt.deliveryFee) &&
            Number.isFinite(receipt.serviceFee) &&
            receipt.deliveryFee! >= 0 &&
            receipt.serviceFee! >= 0,
          ),
      )
      .sort((left, right) => left.orderDate.getTime() - right.orderDate.getTime());
    if (qualifying.length < 6) return undefined;
    const currencies = new Set(qualifying.map((receipt) => receipt.currencyCode));
    if (currencies.size !== 1) return undefined;
    const firstOrder = qualifying[0].orderDate;
    const lastOrder = qualifying[qualifying.length - 1].orderDate;
    if (lastOrder.getTime() - firstOrder.getTime() < 90 * 24 * 60 * 60 * 1000) return undefined;

    const groups = new Map<string, typeof qualifying>();
    for (const receipt of qualifying) {
      const day = getLocalDateKey(
        receipt.orderDate,
        receipt.resolution?.timestamp?.timezone ?? receipt.timezone ?? timezone,
      )!;
      const quarter = `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
      groups.set(quarter, [...(groups.get(quarter) ?? []), receipt]);
    }
    const series: FeePeriod[] = [...groups.entries()]
      .filter(([, values]) => values.length >= 3)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([quarter, values]) => {
        const averageDeliveryFee =
          values.reduce((sum, receipt) => sum + receipt.deliveryFee, 0) / values.length;
        const averageServiceFee =
          values.reduce((sum, receipt) => sum + receipt.serviceFee, 0) / values.length;
        return {
          quarter,
          orderCount: values.length,
          averageDeliveryFee: Number(averageDeliveryFee.toFixed(2)),
          averageServiceFee: Number(averageServiceFee.toFixed(2)),
          averageCompanyFees: Number((averageDeliveryFee + averageServiceFee).toFixed(2)),
        };
      });
    if (series.length < 2) return undefined;
    const included = [...groups.values()]
      .filter((values) => values.length >= 3)
      .flat()
      .sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime());
    const earliestPeriod = series[0];
    const latestPeriod = series[series.length - 1];
    if (earliestPeriod.averageDeliveryFee <= 0 || earliestPeriod.averageCompanyFees <= 0)
      return undefined;
    const percentChange = (latest: number, earliest: number): number =>
      Number((((latest - earliest) / earliest) * 100).toFixed(1));
    const deliveryFeeChangePercent = percentChange(
      latestPeriod.averageDeliveryFee,
      earliestPeriod.averageDeliveryFee,
    );
    const companyFeeChangePercent = percentChange(
      latestPeriod.averageCompanyFees,
      earliestPeriod.averageCompanyFees,
    );
    const trend =
      companyFeeChangePercent > 2
        ? 'increased'
        : companyFeeChangePercent < -2
          ? 'decreased'
          : 'flat';
    return {
      currency: qualifying[0].currencyCode,
      ...(eventMetrics ? { basis: 'unadjusted_deliveries' as const } : {}),
      coveredOrderCount: included.length,
      coverageStart: included[0].orderDate.toISOString(),
      coverageEnd: included[included.length - 1].orderDate.toISOString(),
      earliestPeriod,
      latestPeriod,
      deliveryFeeChangePercent,
      companyFeeChangePercent,
      trend,
      series,
    };
  }

  /**
   * Calculate Peak Hunger Hour (in user's local timezone)
   */
  private async calculatePeakHungerHour(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<PeakHungerHour | undefined> {
    const validReceipts = receipts.filter((r) => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    // Group by hour in user's local timezone
    const hourCounts = new Map<number, number>();
    validReceipts.forEach((r) => {
      const hour = getLocalHour(r.orderDate!, r.timezone ?? timezone);
      if (hour !== null) {
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
      }
    });

    // Find peak hour
    let peakHour = 0;
    let maxCount = 0;
    hourCounts.forEach((count, hour) => {
      if (count > maxCount || (count === maxCount && hour < peakHour)) {
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
      message: usesOrderEventMetrics(receipts)
        ? `Your most common placement hour for completed deliveries is ${this.formatHour(peakHour)}`
        : `You're hungriest at ${this.formatHour(peakHour)}`,
    };
  }

  /**
   * Calculate Delivery Waits (DoorDash and Uber Eats)
   * Calculates total and average time spent waiting for deliveries
   */
  private async calculateDeliveryWaits(
    receipts: ReceiptForAnalytics[],
  ): Promise<DeliveryWaits | undefined> {
    // Calculate for DoorDash and Uber Eats receipts that have both order date and delivery time
    const receiptsWithWaitTime = receipts.filter(
      (r) =>
        (r.receiptType === 'doordash' || r.receiptType === 'uber_eats') &&
        r.orderDate &&
        r.deliveryTime,
    );

    if (receiptsWithWaitTime.length === 0) {
      return undefined;
    }

    // Calculate wait time for each order (in minutes)
    const waitTimes: Array<{
      receipt: ReceiptForAnalytics;
      minutes: number;
    }> = [];

    receiptsWithWaitTime.forEach((receipt) => {
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
      current.minutes > longest.minutes ||
      (current.minutes === longest.minutes &&
        compareReceiptTie(current.receipt, longest.receipt) < 0)
        ? current
        : longest,
    );

    // Find fastest delivery
    const fastestDelivery = waitTimes.reduce((fastest, current) =>
      current.minutes < fastest.minutes ||
      (current.minutes === fastest.minutes &&
        compareReceiptTie(current.receipt, fastest.receipt) < 0)
        ? current
        : fastest,
    );

    return {
      totalMinutes,
      averageMinutes,
      totalOrders: waitTimes.length,
      longestWait: {
        minutes: longestWait.minutes,
        restaurant: longestWait.receipt.restaurantName || 'Unknown',
        amount: wrappedNetAmount(longestWait.receipt),
        ...(usesOrderEventMetrics(receipts)
          ? { currencyCode: currencyOf(longestWait.receipt) }
          : {}),
        message: usesOrderEventMetrics(receipts)
          ? `Longest recorded placement-to-delivery interval: ${longestWait.minutes} minutes at ${longestWait.receipt.restaurantName || 'Unknown'}`
          : `Your longest wait was ${longestWait.minutes} minutes for ${longestWait.receipt.restaurantName || 'Unknown'}`,
      },
      fastestDelivery: {
        minutes: fastestDelivery.minutes,
        restaurant: fastestDelivery.receipt.restaurantName || 'Unknown',
      },
    };
  }

  /**
   * Calculate Weekend Warrior (using user's local timezone)
   */
  private async calculateWeekendWarrior(
    receipts: ReceiptForAnalytics[],
    timezone: string,
  ): Promise<WeekendWarrior | undefined> {
    const validReceipts = receipts.filter((r) => r.orderDate);
    if (validReceipts.length === 0) return undefined;

    if (usesOrderEventMetrics(receipts)) {
      const isWeekend = (receipt: ReceiptForAnalytics) => {
        const day = getLocalDay(receipt.orderDate!, receipt.timezone ?? timezone);
        return day === 0 || day === 6;
      };
      const weekend = validReceipts.filter(isWeekend);
      const weekday = validReceipts.filter((r) => !isWeekend(r));
      const weekendCosts = wrappedSpending(weekend, true);
      const weekdayCosts = wrappedSpending(weekday, true);
      const ratio = weekday.length > 0 ? weekend.length / 2 / (weekday.length / 5) : null;
      return {
        weekendOrders: weekend.length,
        weekdayOrders: weekday.length,
        weekendSpending: weekendCosts.totalSpent,
        weekdaySpending: weekdayCosts.totalSpent,
        weekendCosts: weekendCosts.spending,
        weekdayCosts: weekdayCosts.spending,
        ratio: ratio === null ? null : Number(ratio.toFixed(2)),
        ratioBasis: 'deliveries_per_day',
        message:
          'Completed deliveries, normalized across two weekend days and five weekdays. Imported history may not cover every day.',
      };
    }

    let weekendOrders = 0;
    let weekdayOrders = 0;
    let weekendSpending = 0;
    let weekdaySpending = 0;

    validReceipts.forEach((r) => {
      const day = getLocalDay(r.orderDate!, r.timezone ?? timezone);
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
    const ratio =
      weekdayDailySpending > 0
        ? weekendDailySpending / weekdayDailySpending
        : weekendDailySpending > 0
          ? 5
          : 0;
    const message = ratio > 1 ? 'Weekend delivery champion' : 'You spend more per day on weekdays';

    return {
      weekendOrders,
      weekdayOrders,
      weekendSpending: parseFloat(weekendSpending.toFixed(2)),
      weekdaySpending: parseFloat(weekdaySpending.toFixed(2)),
      ratio: parseFloat(ratio.toFixed(2)),
      message,
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
      patterns: {},
    };
  }
}

/** Orchestrates analytics queries while delegating all formulas to the pure calculator. */
export class WrappedAnalyticsService {
  private static readonly PERCENTILE_MIN_RECEIPTS = 3;
  private static readonly PERCENTILE_MIN_SAMPLE = 100;

  constructor(
    private readonly queries: WrappedAnalyticsQueryPort,
    private readonly log?: WrappedAnalyticsLogPort,
    private readonly calculator: WrappedAnalyticsCalculator = new WrappedAnalyticsCalculator(),
  ) {}

  async calculateWrappedAnalytics(
    userId: string,
    snapshot?: WrappedReceiptSnapshot,
  ): Promise<WrappedAnalytics> {
    if (snapshot?.receipts.some((receipt) => receipt.userId !== userId))
      throw new Error('Analytics snapshot belongs to another account');
    const [timezone, receipts] = snapshot
      ? [snapshot.timezone, snapshot.receipts.map(projectReceiptForAnalytics)]
      : await Promise.all([
          this.queries.getUserTimezone(userId),
          this.queries.getUserReceipts(userId),
        ]);
    const target = usesOrderEventMetrics(receipts)
      ? buildOrderComparisonProfile(receipts, timezone)
      : undefined;
    const percentiles = await this.calculatePercentiles(userId, target);
    const result = await this.calculator.calculate(receipts, timezone, percentiles, snapshot?.market);
    const coverage = await this.queries.getRecapCoverage?.(userId) ?? [];
    result.recap = buildRecapStories(receipts, timezone, snapshot?.displayCurrency ?? 'CAD', snapshot?.rates ?? { id: 'unavailable', date: '', rates: {} }, result, coverage);
    return result;
  }

  private async calculatePercentiles(
    userId: string,
    target?: OrderComparisonProfile,
  ): Promise<WrappedPercentiles | undefined> {
    try {
      const row = await this.queries.getPercentileRanks(
        userId,
        WrappedAnalyticsService.PERCENTILE_MIN_RECEIPTS,
        target,
      );
      if (row?.policyVersion === 3) {
        const standing = (rank: OrderComparisonRank | null): PercentileStanding | undefined => {
          if (!rank || rank.sampleSize < WrappedAnalyticsService.PERCENTILE_MIN_SAMPLE)
            return undefined;
          const percentile = Math.floor((rank.lowerCount * 100) / rank.sampleSize);
          return { percentile, topPercent: 100 - percentile, sampleSize: rank.sampleSize };
        };
        const totalSpent = standing(row.totalSpent),
          orderCount = standing(row.orderCount),
          nightOwl = standing(row.nightOwl);
        const sizes = [totalSpent, orderCount, nightOwl].flatMap((value) =>
          value?.sampleSize === undefined ? [] : [value.sampleSize],
        );
        if (!sizes.length) return undefined;
        const measures = [
          totalSpent ? `net order costs in ${row.currencyCode}` : undefined,
          orderCount ? 'completed deliveries' : undefined,
          nightOwl ? 'late-night share among explicitly timed deliveries' : undefined,
        ]
          .filter(Boolean)
          .join('; ');
        return {
          policyVersion: 3,
          sampleSize: Math.max(...sizes),
          currencyCode: row.currencyCode,
          totalSpent,
          orderCount,
          nightOwl,
          methodology:
            `Separate groups of accounts with at least 3 comparable records and at least 100 accounts per comparison: ${measures}. Imported history is not necessarily complete. ${totalSpent && row.estimatedNetCost ? 'Net-cost comparisons include recorded/export estimates.' : ''}`.trim(),
        };
      }
      if (!row || row.sampleSize < WrappedAnalyticsService.PERCENTILE_MIN_SAMPLE) {
        return undefined;
      }

      const standing = (rank: number): PercentileStanding => {
        const fraction = Math.max(0, Math.min(1, rank));
        return {
          percentile: Math.round(fraction * 100),
          topPercent: Math.min(100, Math.max(1, Math.round((1 - fraction) * 100))),
        };
      };
      return {
        sampleSize: row.sampleSize,
        totalSpent: standing(row.spentRank),
        orderCount: standing(row.ordersRank),
        nightOwl: standing(row.nightOwlRank),
      };
    } catch (error) {
      this.log?.warn('Wrapped percentile calculation unavailable', {
        operation: 'wrapped_percentiles',
        outcome: 'failed',
        error,
      });
      return undefined;
    }
  }
}
