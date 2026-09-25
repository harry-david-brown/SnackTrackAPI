import { calculateHistoricalInvestment, BENCHMARK_NAMES, INVESTMENT_METHODOLOGY, type InvestmentContext } from '../shared/historicalInvestment';
import {
  NormalizedReceipt,
  DashboardDataset,
  ItemFamily,
  dashboardCohort,
  hasExportSource,
  normalizeItem,
} from './normalization';
import { orderMetricEligibility, summarizeOrderMetrics } from '../shared/orderMetrics';
import { merchantIdentity } from '../../receipt/ReceiptResolutionService';
import { matchesReceiptOutcome } from '../../receipt/ReceiptHistoryFilters';
import { DashboardInsight, InsightCandidate, SuppressedCandidate } from './types';
import { isLateNightHour } from '../shared/timeWindows';
import {
  GENERIC_ITEM_PUNCHLINES,
  getItemPersonality,
  ItemPersonalityFamily,
} from './itemPersonalities';
import { stableHash } from './hash';
import { extractDippingSauceLabels } from './sauceNormalization';
import {
  calculateHypotheticalInvestment,
  HYPOTHETICAL_ANNUAL_RETURN_PERCENT,
} from '../shared/investment';

export interface CandidateCatalogue {
  eligible: InsightCandidate[];
  suppressed: SuppressedCandidate[];
}

const DAY_MS = 86_400_000;
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const roundOne = (value: number) => Math.round(value * 10) / 10;
const dateOrdinal = (date: string) => Math.floor(Date.parse(`${date}T00:00:00.000Z`) / DAY_MS);
const daysBetween = (start: string, end: string) => dateOrdinal(end) - dateOrdinal(start);
const shiftLocalDate = (date: string, days: number) =>
  new Date((dateOrdinal(date) + days) * DAY_MS).toISOString().slice(0, 10);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const orderIds = (receipts: readonly NormalizedReceipt[]) =>
  [...new Set(receipts.flatMap((receipt) => (receipt.source.id ? [receipt.source.id] : [])))];
const evidenceItems = (receipt: NormalizedReceipt) => [
  ...receipt.items,
  ...receipt.source.items
    .flatMap((item) => item.evidence?.components ?? [])
    .map((component) => normalizeItem({ name: component.name, quantity: component.quantity, price: 0 }))
    .filter((item): item is NonNullable<typeof item> => Boolean(item)),
];
// These values are already event-local calendar days, not UTC instants to convert again.
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00.000Z`));

interface FoodflationStory {
  key: string;
  kind: 'meal' | 'item';
  name: string;
  restaurant?: string;
  observations: Array<{ amount: number; date: string; orderId: string }>;
  relatedFamilies: string[];
}

function basketSummary(receipt: NormalizedReceipt) {
  const visible = receipt.items
    .slice(0, 3)
    .map((item) => `${item.quantity > 1 ? `${item.quantity}× ` : ''}${item.label}`);
  const remaining = receipt.items.length - visible.length;
  return `${visible.join(' + ')}${remaining > 0 ? ` + ${remaining} more` : ''}`;
}

function foodflationCandidate(story: FoodflationStory): InsightCandidate | null {
  const first = story.observations[0];
  const latest = story.observations.at(-1)!;
  if (first.amount <= 0) return null;
  const change = latest.amount - first.amount;
  const minimumChange = story.kind === 'meal' ? 2 : 1;
  const percentDelta = Math.round((change / first.amount) * 100);
  if (Math.abs(change) < minimumChange || Math.abs(percentDelta) < 10) return null;
  const direction = change > 0 ? 'up' : 'down';
  const subjectLabel = story.kind === 'meal' ? 'order' : 'item';
  const insight: DashboardInsight = {
    id: `foodflation-${story.kind}-${stableHash(story.key).toString(36)}`,
    presentation: 'comparison',
    category: 'progress',
    icon: 'trend',
    eyebrow: 'Observed price change',
    title: `The same ${subjectLabel} costs ${Math.abs(percentDelta)}% ${direction === 'up' ? 'more' : 'less'}`,
    period: { startDate: first.date, endDate: latest.date },
    comparison: {
      current: roundMoney(latest.amount),
      previous: roundMoney(first.amount),
      delta: roundMoney(change),
      percentDelta,
      direction,
      valueFormat: 'currency',
      currentLabel: 'Recent price',
      previousLabel: 'Earlier price',
      subject: {
        kind: story.kind,
        name: story.name,
        restaurant: story.restaurant,
        occurrences: story.observations.length,
      },
    },
    methodology: { sampleSize: story.observations.length },
  };
  return {
    insight,
    orderIds: [...new Set(story.observations.map((observation) => observation.orderId))],
    facts: extractFacts(insight),
    copy: { eyebrow: insight.eyebrow, title: insight.title, detail: insight.detail },
    family: 'foodflation',
    // Price comparisons are self-explanatory; keep the evidence count and order drill-down
    // without adding a rotating explanatory paragraph below the values.
    copyVariants: [],
    relatedFamilies: story.relatedFamilies,
    score:
      86 +
      Math.min(6, Math.floor(Math.abs(percentDelta) / 15)) +
      Math.min(2, story.observations.length - 2),
  };
}

function extractFacts(insight: DashboardInsight): InsightCandidate['facts'] {
  if (insight.presentation === 'hero')
    return {
      value: insight.value,
      valueFormat: insight.valueFormat,
      headline: insight.headline ?? null,
    };
  if (insight.presentation === 'comparison')
    return {
      current: insight.comparison.current,
      previous: insight.comparison.previous,
      delta: insight.comparison.delta,
      percentDelta: insight.comparison.percentDelta,
      direction: insight.comparison.direction,
    };
  if (insight.presentation === 'ranking')
    return {
      rowCount: insight.rows.length,
      totalOrders: sum(insight.rows.map((row) => row.count)),
      totalAmount: roundMoney(sum(insight.rows.map((row) => row.amount ?? 0))),
    };
  if (insight.presentation === 'order')
    return {
      restaurant: insight.order.restaurant,
      restaurantCount: insight.order.restaurants?.length ?? 1,
      amount: insight.order.amount,
      itemCount: insight.order.items.length,
    };
  if (insight.presentation === 'timeline') return { eventCount: insight.events.length };
  if (insight.presentation === 'yearly-champions')
    return {
      yearCount: insight.years.length,
      winnerCount: new Set(insight.years.flatMap((year) => year.winners)).size,
    };
  return { action: insight.action };
}

function add(
  eligible: InsightCandidate[],
  insight: DashboardInsight,
  family: string,
  score: number,
  options: Partial<InsightCandidate> = {},
) {
  const copy = { eyebrow: insight.eyebrow, title: insight.title, detail: insight.detail };
  eligible.push({ insight, facts: extractFacts(insight), copy, family, score, ...options });
}

function rankedInsightId(id: string, index: number): string {
  return index === 0 ? id : `${id}-rank-${index + 1}`;
}

function rankLabel(index: number): string {
  return ['First', 'Second', 'Third'][index];
}

function restaurantStats(dataset: DashboardDataset) {
  return [...dataset.byRestaurant.entries()]
    .map(([key, receipts]) => ({
      key,
      label: receipts[0]?.restaurantLabel ?? key,
      receipts,
      count: receipts.length,
      amount: sum(receipts.map((receipt) => receipt.amount)),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (dataset.orderMetrics ? 0 : b.amount - a.amount) ||
        a.label.localeCompare(b.label),
    );
}

function describeDriver(
  current: NormalizedReceipt[],
  previous: NormalizedReceipt[],
): 'frequency' | 'basket' | 'outlier' | 'mixed' {
  const countRatio = current.length / previous.length;
  const currentAverage = sum(current.map((receipt) => receipt.amount)) / current.length;
  const previousAverage = sum(previous.map((receipt) => receipt.amount)) / previous.length;
  const averageRatio = currentAverage / previousAverage;
  const currentMax = Math.max(...current.map((receipt) => receipt.amount));
  if (
    currentMax > currentAverage * 2.5 &&
    currentMax > Math.max(...previous.map((receipt) => receipt.amount)) * 1.35
  )
    return 'outlier';
  if (Math.abs(countRatio - 1) >= Math.abs(averageRatio - 1) + 0.12) return 'frequency';
  if (Math.abs(averageRatio - 1) >= Math.abs(countRatio - 1) + 0.12) return 'basket';
  return 'mixed';
}

function comparisonCandidate(
  id: string,
  title: string,
  current: NormalizedReceipt[],
  previous: NormalizedReceipt[],
  currentLabel: string,
  previousLabel: string,
  costBasis: 'legacy' | 'net-cost',
): InsightCandidate | null {
  if (current.length < 3 || previous.length < 3) return null;
  const currentTotal = roundMoney(sum(current.map((receipt) => receipt.amount)));
  const previousTotal = roundMoney(sum(previous.map((receipt) => receipt.amount)));
  if (previousTotal < 20) return null;
  const delta = roundMoney(currentTotal - previousTotal);
  const percentDelta = Math.round((delta / previousTotal) * 100);
  if (Math.abs(percentDelta) < 8) return null;
  const driver = describeDriver(current, previous);
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const driverCopy =
    costBasis === 'net-cost'
      ? 'Describes net costs per established attempt, including any cancellations and refunds; it does not measure food quantity.'
      : driver === 'frequency'
        ? 'The number of orders moved the most.'
        : driver === 'basket'
          ? 'Your average order size did most of the moving.'
          : driver === 'outlier'
            ? 'One unusually large order had a starring role.'
            : 'Both order frequency and basket size pitched in.';
  const insight: DashboardInsight = {
    id,
    presentation: 'comparison',
    category: 'progress',
    icon: 'trend',
    eyebrow:
      costBasis === 'net-cost'
        ? 'Net order costs'
        : direction === 'down'
          ? 'Plot twist: progress'
          : 'Spending momentum',
    title,
    detail: `${Math.abs(percentDelta)}% ${direction === 'down' ? 'less' : 'more'} than the comparison period. ${driverCopy}`,
    comparison: {
      current: currentTotal,
      previous: previousTotal,
      delta,
      percentDelta,
      direction,
      valueFormat: 'currency',
      currentLabel,
      previousLabel,
      driver,
    },
    methodology: { sampleSize: current.length + previous.length },
  };
  return {
    family: 'spending-movement',
    relatedFamilies: ['order-frequency', 'average-basket'],
    score: direction === 'down' ? 96 : 91,
    timely: true,
    orderIds: orderIds([...current, ...previous]),
    insight,
    facts: extractFacts(insight),
    copy: { eyebrow: insight.eyebrow, title: insight.title, detail: insight.detail },
  };
}

function localPeriodWindows(dataset: DashboardDataset) {
  const today = new Date(`${dataset.localDate}T00:00:00.000Z`);
  const todayOrdinal = dateOrdinal(dataset.localDate);
  const rollingCurrentStart = todayOrdinal - 30;
  const rollingPreviousStart = todayOrdinal - 60;
  const rollingCurrent = dataset.dated.filter((receipt) => {
    const ordinal = dateOrdinal(receipt.localDate!);
    return ordinal >= rollingCurrentStart && ordinal < todayOrdinal;
  });
  const rollingPrevious = dataset.dated.filter((receipt) => {
    const ordinal = dateOrdinal(receipt.localDate!);
    return ordinal >= rollingPreviousStart && ordinal < rollingCurrentStart;
  });

  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const elapsedDay = today.getUTCDate();
  const currentMonthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const priorMonthDate = new Date(Date.UTC(year, month - 1, 1));
  const priorPrefix = `${priorMonthDate.getUTCFullYear()}-${String(priorMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const priorLastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const priorEndDay = Math.min(elapsedDay, priorLastDay);
  const mtdCurrent = dataset.dated.filter(
    (receipt) =>
      receipt.localDate!.startsWith(currentMonthPrefix) &&
      Number(receipt.localDate!.slice(8, 10)) <= elapsedDay,
  );
  const mtdPrevious = dataset.dated.filter(
    (receipt) =>
      receipt.localDate!.startsWith(priorPrefix) &&
      Number(receipt.localDate!.slice(8, 10)) <= priorEndDay,
  );
  return { rollingCurrent, rollingPrevious, mtdCurrent, mtdPrevious, elapsedDay };
}

function addMerchantFavorites(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  const restaurants = restaurantStats(dataset);
  if (restaurants.length) {
    add(
      eligible,
      {
        id: 'top-restaurants',
        presentation: 'ranking',
        category: 'favorites',
        icon: 'restaurant',
        eyebrow: 'Your regulars',
        title: 'The podium',
        detail: dataset.orderMetrics
          ? 'Your most frequent merchants among completed deliveries, including grocery and other categories.'
          : 'Your three most-ordered restaurant brands, with the damage included.',
        rows: restaurants.slice(0, 3).map((restaurant) => ({
          label: restaurant.label,
          count: restaurant.count,
          amount:
            !dataset.orderMetrics ||
            (dataset.currencyCode !== 'UNKNOWN' && restaurant.receipts.every((r) => r.amountKnown))
              ? roundMoney(restaurant.amount)
              : undefined,
        })),
      },
      'restaurant-ranking',
      68,
      { orderIds: orderIds(restaurants.slice(0, 3).flatMap((restaurant) => restaurant.receipts)) },
    );
    const top = restaurants[0];
    if ((dataset.orderMetrics ? dataset.receipts : dataset.positive).length >= 3)
      add(
        eligible,
        {
          id: 'restaurant-loyalty',
          presentation: 'hero',
          category: 'favorites',
          icon: 'heart',
          eyebrow: 'Creature of habit',
          title: 'Your number one',
          headline: top.label,
          value: Math.round((top.count / dataset.receipts.length) * 100),
          valueFormat: 'percent',
          detail: `${top.count} tracked orders. At this point, they may recognize your cart.`,
        },
        'restaurant-loyalty',
        72,
        { relatedFamilies: ['restaurant-ranking'], orderIds: orderIds(top.receipts) },
      );
  }
}

function addCalendarHabits(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  if (dataset.dated.length >= 3) {
    const weekdays = new Map<string, number>();
    const hours = new Map<number, number>();
    const months = new Map<string, number>();
    let night = 0;
    for (const receipt of dataset.dated) {
      weekdays.set(receipt.weekday!, (weekdays.get(receipt.weekday!) ?? 0) + 1);
      if (receipt.hour !== undefined) hours.set(receipt.hour, (hours.get(receipt.hour) ?? 0) + 1);
      months.set(receipt.localMonth!, (months.get(receipt.localMonth!) ?? 0) + 1);
      if (isLateNightHour(receipt.hour)) night += 1;
    }
    const favoriteDay = [...weekdays].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const rankedWeekdays = [...weekdays].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const favoriteDayShare = Math.round((favoriteDay[1] / dataset.dated.length) * 100);
    add(
      eligible,
      {
        id: 'favorite-day',
        presentation: 'hero',
        category: 'habits',
        icon: 'calendar',
        eyebrow: 'Weekly ritual',
        title: 'Your delivery day',
        headline: favoriteDay[0],
        value: favoriteDay[1],
        valueFormat: 'number',
        detail: `${favoriteDay[1]} tracked orders landed on ${favoriteDay[0]}s—${favoriteDayShare}% of your dated history.`,
      },
      'weekday',
      55,
      {
        subjectGroup: 'weekday-distribution',
        orderIds: orderIds(dataset.dated.filter((receipt) => receipt.weekday === favoriteDay[0])),
      },
    );
    if (rankedWeekdays.length >= 2)
      add(
        eligible,
        {
          id: 'weekday-podium',
          presentation: 'ranking',
          category: 'habits',
          icon: 'calendar',
          eyebrow: 'Weekly ritual',
          title: 'Your top delivery days',
          detail: 'The first, second, and third places on your weekly delivery calendar.',
          rows: rankedWeekdays.slice(0, 3).map(([label, count]) => ({ label, count })),
        },
        'weekday',
        60,
        {
          subjectGroup: 'weekday-distribution',
          orderIds: orderIds(dataset.dated.filter((receipt) => rankedWeekdays.slice(0, 3).some(([weekday]) => weekday === receipt.weekday))),
        },
      );
    const peakHour = [...hours].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const rankedHours = [...hours].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const timedCount = sum([...hours.values()]);
    if (peakHour && timedCount >= 3) {
      const hourLabel = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: true,
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(2020, 0, 1, peakHour[0])));
      const peakHourShare = Math.round((peakHour[1] / timedCount) * 100);
      add(
        eligible,
        {
          id: 'peak-hunger-hour',
          presentation: 'hero',
          category: 'habits',
          icon: 'time',
          eyebrow: dataset.orderMetrics ? 'Ordering hours' : 'Peak hunger',
          title: 'The order o’clock',
          headline: hourLabel,
          value: peakHour[1],
          valueFormat: 'number',
          detail: `${peakHour[1]} tracked orders started in this hour—${peakHourShare}% of orders with a recorded placement time.`,
        },
        'order-time',
        57,
        {
          subjectGroup: 'hour-distribution',
          orderIds: orderIds(dataset.dated.filter((receipt) => receipt.hour === peakHour[0])),
        },
      );
      if (rankedHours.length >= 2)
        add(
          eligible,
          {
            id: 'hunger-hour-podium',
            presentation: 'ranking',
            category: 'habits',
            icon: 'time',
            eyebrow: dataset.orderMetrics ? 'Ordering hours' : 'Peak hunger',
            title: 'Your top ordering hours',
            detail: 'Your three busiest clock hours for starting an order.',
            rows: rankedHours.slice(0, 3).map(([hour, count]) => ({
              label: new Intl.DateTimeFormat('en-US', {
                hour: 'numeric',
                hour12: true,
                timeZone: 'UTC',
              }).format(new Date(Date.UTC(2020, 0, 1, hour))),
              count,
            })),
          },
          'order-time',
          61,
          {
            subjectGroup: 'hour-distribution',
            orderIds: orderIds(dataset.dated.filter((receipt) => rankedHours.slice(0, 3).some(([hour]) => hour === receipt.hour))),
          },
        );
      if (night >= 3)
        add(
          eligible,
          {
            id: 'night-owl',
            presentation: 'hero',
            category: 'habits',
            icon: 'moon',
            eyebrow: 'After hours',
            title: 'Night owl energy',
            value: Math.round((night / timedCount) * 100),
            valueFormat: 'percent',
            detail: `${night} orders were placed from 10 PM through 4 AM.`,
          },
          'late-night',
          65,
          { orderIds: orderIds(dataset.dated.filter((receipt) => isLateNightHour(receipt.hour))) },
        );
    }
    const busiest = [...months].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
    const rankedMonths = [...months].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
    const busiestShare = Math.round((busiest[1] / dataset.dated.length) * 100);
    add(
      eligible,
      {
        id: 'busiest-month',
        presentation: 'hero',
        category: 'extremes',
        icon: 'calendar',
        eyebrow: 'Peak season',
        title: 'Your busiest month',
        headline: new Intl.DateTimeFormat('en-US', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(new Date(`${busiest[0]}-01T00:00:00.000Z`)),
        value: busiest[1],
        valueFormat: 'number',
        detail: dataset.orderMetrics
          ? `${busiest[1]} completed deliveries—${busiestShare}% of your dated delivery history. Includes every merchant category.`
          : `${busiest[1]} tracked orders—${busiestShare}% of your dated history. The kitchen was closed, spiritually.`,
      },
      'monthly-record',
      63,
      {
        subjectGroup: 'month-distribution',
        orderIds: orderIds(dataset.dated.filter((receipt) => receipt.localMonth === busiest[0])),
      },
    );
    if (rankedMonths.length >= 2)
      add(
        eligible,
        {
          id: 'busy-month-podium',
          presentation: 'ranking',
          category: 'extremes',
          icon: 'calendar',
          eyebrow: 'Peak seasons',
          title: 'Your busiest months',
          detail: 'A top-three view keeps one unusual month from owning the whole story.',
          rows: rankedMonths.slice(0, 3).map(([month, count]) => ({
            label: new Intl.DateTimeFormat('en-US', {
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(`${month}-01T00:00:00.000Z`)),
            count,
          })),
        },
        'monthly-record',
        67,
        {
          subjectGroup: 'month-distribution',
          orderIds: orderIds(dataset.dated.filter((receipt) => rankedMonths.slice(0, 3).some(([month]) => month === receipt.localMonth))),
        },
      );
  } else suppressed.push({ id: 'time-habits', reason: 'insufficient_history' });
}

function addCostRecords(dataset: DashboardDataset, eligible: InsightCandidate[]) {
  const expensiveOrders = [...dataset.positive]
    .filter((receipt) => receipt.restaurantLabel)
    .sort((a, b) => b.amount - a.amount || a.stableIndex - b.stableIndex)
    .slice(0, 3);
  const orderRankTitles = [
    dataset.orderMetrics ? 'Highest net order cost' : 'Your biggest order',
    dataset.orderMetrics ? 'Second-highest net order cost' : 'Your second-biggest order',
    dataset.orderMetrics ? 'Third-highest net order cost' : 'Your third-biggest order',
  ];
  const orderRankEyebrows = ['Heavyweight receipt', 'The runner-up receipt', 'Third-place splurge'];
  expensiveOrders.forEach((expensive, index) =>
    add(
      eligible,
      {
        id: index === 0 ? 'biggest-splurge' : `biggest-splurge-rank-${index + 1}`,
        presentation: 'order',
        category: 'extremes',
        icon: 'receipt',
        eyebrow: orderRankEyebrows[index],
        title: orderRankTitles[index],
        detail: dataset.orderMetrics
          ? 'Net cost after refunds, including charged cancellations. This is not a delivery ranking.'
          : index === 0
            ? 'One order entered the chat with main-character energy.'
            : `Ranked #${index + 1} by total spend—still worth a closer look.`,
        period: expensive.localDate ? { startDate: expensive.localDate } : undefined,
        order: {
          restaurant: expensive.restaurantLabel!,
          amount: roundMoney(expensive.amount),
          orderedAt: expensive.source.orderDate?.toISOString(),
          items: (dataset.orderMetrics && !orderMetricEligibility(expensive.source).delivered
            ? []
            : expensive.items
          )
            .slice(0, 4)
            .map((item) => `${item.quantity > 1 ? `${item.quantity}× ` : ''}${item.label}`),
        },
      },
      'order-record',
      76 - index * 4,
      { subjectGroup: 'biggest-orders', subjectRank: index + 1, orderIds: orderIds([expensive]) },
    ),
  );
  const expensive = expensiveOrders[0];
  if (
    dataset.exportReceipts.length &&
    expensive?.items.length &&
    (!dataset.orderMetrics || orderMetricEligibility(expensive.source).delivered)
  )
    add(
      eligible,
      {
        id: 'detailed-biggest-order',
        presentation: 'order',
        category: 'extremes',
        icon: 'receipt',
        eyebrow: 'Receipt archaeology',
        title: dataset.orderMetrics
          ? 'Inside your highest-cost delivery'
          : 'Inside your heavyweight order',
        detail: dataset.orderMetrics
          ? 'Ordered items from the highest-net-cost order, which was delivered.'
          : 'The supporting cast from your biggest detailed order.',
        period: expensive.localDate ? { startDate: expensive.localDate } : undefined,
        order: {
          restaurant: expensive.restaurantLabel!,
          amount: roundMoney(expensive.amount),
          orderedAt: expensive.source.orderDate?.toISOString(),
          items: expensive.items
            .slice(0, 4)
            .map((item) => `${item.quantity > 1 ? `${item.quantity}× ` : ''}${item.label}`),
        },
      },
      'order-detail',
      67,
      { relatedFamilies: ['order-record'], orderIds: orderIds([expensive]) },
    );
}

function addItemFavorites(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  if (dataset.exportReceipts.length) {
    const topItems = [...dataset.itemTotals.values()]
      .sort(
        (a, b) =>
          b.appearances - a.appearances || b.units - a.units || a.label.localeCompare(b.label),
      )
      .filter((item) => item.appearances >= 2)
      .slice(0, 3);
    topItems.forEach((item, index) =>
      add(
        eligible,
        {
          id: index === 0 ? 'most-ordered-meal' : `most-ordered-meal-rank-${index + 1}`,
          presentation: 'hero',
          category: 'favorites',
          icon: 'meal',
          eyebrow: index === 0 ? 'Signature order' : `Menu favorite #${index + 1}`,
          title:
            index === 0
              ? 'Most repeated menu item'
              : `${index === 1 ? 'Second' : 'Third'} most-repeated item`,
          headline: item.label,
          value: item.appearances,
          valueFormat: 'number',
          detail: `It appeared ${item.appearances} times in your detailed export rows.`,
          methodology: { sampleSize: item.appearances },
        },
        'item-favorite',
        70 - index * 4,
        {
          subjectGroup: 'repeated-menu-items',
          subjectRank: index + 1,
          orderIds: orderIds(dataset.exportReceipts.filter((receipt) => evidenceItems(receipt).some((candidate) => candidate.key === item.key))),
        },
      ),
    );
  } else suppressed.push({ id: 'export-details', reason: 'missing_export_items' });
}

function addDeliveryRecords(dataset: DashboardDataset, eligible: InsightCandidate[]) {
  const longestDeliveries = [...dataset.deliveryReceipts]
    .sort((a, b) => b.deliveryMinutes! - a.deliveryMinutes! || a.stableIndex - b.stableIndex)
    .slice(0, 3);
  longestDeliveries.forEach((delivery, index) =>
    add(
      eligible,
      {
        id: index === 0 ? 'longest-delivery' : `longest-delivery-rank-${index + 1}`,
        presentation: 'hero',
        category: 'extremes',
        icon: 'delivery',
        eyebrow: index === 0 ? 'Worth the wait?' : `Long wait #${index + 1}`,
        title:
          index === 0
            ? 'Your longest delivery'
            : `Your ${index === 1 ? 'second' : 'third'}-longest delivery`,
        value: delivery.deliveryMinutes!,
        valueFormat: 'minutes',
        headline: delivery.restaurantLabel,
        detail:
          index === 0
            ? 'A full feature-length delivery window.'
            : `Ranked #${index + 1} among valid delivery windows.`,
        period: delivery.localDate ? { startDate: delivery.localDate } : undefined,
      },
      'delivery-record',
      74 - index * 4,
      { subjectGroup: 'longest-deliveries', subjectRank: index + 1, orderIds: orderIds([delivery]) },
    ),
  );
}

function addRecentMovement(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  if (!dataset.latestDate || daysBetween(dataset.latestDate, dataset.localDate) > 14) {
    suppressed.push({ id: 'recent-movement', reason: 'stale_coverage' });
    return;
  }
  const windows = localPeriodWindows(dataset);
  const mtd = comparisonCandidate(
    'month-to-date-spending',
    `Day ${windows.elapsedDay} check-in`,
    windows.mtdCurrent,
    windows.mtdPrevious,
    'This month so far',
    'Same days last month',
    dataset.orderMetrics ? 'net-cost' : 'legacy',
  );
  const rolling = comparisonCandidate(
    'rolling-30-spending',
    'Your latest 30 days',
    windows.rollingCurrent,
    windows.rollingPrevious,
    'Latest 30 days',
    'Previous 30 days',
    dataset.orderMetrics ? 'net-cost' : 'legacy',
  );
  if (mtd) eligible.push(mtd);
  else suppressed.push({ id: 'month-to-date-spending', reason: 'low_sample' });
  if (rolling) eligible.push(rolling);
  else suppressed.push({ id: 'rolling-30-spending', reason: 'low_sample' });
  if (windows.rollingCurrent.length >= 3 && windows.rollingPrevious.length >= 3) {
    const currentAverage = roundMoney(
      sum(windows.rollingCurrent.map((receipt) => receipt.amount)) / windows.rollingCurrent.length,
    );
    const previousAverage = roundMoney(
      sum(windows.rollingPrevious.map((receipt) => receipt.amount)) /
        windows.rollingPrevious.length,
    );
    const averageDelta = roundMoney(currentAverage - previousAverage);
    const averagePercent = Math.round((averageDelta / previousAverage) * 100);
    if (previousAverage >= 8 && Math.abs(averagePercent) >= 15)
      add(
        eligible,
        {
          id: 'rolling-average-basket',
          presentation: 'comparison',
          category: 'progress',
          icon: 'trend',
          eyebrow: dataset.orderMetrics
            ? 'Net costs over time'
            : averageDelta < 0
              ? 'Smaller baskets'
              : 'Bigger baskets',
          title: dataset.orderMetrics
            ? 'Average net order cost shifted'
            : 'Your average order shifted',
          detail: `The average ${dataset.orderMetrics ? 'net order cost' : 'tracked order'} was ${Math.abs(averagePercent)}% ${averageDelta < 0 ? 'lower' : 'higher'} than in the preceding 30 days.`,
          comparison: {
            current: currentAverage,
            previous: previousAverage,
            delta: averageDelta,
            percentDelta: averagePercent,
            direction: averageDelta > 0 ? 'up' : 'down',
            valueFormat: 'currency',
            currentLabel: 'Latest average',
            previousLabel: 'Previous average',
            driver: 'basket',
          },
          methodology: {
            sampleSize: windows.rollingCurrent.length + windows.rollingPrevious.length,
          },
        },
        'average-basket',
        averageDelta < 0 ? 92 : 84,
        {
          timely: true,
          relatedFamilies: ['spending-movement', 'order-frequency'],
          orderIds: orderIds([...windows.rollingCurrent, ...windows.rollingPrevious]),
        },
      );
  }
}

function addRecentFrequency(dataset: DashboardDataset, eligible: InsightCandidate[]) {
  if (!dataset.latestDate || daysBetween(dataset.latestDate, dataset.localDate) > 14) return;
  const windows = localPeriodWindows(dataset);
  const current = windows.rollingCurrent.length;
  const previous = windows.rollingPrevious.length;
  const delta = current - previous;
  if (current < 3 || previous < 3 || Math.abs(delta) < 2) return;
  add(
    eligible,
    {
      id: 'rolling-order-frequency',
      presentation: 'comparison',
      category: 'progress',
      icon: 'repeat',
      eyebrow: delta < 0 ? 'A quieter month' : 'Doorbell activity',
      title: dataset.orderMetrics ? 'Delivery frequency shifted' : 'Order frequency shifted',
      detail: `${Math.abs(delta)} ${dataset.orderMetrics ? 'completed deliveries' : 'orders'} ${delta < 0 ? 'fewer' : 'more'} than the preceding 30 days.`,
      comparison: {
        current,
        previous,
        delta,
        percentDelta: Math.round((delta / previous) * 100),
        direction: delta > 0 ? 'up' : 'down',
        valueFormat: 'number',
        currentLabel: 'Latest 30 days',
        previousLabel: 'Previous 30 days',
        driver: 'frequency',
      },
    },
    'order-frequency',
    delta < 0 ? 93 : 86,
    {
      timely: true,
      relatedFamilies: ['spending-movement'],
      orderIds: orderIds([...windows.rollingCurrent, ...windows.rollingPrevious]),
    },
  );
}

function addRestaurantStories(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  const stats = restaurantStats(dataset).filter(
    (stat) => stat.receipts[0]?.merchantClass === 'restaurant',
  );
  if (stats.length < 2) {
    suppressed.push({ id: 'restaurant-stories', reason: 'low_sample' });
    return;
  }
  const runs: NormalizedReceipt[][] = [];
  for (const receipt of dataset.dated) {
    const previous = runs.at(-1);
    if (receipt.restaurantKey && previous?.[0].restaurantKey === receipt.restaurantKey)
      previous.push(receipt);
    else runs.push([receipt]);
  }
  const bestRuns = new Map<string, NormalizedReceipt[]>();
  for (const run of runs) {
    const key = run[0].restaurantKey;
    if (!key || run.length < 3 || run[0].merchantClass !== 'restaurant') continue;
    // Runs are chronological, so retaining the first equal run resolves date ties.
    if (run.length > (bestRuns.get(key)?.length ?? 0)) bestRuns.set(key, run);
  }
  [...bestRuns.entries()]
    .sort(([aKey, a], [bKey, b]) => b.length - a.length ||
      a[0].localDate!.localeCompare(b[0].localDate!) || aKey.localeCompare(bKey))
    .slice(0, 3)
    .forEach(([, run], index) => add(
      eligible,
      {
        id: rankedInsightId('restaurant-tunnel-vision', index),
        presentation: 'hero',
        category: 'habits',
        icon: 'repeat',
        eyebrow: index === 0 ? 'Longest restaurant run' : `${rankLabel(index)}-longest restaurant run`,
        title: 'Same place. Again. Again.',
        headline: run[0].restaurantLabel,
        value: run.length,
        valueFormat: 'number',
        detail: `${run.length} consecutive tracked orders from one restaurant. Commitment has entered the chat.`,
        period: { startDate: run[0].localDate!, endDate: run[run.length - 1].localDate },
      },
      'restaurant-run',
      82 - index * 4,
      { subjectGroup: 'restaurant-runs', subjectRank: index + 1, orderIds: orderIds(run) },
    ));

  const top = stats[0],
    second = stats[1];
  if (top.count >= 4 && top.count - second.count <= Math.max(2, Math.floor(top.count * 0.12)))
    add(
      eligible,
      {
        id: 'restaurant-rivalry',
        presentation: 'timeline',
        category: 'favorites',
        icon: 'trophy',
        eyebrow: 'Photo finish',
        title: 'Your restaurant rivalry',
        detail: 'The crown is still very much in play.',
        events: [
          { label: top.label, value: `${top.count} orders` },
          {
            label: second.label,
            value: `${second.count} orders`,
            detail: `${top.count - second.count} behind`,
          },
        ],
      },
      'restaurant-rivalry',
      78,
      {
        relatedFamilies: ['restaurant-ranking', 'restaurant-loyalty'],
        orderIds: orderIds([...top.receipts, ...second.receipts]),
      },
    );

  const years = new Map<number, Map<string, number>>();
  for (const receipt of dataset.dated) {
    if (!receipt.localYear || !receipt.restaurantKey) continue;
    const year = years.get(receipt.localYear) ?? new Map<string, number>();
    year.set(receipt.restaurantKey, (year.get(receipt.restaurantKey) ?? 0) + 1);
    years.set(receipt.localYear, year);
  }
  const currentYear = Number(dataset.localDate.slice(0, 4));
  const yearlyChampions = [...years]
    .sort(([a], [b]) => a - b)
    .flatMap(([year, counts]) => {
      const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const winningCount = ordered[0]?.[1] ?? 0;
      if (winningCount < 3) return [];
      return [
        {
          year,
          orderCount: winningCount,
          currentYear: year === currentYear,
          winners: ordered
            .filter(([, count]) => count === winningCount)
            .map(([key]) => ({
              key,
              label: dataset.byRestaurant.get(key)?.[0].restaurantLabel ?? key,
            })),
        },
      ];
    });
  if (yearlyChampions.length >= 3) {
    const crownCounts = new Map<string, { label: string; count: number }>();
    for (const champion of yearlyChampions)
      for (const winner of champion.winners) {
        const existing = crownCounts.get(winner.key) ?? { label: winner.label, count: 0 };
        existing.count += 1;
        crownCounts.set(winner.key, existing);
      }
    const crownLeader = [...crownCounts.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label),
    )[0];
    const latest = yearlyChampions.at(-1)!;
    const latestNames = latest.winners.map((winner) => winner.label).join(' & ');
    const detail = `${crownLeader.label} collected ${crownLeader.count} ${crownLeader.count === 1 ? 'crown' : 'crowns'}. ${latestNames} ${latest.winners.length === 1 ? 'has' : 'share'} the latest one.`;
    add(
      eligible,
      {
        id: 'restaurant-champions-by-year',
        presentation: 'yearly-champions',
        category: 'favorites',
        icon: 'trophy',
        eyebrow: 'Taste timeline',
        title: 'Your champions through the years',
        detail,
        years: yearlyChampions.map((champion) => ({
          year: champion.year,
          winners: champion.winners.map((winner) => winner.label),
          orderCount: champion.orderCount,
          currentYear: champion.currentYear,
        })),
      },
      'restaurant-era',
      90,
      {
        orderIds: orderIds(dataset.dated.filter((receipt) => yearlyChampions.some((champion) =>
          champion.year === receipt.localYear && champion.winners.some((winner) => winner.key === receipt.restaurantKey)))),
      },
    );
  }
  const yearWinners = yearlyChampions.flatMap((champion) =>
    champion.winners.length === 1
      ? [
          {
            year: champion.year,
            key: champion.winners[0].key,
            count: champion.orderCount,
            label: champion.winners[0].label,
          },
        ]
      : [],
  );
  const firstWinner = yearWinners[0],
    lastWinner = yearWinners.at(-1);
  if (yearlyChampions.length < 3 && firstWinner && lastWinner && firstWinner.key !== lastWinner.key)
    add(
      eligible,
      {
        id: 'restaurant-crown-changed',
        presentation: 'timeline',
        category: 'favorites',
        icon: 'trophy',
        eyebrow: 'A new era',
        title: 'The crown changed hands',
        detail: 'Your taste has plot development.',
        events: [
          {
            label: String(firstWinner.year),
            value: firstWinner.label,
            detail: `${firstWinner.count} orders`,
          },
          {
            label: String(lastWinner.year),
            value: lastWinner.label,
            detail: `${lastWinner.count} orders`,
          },
        ],
      },
      'restaurant-era',
      88,
      {
        orderIds: orderIds(dataset.dated.filter((receipt) =>
          (receipt.localYear === firstWinner.year && receipt.restaurantKey === firstWinner.key) ||
          (receipt.localYear === lastWinner.year && receipt.restaurantKey === lastWinner.key))),
      },
    );
  const eraGroups = yearWinners.reduce<Array<typeof yearWinners>>((groups, winner) => {
    const latest = groups.at(-1);
    const previousWinner = latest?.at(-1);
    if (latest && previousWinner?.key === winner.key && previousWinner.year + 1 === winner.year)
      latest.push(winner);
    else groups.push([winner]);
    return groups;
  }, []);
  eraGroups.filter((era) => era.length >= 2)
    .sort((a, b) => b.length - a.length || a[0].year - b[0].year || a[0].key.localeCompare(b[0].key))
    .slice(0, 3).forEach((longestEra, index) => {
      const finalEraWinner = longestEra[longestEra.length - 1];
      add(
        eligible,
        {
          id: rankedInsightId('restaurant-era', index),
          presentation: 'timeline',
          category: 'favorites',
          icon: 'trophy',
          eyebrow: index === 0 ? 'Longest restaurant era' : `${rankLabel(index)}-longest restaurant era`,
          title: `${longestEra[0].label} had an era`,
          detail: `${longestEra.length} consecutive yearly crowns. That is less a phase and more a residency.`,
          events: [
            { label: 'Era began', value: String(longestEra[0].year) },
            { label: 'Last crown', value: String(finalEraWinner.year) },
            { label: 'Orders in crown years', value: sum(longestEra.map((winner) => winner.count)) },
          ],
        },
        'restaurant-dynasty',
        79 - index * 4,
        {
          subjectGroup: 'restaurant-eras', subjectRank: index + 1,
          relatedFamilies: ['restaurant-era'],
          orderIds: orderIds(dataset.dated.filter((receipt) => longestEra.some((winner) =>
            winner.year === receipt.localYear && winner.key === receipt.restaurantKey))),
        },
      );
    });

  const recentCutoff = dateOrdinal(dataset.localDate) - 180;
  const formerYearWinners = new Set(yearWinners.map((winner) => winner.key));
  const formerFavourites = stats
    .map((stat) => ({
      ...stat,
      recent: stat.receipts.filter(
        (receipt) => receipt.localDate && dateOrdinal(receipt.localDate) >= recentCutoff,
      ).length,
    }))
    .filter((stat) => stat.count >= 5 && stat.recent === 0 && formerYearWinners.has(stat.key))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 3);
  formerFavourites.forEach((former, index) => {
    const formerLatestDate = former.receipts.at(-1)?.localDate;
    if (formerLatestDate)
      add(
        eligible,
        {
          id: rankedInsightId('former-favourite', index),
          presentation: 'timeline',
          category: 'favorites',
          icon: 'heart',
          eyebrow: `Former favourite #${index + 1}`,
          title: `Whatever happened to ${former.label}?`,
          detail: `${former.count} tracked orders historically, but none recorded in the latest 180 days.`,
          events: [
            { label: 'All-time orders', value: former.count },
            { label: 'Latest visit', value: dateLabel(formerLatestDate) },
          ],
        },
        'former-favourite',
        72 - index * 4,
        { subjectGroup: 'former-favourites', subjectRank: index + 1, relatedFamilies: ['restaurant-comeback'], orderIds: orderIds(former.receipts) },
      );
  });

  const comebacks = stats.filter((stat) => stat.receipts.length >= 3).flatMap((stat) => {
    const returns = stat.receipts.slice(1).flatMap((receipt, index) => {
      const previous = stat.receipts[index];
      if (!previous.localDate || !receipt.localDate) return [];
      const gap = daysBetween(previous.localDate, receipt.localDate);
      const sinceReturn = daysBetween(receipt.localDate, dataset.localDate);
      if (gap < 90 || sinceReturn < 0 || sinceReturn > 365) return [];
      return [{ key: stat.key, label: stat.label, gap, returned: receipt.localDate,
        receipts: [previous, receipt] }];
    });
    return returns.sort((a, b) => b.gap - a.gap || b.returned.localeCompare(a.returned)).slice(0, 1);
  });
  comebacks.sort((a, b) => b.gap - a.gap || b.returned.localeCompare(a.returned) || a.key.localeCompare(b.key))
    .slice(0, 3).forEach((comeback, index) => add(
      eligible,
      {
        id: rankedInsightId('restaurant-comeback', index),
        presentation: 'timeline',
        category: 'favorites',
        icon: 'repeat',
        eyebrow: `Comeback tour #${index + 1}`,
        title: `${comeback.label} returned`,
        detail: `After ${comeback.gap} days apart. Some relationships just need space.`,
        events: [
          { label: 'The gap', value: `${comeback.gap} days` },
          { label: 'The reunion', value: dateLabel(comeback.returned) },
        ],
      },
      'restaurant-comeback',
      80 - index * 4,
      { subjectGroup: 'restaurant-comebacks', subjectRank: index + 1, orderIds: orderIds(comeback.receipts) },
    ));

  const latest = dataset.dated.slice(-10);
  const recentUnique = new Set(latest.map((receipt) => receipt.restaurantKey).filter(Boolean)).size;
  if (latest.length === 10 && recentUnique >= 7)
    add(
      eligible,
      {
        id: 'recent-variety-era',
        presentation: 'hero',
        category: 'habits',
        icon: 'sparkles',
        eyebrow: 'Variety era',
        title: 'Your last 10 mixed it up',
        value: recentUnique,
        valueFormat: 'number',
        detail: `${recentUnique} different restaurants in 10 orders. Your recents have range.`,
      },
      'recent-variety',
      84,
      { timely: true, relatedFamilies: ['restaurant-personality'], orderIds: orderIds(latest) },
    );
}

function addItemAndBasketStories(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  if (!dataset.exportReceipts.length) {
    suppressed.push({ id: 'item-stories', reason: 'missing_export_items' });
    return;
  }
  const sauceCounts = new Map<string, number>();
  let sauceOrderCount = 0;
  for (const receipt of dataset.exportReceipts) {
    const sauces = new Set(receipt.items.flatMap(extractDippingSauceLabels));
    if (!sauces.size) continue;
    sauceOrderCount += 1;
    for (const sauce of sauces) sauceCounts.set(sauce, (sauceCounts.get(sauce) ?? 0) + 1);
  }
  const sauceRows = [...sauceCounts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const hasSauceRanking = sauceRows.length >= 2 && sauceRows[0].count >= 2 && sauceOrderCount >= 4;

  const families = new Map<ItemFamily, { units: number; appearances: number }>();
  for (const item of dataset.itemTotals.values()) {
    if (item.family === 'other') continue;
    const current = families.get(item.family) ?? { units: 0, appearances: 0 };
    current.units += item.units;
    current.appearances += item.appearances;
    families.set(item.family, current);
  }
  for (const [family, total] of families) {
    if (family === 'sauce' && hasSauceRanking) continue;
    const profile = getItemPersonality(family as ItemPersonalityFamily);
    if (total.units < profile.minimumUnits) continue;
    if (total.units > profile.maximumUnits) {
      suppressed.push({ id: `item-obsession-${family}`, reason: 'unsafe_estimate' });
      continue;
    }
    const units = Math.round(total.units);
    add(
      eligible,
      {
        id: `item-obsession-${family}`,
        presentation: 'hero',
        category: 'favorites',
        icon: profile.icon,
        eyebrow: 'Item obsession',
        title: `${units.toLocaleString()} ${profile.label}`,
        value: units,
        valueFormat: 'number',
        detail: `Your tracked orders included ${units.toLocaleString()} ${profile.label}.`,
        methodology: { sampleSize: total.appearances },
      },
      `item-${family}`,
      79 + Math.min(8, Math.floor(total.units / profile.minimumUnits)),
      {
        relatedFamilies: ['item-favorite'],
        copyVariants: profile.punchlines,
        orderIds: orderIds(dataset.exportReceipts.filter((receipt) => evidenceItems(receipt).some((item) => item.family === family))),
      },
    );
  }

  if (hasSauceRanking)
    add(
      eligible,
      {
        id: 'top-dipping-sauces',
        presentation: 'ranking',
        category: 'favorites',
        icon: 'sparkles',
        eyebrow: 'Dip draft',
        title: 'Your dipping-sauce podium',
        detail: `${sauceRows[0].label} took the crown. Dry bites never had a chance.`,
        rows: sauceRows.slice(0, 3),
        methodology: { sampleSize: sauceOrderCount },
      },
      'sauce-ranking',
      89,
      {
        relatedFamilies: ['item-sauce', 'item-favorite'],
        orderIds: orderIds(dataset.exportReceipts.filter((receipt) => {
          const sauces = new Set(receipt.items.flatMap(extractDippingSauceLabels));
          return sauceRows.slice(0, 3).some((row) => sauces.has(row.label));
        })),
      },
    );

  // Unknown menu items still qualify when the same normalized item appears
  // often enough. This is the scaling fallback: a new food type can ship with
  // generic character immediately, then graduate to a named profile later.
  const generic = [...dataset.itemTotals.values()]
    .filter((item) => item.family === 'other' && item.appearances >= 6 && item.units <= 5000)
    .sort(
      (a, b) => b.appearances - a.appearances || b.units - a.units || a.key.localeCompare(b.key),
    )[0];
  if (generic) {
    add(
      eligible,
      {
        id: 'item-obsession-recurring-item',
        presentation: 'hero',
        category: 'favorites',
        icon: 'meal',
        eyebrow: 'Item obsession',
        title: generic.label,
        value: generic.appearances,
        valueFormat: 'number',
        detail: `It showed up ${generic.appearances.toLocaleString()} times in your tracked orders.`,
        methodology: { sampleSize: generic.appearances },
      },
      'item-generic',
      72 + Math.min(8, Math.floor(generic.appearances / 3)),
      {
        relatedFamilies: ['item-favorite'],
        copyVariants: GENERIC_ITEM_PUNCHLINES,
        orderIds: orderIds(dataset.exportReceipts.filter((receipt) => evidenceItems(receipt).some((item) => item.key === generic.key))),
      },
    );
  }

  const baskets = new Map<string, NormalizedReceipt[]>();
  for (const receipt of dataset.exportReceipts)
    if (receipt.basketKey)
      baskets.set(receipt.basketKey, [...(baskets.get(receipt.basketKey) ?? []), receipt]);
  const rankedBaskets = [...baskets.values()].sort(
    (a, b) => b.length - a.length || (a[0].basketKey ?? '').localeCompare(b[0].basketKey ?? ''),
  );
  const detailedBasketOrders = rankedBaskets.reduce(
    (total, receipts) => total + receipts.length,
    0,
  );
  if (detailedBasketOrders >= 12 && rankedBaskets.length >= 3) {
    const restaurants = restaurantStats(dataset).filter(
      (stat) => stat.receipts[0]?.merchantClass === 'restaurant',
    );
    const oneOffRestaurants = restaurants.filter((stat) => stat.count === 1).length;
    const uniqueRestaurantRate =
      restaurants.length /
      Math.max((dataset.orderMetrics ? dataset.receipts : dataset.positive).length, 1);
    const explorer =
      restaurants.length >= 10 && (uniqueRestaurantRate >= 0.25 || oneOffRestaurants >= 8);
    add(
      eligible,
      {
        id: 'restaurant-personality',
        presentation: 'ranking',
        category: 'habits',
        icon: explorer ? 'sparkles' : 'heart',
        eyebrow: 'Your ordering personality',
        title: explorer ? 'Menu explorer' : 'Comfort orderer',
        detail: explorer
          ? 'You roam, but these are your three most common complete orders.'
          : 'Your three most common complete orders know their way back.',
        rows: rankedBaskets.slice(0, 3).map((receipts) => ({
          label: basketSummary(receipts[0]),
          context: receipts[0].restaurantLabel,
          count: receipts.length,
        })),
      },
      'restaurant-personality',
      75,
      {
        relatedFamilies: ['restaurant-loyalty'],
        orderIds: orderIds(rankedBaskets.slice(0, 3).flat()),
      },
    );
  }

  const repeated = rankedBaskets.filter((receipts) => receipts.length >= 3);
  const soulmate = repeated[0];
  if (soulmate) {
    repeated.slice(0, 3).forEach((basket, index) => {
      const itemSummary = basket[0].items
        .slice(0, 3)
        .map((item) => `${item.quantity > 1 ? `${item.quantity}× ` : ''}${item.label}`)
        .join(', ');
      const basketPeriod =
        basket[0].localDate && basket.at(-1)?.localDate
          ? { startDate: basket[0].localDate, endDate: basket.at(-1)!.localDate! }
          : undefined;
      add(
        eligible,
        {
          id: index === 0 ? 'exact-basket-soulmate' : `exact-basket-soulmate-rank-${index + 1}`,
          presentation: 'hero',
          category: 'favorites',
          icon: 'repeat',
          eyebrow: index === 0 ? 'Menu soulmate' : `Repeat basket #${index + 1}`,
          title:
            index === 0
              ? 'The exact same basket'
              : `Your ${index === 1 ? 'second' : 'third'} repeat order`,
          value: basket.length,
          valueFormat: 'number',
          headline: basket[0].restaurantLabel,
          detail: `${itemSummary}. Repeated ${basket.length} times with no notes needed.`,
          period: basketPeriod,
        },
        'exact-basket',
        94 - index * 6,
        {
          relatedFamilies: ['item-favorite'],
          subjectGroup: 'exact-baskets',
          subjectRank: index + 1,
          orderIds: orderIds(basket),
        },
      );
    });
    const restaurantOrders =
      dataset.byRestaurant.get(soulmate[0].restaurantKey!)?.filter(hasExportSource).length ??
      soulmate.length;
    const predictableShare = soulmate.length / restaurantOrders;
    if (restaurantOrders >= 5 && predictableShare >= 0.5)
      add(
        eligible,
        {
          id: 'most-predictable-order',
          presentation: 'hero',
          category: 'habits',
          icon: 'repeat',
          eyebrow: 'Autopilot order',
          title: `Your ${soulmate[0].restaurantLabel} order barely changes`,
          value: Math.round(predictableShare * 100),
          valueFormat: 'percent',
          detail: `${soulmate.length} of ${restaurantOrders} detailed orders used the same normalized basket.`,
        },
        'predictable-basket',
        76,
        { relatedFamilies: ['exact-basket'], orderIds: orderIds(soulmate) },
      );
  } else suppressed.push({ id: 'exact-basket-soulmate', reason: 'low_sample' });

  const foodflationStories: FoodflationStory[] = [];
  const priceBaskets = new Map<string, NormalizedReceipt[]>();
  for (const [basketKey, receipts] of baskets)
    for (const receipt of receipts) {
      const key = dataset.orderMetrics
        ? `${receipt.source.receiptType}:${merchantIdentity(receipt.source.restaurantName)}:${basketKey}`
        : basketKey;
      priceBaskets.set(key, [...(priceBaskets.get(key) ?? []), receipt]);
    }
  for (const [basketKey, receipts] of priceBaskets) {
    const datedReceipts = receipts.filter(
      (receipt): receipt is NormalizedReceipt & { localDate: string } => Boolean(receipt.localDate),
    );
    if (
      datedReceipts.length < 2 ||
      (datedReceipts[0].source.monetaryDetails?.currencyCode ?? 'UNKNOWN') !== dataset.currencyCode
    )
      continue;
    foodflationStories.push({
      key: basketKey,
      kind: 'meal',
      name: basketSummary(datedReceipts[0]),
      restaurant: datedReceipts[0].restaurantLabel,
      observations: datedReceipts.flatMap((receipt) => {
        // Menu-price comparisons cannot use a refunded net balance as a basket price.
        const amount =
          receipt.source.resolution?.reconstructedSubtotal ??
          receipt.source.monetaryDetails?.subtotal ??
          (dataset.orderMetrics ? undefined : receipt.amount);
        return amount !== undefined && Number.isFinite(amount) && amount > 0 && receipt.source.id
          ? [{ amount, date: receipt.localDate, orderId: receipt.source.id }]
          : [];
      }),
      relatedFamilies: ['exact-basket'],
    });
  }

  const itemPrices = new Map<
    string,
    {
      item: NormalizedReceipt['items'][number];
      restaurant?: string;
      observations: Array<{ amount: number; date: string; orderId: string }>;
    }
  >();
  for (const receipt of dataset.exportReceipts) {
    if (
      !receipt.source.id ||
      !receipt.localDate ||
      (receipt.source.monetaryDetails?.currencyCode ?? 'UNKNOWN') !== dataset.currencyCode
    )
      continue;
    const orderPrices = new Map<
      string,
      { item: NormalizedReceipt['items'][number]; amount: number }
    >();
    for (const item of receipt.items) {
      if (!item.priceKnown || item.price <= 0) continue;
      const merchantKey = dataset.orderMetrics
        ? `${receipt.source.receiptType}:${merchantIdentity(receipt.source.restaurantName)}`
        : (receipt.restaurantKey ?? 'unknown');
      const key = `${merchantKey}::${receipt.source.monetaryDetails?.currencyCode ?? 'UNKNOWN'}::${item.key}::${item.customizations
        .map((v) => v.toLowerCase())
        .sort()
        .join(';')}`;
      const current = orderPrices.get(key);
      if (current)
        continue; // One comparable unit-price observation per order, not a sum of unit prices.
      else orderPrices.set(key, { item, amount: item.price });
    }
    for (const [key, observation] of orderPrices) {
      const current = itemPrices.get(key) ?? {
        item: observation.item,
        restaurant: receipt.restaurantLabel,
        observations: [],
      };
      current.observations.push({ amount: observation.amount, date: receipt.localDate, orderId: receipt.source.id });
      itemPrices.set(key, current);
    }
  }
  for (const [key, item] of itemPrices) {
    if (item.observations.length < 2) continue;
    foodflationStories.push({
      key,
      kind: 'item',
      name: `${item.item.label} (per item)`,
      restaurant: item.restaurant,
      observations: item.observations,
      relatedFamilies: ['item-favorite'],
    });
  }

  const foodflation = foodflationStories
    .filter((story) => story.observations.length >= 2)
    .map(foodflationCandidate)
    .filter((candidate): candidate is InsightCandidate => Boolean(candidate))
    .sort((a, b) => b.score - a.score || a.insight.id.localeCompare(b.insight.id))
    .slice(0, 4);
  eligible.push(...foodflation);
  if (!foodflation.length) suppressed.push({ id: 'foodflation', reason: 'low_signal' });

  const sideCharacters = [...dataset.itemTotals.values()]
    .filter(
      (item) => item.appearances >= 4 && item.appearances < dataset.exportReceipts.length * 0.7,
    )
    .sort((a, b) => b.appearances - a.appearances || a.label.localeCompare(b.label))
    .slice(0, 3);
  sideCharacters.forEach((item, index) =>
    add(
      eligible,
      {
        id: index === 0 ? 'recurring-side-character' : `recurring-side-character-rank-${index + 1}`,
        presentation: 'hero',
        category: 'favorites',
        icon: 'meal',
        eyebrow: index === 0 ? 'Recurring side character' : `Supporting cast #${index + 1}`,
        title: item.label,
        value: item.appearances,
        valueFormat: 'number',
        detail: 'It kept finding its way into the cast of your orders.',
      },
      'item-side-character',
      66 - index * 4,
      {
        relatedFamilies: ['item-favorite'],
        subjectGroup: 'side-characters',
        subjectRank: index + 1,
        orderIds: orderIds(dataset.exportReceipts.filter((receipt) => evidenceItems(receipt).some((candidate) => candidate.key === item.key))),
      },
    ),
  );
}

function addTimingStories(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  if (!dataset.dated.length) {
    suppressed.push({ id: 'timing-stories', reason: 'missing_dates' });
    return;
  }
  const dates = [...dataset.byLocalDate.keys()].sort();
  const streaks: string[][] = [[dates[0]]];
  let longestBreak = 0,
    breakStart = dates[0],
    breakEnd = dates[0];
  for (let index = 1; index < dates.length; index++) {
    const gap = daysBetween(dates[index - 1], dates[index]);
    if (gap === 1) streaks[streaks.length - 1].push(dates[index]);
    else streaks.push([dates[index]]);
    if (gap - 1 > longestBreak) {
      longestBreak = gap - 1;
      breakStart = dates[index - 1];
      breakEnd = dates[index];
    }
  }
  streaks.filter((streak) => streak.length >= 3)
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
    .slice(0, 3).forEach((streak, index) => {
      const bestStart = streak[0], bestEnd = streak[streak.length - 1];
      add(
        eligible,
        {
          id: rankedInsightId('longest-order-streak', index),
          presentation: 'timeline',
          category: 'extremes',
          icon: 'calendar',
          eyebrow: index === 0 ? 'Longest ordering streak' : `${rankLabel(index)}-longest ordering streak`,
          title: `${streak.length} delivery days in a row`,
          detail: dataset.orderMetrics
            ? 'Consecutive local days with completed deliveries, across all merchant categories.'
            : 'A calendar streak with absolutely no meal prep subplot.',
          events: [
            { label: 'Started', value: dateLabel(bestStart) },
            { label: 'Made it through', value: dateLabel(bestEnd) },
          ],
        },
        'order-streak',
        86 - index * 4,
        { subjectGroup: 'ordering-streaks', subjectRank: index + 1, orderIds: orderIds(dataset.dated.filter((receipt) => Boolean(receipt.localDate && receipt.localDate >= bestStart && receipt.localDate <= bestEnd))) },
      );
    });
  let activeStreak = 1;
  for (
    let index = dates.length - 1;
    index > 0 && daysBetween(dates[index - 1], dates[index]) === 1;
    index--
  )
    activeStreak += 1;
  if (
    activeStreak >= 3 &&
    dataset.latestDate &&
    daysBetween(dataset.latestDate, dataset.localDate) <= 1
  )
    add(
      eligible,
      {
        id: 'current-order-streak',
        presentation: 'hero',
        category: 'habits',
        icon: 'calendar',
        eyebrow: 'Active streak',
        title: 'The delivery streak is still alive',
        value: activeStreak,
        valueFormat: 'days',
        detail: `${activeStreak} consecutive local dates ending with your latest tracked order.`,
        period: { startDate: dates[dates.length - activeStreak], endDate: dataset.latestDate },
      },
      'current-streak',
      95,
      {
        timely: true,
        relatedFamilies: ['order-streak'],
        orderIds: orderIds(dataset.dated.filter((receipt) => Boolean(receipt.localDate && receipt.localDate >= dates[dates.length - activeStreak] && receipt.localDate <= dataset.latestDate!))),
      },
    );
  const currentBreak = dataset.latestDate ? daysBetween(dataset.latestDate, dataset.localDate) : 0;
  const detoxDays = Math.max(longestBreak, currentBreak);
  if (detoxDays >= 7)
    add(
      eligible,
      {
        id: 'delivery-detox',
        presentation: 'hero',
        category: 'progress',
        icon: 'calendar',
        eyebrow: currentBreak >= longestBreak ? 'Gap in tracked history' : 'Longest tracked gap',
        title: 'Between tracked orders',
        value: detoxDays,
        valueFormat: 'days',
        detail:
          currentBreak >= longestBreak
            ? `It has been ${currentBreak} days since the latest tracked order.`
            : 'Your longest gap between recorded orders; missing history may contribute.',
        period:
          currentBreak >= longestBreak && dataset.latestDate
            ? { startDate: shiftLocalDate(dataset.latestDate, 1), endDate: dataset.localDate }
            : { startDate: shiftLocalDate(breakStart, 1), endDate: shiftLocalDate(breakEnd, -1) },
      },
      'delivery-break',
      69,
    );

  const busiestDays = [...dataset.byLocalDate]
    .filter(([, receipts]) => receipts.length >= 3)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 3);
  busiestDays.forEach((busyDay, index) => {
    if (dataset.orderMetrics) {
      const metrics = summarizeOrderMetrics(busyDay[1].map((r) => r.source));
      const spending = metrics.currencies.flatMap((currency) =>
        currency.currencyCode !== 'UNKNOWN' && currency.pricedOrders > 0 && currency.unknownPriceOrders === 0
          ? [{ currencyCode: currency.currencyCode, amount: currency.netSpend }]
          : [],
      );
      add(
        eligible,
        {
          id: index === 0 ? 'multi-order-day' : `multi-order-day-rank-${index + 1}`,
          presentation: 'hero',
          category: 'extremes',
          icon: 'delivery',
          eyebrow: 'A busy doorbell',
          title: `${metrics.deliveries} orders.`,
          value: metrics.deliveries,
          valueFormat: 'number',
          detail: 'One busy day.',
          busyDay: { date: busyDay[0], spending },
          period: { startDate: busyDay[0] },
        },
        'daily-order-record',
        83 - index * 6,
        { subjectGroup: 'multi-order-days', subjectRank: index + 1, orderIds: orderIds(busyDay[1]) },
      );
      return;
    }
    const restaurants = [
      ...new Set(
        busyDay[1].flatMap((receipt) => (receipt.restaurantLabel ? [receipt.restaurantLabel] : [])),
      ),
    ];
    add(
      eligible,
      {
        id: index === 0 ? 'multi-order-day' : `multi-order-day-rank-${index + 1}`,
        presentation: 'order',
        category: 'extremes',
        icon: 'receipt',
        eyebrow: index === 0 ? 'A very busy doorbell' : `Busy day #${index + 1}`,
        title: `${busyDay[1].length} orders. One day.`,
        detail:
          index === 0
            ? 'Breakfast, lunch, dinner—or an impressively committed mystery.'
            : `Your #${index + 1} busiest tracked delivery day.`,
        period: { startDate: busyDay[0] },
        order: {
          restaurant: restaurants[0] ?? 'Restaurant unavailable',
          restaurants,
          amount: roundMoney(sum(busyDay[1].map((receipt) => receipt.amount))),
          orderedAt: busyDay[1][0].source.orderDate?.toISOString(),
          items: [],
        },
      },
      'daily-order-record',
      83 - index * 6,
      { subjectGroup: 'multi-order-days', subjectRank: index + 1, orderIds: orderIds(busyDay[1]) },
    );
  });

  const lateReceipts = dataset.dated.filter((receipt) => isLateNightHour(receipt.hour));
  const lateNightOrdinal = (receipt: NormalizedReceipt) => {
    const minutes = receipt.hour! * 60 + (receipt.minute ?? 0);
    return receipt.hour! < 4 ? minutes + 24 * 60 : minutes;
  };
  const latestClocks = [...lateReceipts].sort(
    (a, b) => lateNightOrdinal(b) - lateNightOrdinal(a) || a.stableIndex - b.stableIndex,
  ).slice(0, 3);
  latestClocks.forEach((latestClock, index) => {
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: latestClock.source.resolution?.timestamp?.timezone ?? dataset.timezone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(latestClock.source.orderDate!);
    add(
      eligible,
      {
        id: rankedInsightId('latest-ever-order', index),
        presentation: 'timeline',
        category: 'extremes',
        icon: 'moon',
        eyebrow: index === 0 ? 'Latest checkout' : `${rankLabel(index)}-latest checkout`,
        title: index === 0
          ? (dataset.orderMetrics ? 'Latest recorded placement time' : 'Your hunger stayed up late')
          : `Your ${rankLabel(index).toLowerCase()}-latest order time`,
        detail: dataset.orderMetrics
          ? undefined
          : 'The delivery apps were still awake too.',
        period: latestClock.localDate ? { startDate: latestClock.localDate } : undefined,
        events: [
          { label: index === 0 ? 'Latest local order time' : 'Local order time', value: time },
          { label: 'Restaurant', value: latestClock.restaurantLabel ?? 'Unknown restaurant' },
        ],
      },
      'late-order-record',
      77 - index * 4,
      { subjectGroup: 'latest-order-times', subjectRank: index + 1, relatedFamilies: ['late-night'], orderIds: orderIds([latestClock]) },
    );
  });

  const lateRestaurants = new Map<string, NormalizedReceipt[]>();
  const lateItems = new Map<string, { key: string; label: string; count: number; dates: string[] }>();
  for (const lateReceipt of lateReceipts) {
    if (
      lateReceipt.restaurantKey &&
      (!dataset.orderMetrics || lateReceipt.merchantClass === 'restaurant')
    )
      lateRestaurants.set(lateReceipt.restaurantKey, [
        ...(lateRestaurants.get(lateReceipt.restaurantKey) ?? []),
        lateReceipt,
      ]);
    if (
      hasExportSource(lateReceipt) &&
      (!dataset.orderMetrics || lateReceipt.merchantClass === 'restaurant')
    )
      for (const item of lateReceipt.items) {
        const currentItem = lateItems.get(item.key) ?? { key: item.key, label: item.label, count: 0, dates: [] };
        currentItem.count += item.quantity;
        if (lateReceipt.localDate) currentItem.dates.push(lateReceipt.localDate);
        lateItems.set(item.key, currentItem);
      }
  }
  [...lateRestaurants.values()]
    .filter((receipts) => receipts.length >= 3)
    .sort(
      (a, b) =>
        b.length - a.length ||
        (a[0].restaurantLabel ?? '').localeCompare(b[0].restaurantLabel ?? ''),
    )
    .slice(0, 3)
    .forEach((favorite, index) =>
      add(
        eligible,
        {
          id:
            index === 0
              ? 'favourite-late-night-restaurant'
              : `favourite-late-night-restaurant-rank-${index + 1}`,
          presentation: 'hero',
          category: 'favorites',
          icon: 'moon',
          eyebrow: index === 0 ? 'After-hours favourite' : `After-hours favorite #${index + 1}`,
          title: favorite[0].restaurantLabel!,
          value: favorite.length,
          valueFormat: 'number',
          detail: `${favorite.length} tracked late-night orders.`,
          period:
            favorite[0].localDate && favorite.at(-1)?.localDate
              ? { startDate: favorite[0].localDate, endDate: favorite.at(-1)!.localDate }
              : undefined,
        },
        'late-night-restaurant',
        74 - index * 4,
        {
          relatedFamilies: ['late-night'],
          subjectGroup: 'late-night-restaurants',
          subjectRank: index + 1,
          orderIds: orderIds(favorite),
        },
      ),
    );
  [...lateItems.values()]
    .filter((item) => item.count >= 3)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 3)
    .forEach((item, index) =>
      add(
        eligible,
        {
          id:
            index === 0
              ? 'favourite-late-night-item'
              : `favourite-late-night-item-rank-${index + 1}`,
          presentation: 'hero',
          category: 'favorites',
          icon: 'moon',
          eyebrow: index === 0 ? 'Midnight menu regular' : `Late-night item #${index + 1}`,
          title: item.label,
          value: item.count,
          valueFormat: 'number',
          detail: `${item.count} ordered or included after 10 PM or before 4 AM.`,
          period: item.dates.length
            ? { startDate: item.dates[0], endDate: item.dates.at(-1) }
            : undefined,
        },
        'late-night-item',
        70 - index * 4,
        {
          relatedFamilies: ['late-night', 'item-favorite'],
          subjectGroup: 'late-night-items',
          subjectRank: index + 1,
          orderIds: orderIds(lateReceipts.filter((receipt) => receipt.items.some((candidate) => candidate.key === item.key))),
        },
      ),
    );

  const weekend = dataset.dated.filter(
    (receipt) => receipt.weekday === 'Saturday' || receipt.weekday === 'Sunday',
  ).length;
  const weekday = dataset.dated.length - weekend;
  const coveredWeeks =
    dataset.earliestDate && dataset.latestDate
      ? Math.max(1, daysBetween(dataset.earliestDate, dataset.latestDate) / 7)
      : 1;
  const weekendPerDay = weekend / Math.max(1, coveredWeeks * 2);
  const weekdayPerDay = weekday / Math.max(1, coveredWeeks * 5);
  if (
    dataset.dated.length >= 12 &&
    Math.max(weekendPerDay, weekdayPerDay) >= Math.min(weekendPerDay, weekdayPerDay) * 1.25
  )
    add(
      eligible,
      {
        id: 'weekend-personality',
        presentation: 'hero',
        category: 'habits',
        icon: 'calendar',
        eyebrow: 'Calendar personality',
        title: weekendPerDay > weekdayPerDay ? 'Weekend delivery mode' : 'Weekday survival mode',
        value: Math.round(
          (Math.max(weekendPerDay, weekdayPerDay) /
            Math.max(0.01, Math.min(weekendPerDay, weekdayPerDay)) -
            1) *
            100,
        ),
        valueFormat: 'percent',
        detail: `${weekend} weekend orders vs ${weekday} weekday orders, normalized for the number of days.`,
      },
      'weekend',
      64,
      { orderIds: orderIds(dataset.dated) },
    );

  if (dataset.earliestDate && daysBetween(dataset.earliestDate, dataset.localDate) >= 365)
    add(
      eligible,
      {
        id: 'first-order-anniversary',
        presentation: 'timeline',
        category: 'progress',
        icon: 'calendar',
        eyebrow: 'From the archives',
        title: 'Your first tracked order',
        detail: `${Math.floor(daysBetween(dataset.earliestDate, dataset.localDate) / 365.25)} years of delivery lore followed.`,
        events: [
          { label: 'It began', value: dateLabel(dataset.earliestDate) },
          { label: 'Restaurant', value: dataset.dated[0].restaurantLabel ?? 'Unknown restaurant' },
        ],
      },
      'anniversary',
      58,
      { orderIds: orderIds(dataset.dated.slice(0, 1)) },
    );
}

function addDeliveryStories(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
) {
  if (dataset.deliveryReceipts.length < 2) {
    suppressed.push({ id: 'delivery-stories', reason: 'missing_delivery_times' });
    return;
  }
  const waits = dataset.deliveryReceipts.map((receipt) => receipt.deliveryMinutes!);
  const totalMinutes = sum(waits);
  add(
    eligible,
    {
      id: 'accumulated-delivery-time',
      presentation: 'hero',
      category: 'extremes',
      icon: 'delivery',
      eyebrow: 'Waiting, accumulated',
      title: 'Your delivery-window lifetime',
      value: roundOne(totalMinutes / 60),
      valueFormat: 'hours',
      detail: `${waits.length} valid deliveries, averaging ${Math.round(totalMinutes / waits.length)} minutes from order to arrival.`,
    },
    'delivery-lifetime',
    89,
    { relatedFamilies: ['delivery-record'], orderIds: orderIds(dataset.deliveryReceipts) },
  );
  [...dataset.deliveryReceipts]
    .sort((a, b) => a.deliveryMinutes! - b.deliveryMinutes! || a.stableIndex - b.stableIndex)
    .slice(0, 3)
    .forEach((delivery, index) =>
      add(
        eligible,
        {
          id: index === 0 ? 'fastest-delivery' : `fastest-delivery-rank-${index + 1}`,
          presentation: 'hero',
          category: 'extremes',
          icon: 'delivery',
          eyebrow: index === 0 ? 'Personal speed record' : `Fast arrival #${index + 1}`,
          title:
            index === 0
              ? 'Blink and it arrived'
              : `Your ${index === 1 ? 'second' : 'third'}-fastest delivery`,
          value: delivery.deliveryMinutes!,
          valueFormat: 'minutes',
          headline: delivery.restaurantLabel,
          detail:
            index === 0
              ? 'Your fastest valid tracked delivery window.'
              : `Ranked #${index + 1} among valid delivery windows.`,
          period: delivery.localDate ? { startDate: delivery.localDate } : undefined,
        },
        'delivery-fastest',
        73 - index * 4,
        {
          relatedFamilies: ['delivery-record'],
          subjectGroup: 'fastest-deliveries',
          subjectRank: index + 1,
          orderIds: orderIds([delivery]),
        },
      ),
    );
  const overallMedian = median(waits);
  const restaurants = [...dataset.byBranch.entries()].flatMap(([key, receipts]) => {
    const valid = receipts.filter(
      (receipt) => receipt.deliveryMinutes !== undefined && receipt.merchantClass === 'restaurant',
    );
    if (valid.length < 3) return [];
    const restaurantWaits = valid.map((receipt) => receipt.deliveryMinutes!);
    const med = median(restaurantWaits);
    const deviations = restaurantWaits.map((wait) => Math.abs(wait - med));
    return [
      {
        key,
        label: valid[0].source.restaurantName ?? valid[0].restaurantLabel!,
        count: valid.length,
        median: med,
        spread: median(deviations),
        receipts: valid,
      },
    ];
  });
  [...restaurants].sort(
    (a, b) => a.median - b.median || b.count - a.count || a.key.localeCompare(b.key),
  ).slice(0, 3).forEach((fastestRegular, index) => {
    add(
      eligible,
      {
        id: rankedInsightId('fastest-regular', index),
        presentation: 'hero',
        category: 'favorites',
        icon: 'delivery',
        eyebrow: index === 0 ? 'Fastest regular' : `${rankLabel(index)}-fastest regular`,
        title: fastestRegular.label,
        value: Math.round(fastestRegular.median),
        valueFormat: 'minutes',
        detail: `${Math.abs(Math.round(overallMedian - fastestRegular.median))} minutes ${fastestRegular.median <= overallMedian ? 'faster than' : 'slower than'} your overall median.`,
        methodology: { sampleSize: fastestRegular.count },
      },
      'delivery-restaurant-speed',
      81 - index * 4,
      { subjectGroup: 'fastest-regulars', subjectRank: index + 1, relatedFamilies: ['delivery-fastest'], orderIds: orderIds(fastestRegular.receipts) },
    );
  });
  restaurants.filter((restaurant) => restaurant.spread <= 12)
    .sort((a, b) => a.spread - b.spread || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 3).forEach((reliable, index) => {
      add(
        eligible,
        {
          id: rankedInsightId('most-reliable-restaurant', index),
          presentation: 'hero',
          category: 'favorites',
          icon: 'delivery',
          eyebrow: index === 0 ? 'Most consistent delivery times' : `${rankLabel(index)}-most consistent delivery times`,
          title: reliable.label,
          value: Math.round(reliable.spread),
          valueFormat: 'minutes',
          detail: `Median absolute deviation: ${Math.round(reliable.spread)} minutes. Individual deliveries can vary more.`,
          methodology: { sampleSize: reliable.count },
        },
        'delivery-reliability',
        76 - index * 4,
        { subjectGroup: 'consistent-restaurants', subjectRank: index + 1, relatedFamilies: ['delivery-restaurant-speed'], orderIds: orderIds(reliable.receipts) },
      );
    });
  restaurants.filter((restaurant) => restaurant.spread >= 15)
    .sort((a, b) => b.spread - a.spread || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 3).forEach((unpredictable, index) => {
      add(
        eligible,
        {
          id: rankedInsightId('most-unpredictable-restaurant', index),
          presentation: 'hero',
          category: 'habits',
          icon: 'delivery',
          eyebrow: index === 0 ? 'Most unpredictable delivery times' : `${rankLabel(index)}-most unpredictable delivery times`,
          title: unpredictable.label,
          value: Math.round(unpredictable.spread),
          valueFormat: 'minutes',
          detail: `Ranked #${index + 1} by typical delivery-time variation among your regulars. Median absolute deviation: ${Math.round(unpredictable.spread)} minutes.`,
          methodology: { sampleSize: unpredictable.count },
        },
        'delivery-unpredictable',
        71 - index * 4,
        { subjectGroup: 'unpredictable-restaurants', subjectRank: index + 1, relatedFamilies: ['delivery-reliability'], orderIds: orderIds(unpredictable.receipts) },
      );
    });
}

function addInvestmentStory(
  dataset: DashboardDataset,
  eligible: InsightCandidate[],
  suppressed: SuppressedCandidate[],
  market?: InvestmentContext,
) {
  if (market?.mode === 'historical') {
    const result = calculateHistoricalInvestment(dataset.dated.filter(r => r.amountKnown).map(r => ({ amount: r.amount, date: r.localDate! })), dataset.currencyCode, market);
    const included = result ? dataset.dated.filter(r => r.amountKnown && r.amount > 0 && r.localDate! <= result.valuationDate) : [];
    if (!result || included.length < 5 || daysBetween(included.map(r => r.localDate!).sort()[0], result.valuationDate) < 180) {
      suppressed.push({ id: 'hypothetical-investment', reason: 'insufficient_history' }); return;
    }
    const chosen = result.outcomes[result.selectedBenchmark];
    const other = result.selectedBenchmark === 'sp500' ? 'nasdaq' : 'sp500';
    const money = (v: number) => new Intl.NumberFormat('en', { style: 'currency', currency: result.currencyCode }).format(v);
    add(eligible, {
      id: 'hypothetical-investment', presentation: 'comparison', category: 'progress', icon: 'trend',
      eyebrow: 'Alternate universe', title: 'If your orders were investments', currencyCode: result.currencyCode,
      historicalInvestment: result,
      detail: `Based on ${BENCHMARK_NAMES[result.selectedBenchmark]} performance through ${result.valuationDate}. Higher of the Nasdaq and S&P 500 scenarios. ${BENCHMARK_NAMES[other]}: ${money(result.outcomes[other].value)}.`,
      comparison: { variant: 'investment', current: chosen.value, previous: result.contributed, delta: chosen.gain,
        percentDelta: Math.round(chosen.gain / result.contributed * 100), direction: 'up', valueFormat: 'currency', currentLabel: "You'd have", previousLabel: 'You spent' },
      methodology: { sampleSize: result.contributionCount, assumption: INVESTMENT_METHODOLOGY },
    }, 'alternate-universe', 74, { orderIds: orderIds(included) });
    return;
  }

  if (
    dataset.dated.length < 5 ||
    !dataset.earliestDate ||
    daysBetween(dataset.earliestDate, dataset.localDate) < 180
  ) {
    suppressed.push({ id: 'hypothetical-investment', reason: 'insufficient_history' });
    return;
  }
  const investment = calculateHypotheticalInvestment(
    dataset.dated.map((receipt) => ({
      amount: receipt.amount,
      occurredAt: receipt.source.orderDate!,
    })),
    dataset.now,
  );
  const contributions = investment.contributed;
  const value = investment.futureValue;
  const gain = investment.gains;
  if (gain < 10) {
    suppressed.push({ id: 'hypothetical-investment', reason: 'low_signal' });
    return;
  }
  add(
    eligible,
    {
      id: 'hypothetical-investment',
      presentation: 'comparison',
      category: 'progress',
      icon: 'trend',
      eyebrow: 'Alternate universe',
      title: 'If your orders were investments',
      detail: `At a fixed ${HYPOTHETICAL_ANNUAL_RETURN_PERCENT}% yearly return from each order date.`,
      comparison: {
        variant: 'investment',
        current: roundMoney(value),
        previous: roundMoney(contributions),
        delta: roundMoney(gain),
        percentDelta: Math.round((gain / contributions) * 100),
        direction: 'up',
        valueFormat: 'currency',
        currentLabel: "You'd have",
        previousLabel: 'You spent',
      },
      methodology: {
        sampleSize: dataset.dated.length,
        assumption: `${HYPOTHETICAL_ANNUAL_RETURN_PERCENT}% fixed average annual return; excludes volatility, taxes, and fees.`,
        disclaimer: 'For fun—not financial advice.',
      },
    },
    'alternate-universe',
    74,
    { orderIds: orderIds(dataset.dated) },
  );
}

function addLockedCandidate(dataset: DashboardDataset, eligible: InsightCandidate[]) {
  if (dataset.sourceCoverage !== 'email') return;
  add(
    eligible,
    {
      id: 'locked-menu-soulmate',
      presentation: 'locked',
      category: 'favorites',
      icon: 'lock',
      eyebrow: 'Hidden in your history',
      title: 'What is your exact menu soulmate?',
      detail: 'An Uber data export includes the items needed to find your most repeated basket.',
      action: 'open_export',
    },
    'locked-export',
    20,
    { locked: true },
  );
  add(
    eligible,
    {
      id: 'locked-item-obsession',
      presentation: 'locked',
      category: 'favorites',
      icon: 'lock',
      eyebrow: 'Quantity unknown',
      title: 'How many hash browns are in your history?',
      detail: 'Export item details can reveal the physical totals hiding in your order history.',
      action: 'open_export',
    },
    'locked-export',
    20,
    { locked: true },
  );
  add(
    eligible,
    {
      id: 'locked-delivery-record',
      presentation: 'locked',
      category: 'extremes',
      icon: 'lock',
      eyebrow: 'Worth the wait?',
      title: 'Which delivery took the longest?',
      detail: 'Upload an Uber export to unlock delivery-window records.',
      action: 'open_export',
    },
    'locked-export',
    20,
    { locked: true },
  );
}

/** Descriptive insights use explicit populations; they do not claim causal effects. */
function addCostDistributionStories(dataset: DashboardDataset, eligible: InsightCandidate[]) {
  const paid = dataset.positive;
  const total = paid.reduce((sum, r) => sum + r.amount, 0);
  if (paid.length >= 10 && total > 0) {
    const largest = [...paid]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, Math.ceil(paid.length * 0.1));
    add(
      eligible,
      {
        id: 'spending-concentration',
        presentation: 'hero',
        category: 'habits',
        icon: 'receipt',
        eyebrow: 'The big orders',
        title: 'Your largest orders',
        value: Math.round((largest.reduce((sum, r) => sum + r.amount, 0) / total) * 100),
        valueFormat: 'percent',
        spendingConcentration: { orderCount: largest.length },
        detail: `Your largest ${largest.length} orders account for this share of recorded spending.`,
        methodology: { sampleSize: paid.length },
      },
      'spending-concentration',
      75,
      { orderIds: orderIds(largest) },
    );
  }
  const currentMonth = dataset.localDate.slice(0, 7);
  const previousMonth = shiftLocalDate(`${currentMonth}-01`, -1).slice(0, 7);
  const lastPreviousDay = Number(shiftLocalDate(`${currentMonth}-01`, -1).slice(8, 10));
  const day = Math.min(Number(dataset.localDate.slice(8, 10)), lastPreviousDay);
  const a = dataset.dated.filter(
    (r) => r.localMonth === previousMonth && Number(r.localDate!.slice(8, 10)) <= day,
  );
  const b = dataset.dated.filter(
    (r) => r.localMonth === currentMonth && Number(r.localDate!.slice(8, 10)) <= day,
  );
  if (a.length && b.length) {
    const av = a.reduce((s, r) => s + r.amount, 0) / a.length,
      bv = b.reduce((s, r) => s + r.amount, 0) / b.length;
    const countEffect = roundMoney(((b.length - a.length) * (av + bv)) / 2);
    const totalChange = roundMoney(b.length * bv - a.length * av);
    add(
      eligible,
      {
        id: 'spending-change-decomposition',
        presentation: 'hero',
        category: 'progress',
        icon: 'trend',
        eyebrow: 'What changed',
        title: 'Ordering frequency and average cost',
        value: totalChange,
        valueFormat: 'currency',
        detail: `Frequency accounts for ${countEffect.toFixed(2)} ${dataset.currencyCode}; average order cost accounts for ${roundMoney(totalChange - countEffect).toFixed(2)} ${dataset.currencyCode}. Compared through day ${day}; descriptive, not causal.`,
      },
      'spending-decomposition',
      77,
      { orderIds: orderIds([...a, ...b]) },
    );
  }
}

function addDeliveryDistributionStories(dataset: DashboardDataset, eligible: InsightCandidate[]) {
  const waits = dataset.deliveryReceipts.map((r) => r.deliveryMinutes!).sort((a, b) => a - b);
  if (waits.length >= 10)
    add(
      eligible,
      {
        id: 'delivery-typical-slow',
        presentation: 'comparison',
        category: 'habits',
        icon: 'delivery',
        eyebrow: 'Delivery expectations',
        title: 'Typical versus slow deliveries',
        detail: 'Nine in ten recorded delivery windows were at or below the slow threshold.',
        comparison: {
          current: waits[Math.ceil(waits.length * 0.9) - 1],
          previous: median(waits),
          delta: waits[Math.ceil(waits.length * 0.9) - 1] - median(waits),
          direction: 'up',
          percentDelta: null,
          valueFormat: 'number',
          currentLabel: '90th percentile (min)',
          previousLabel: 'Median (min)',
        },
        methodology: { sampleSize: waits.length },
      },
      'delivery-distribution',
      75,
      { orderIds: orderIds(dataset.deliveryReceipts) },
    );
}

/** Each builder receives its named population; no receipt-row count is a delivery count. */
function buildOrderEventCatalogue(dataset: DashboardDataset, market?: InvestmentContext): CandidateCatalogue {
  const eligible: InsightCandidate[] = [];
  const suppressed: SuppressedCandidate[] = [];
  const metrics = dataset.orderMetrics!;
  const deliveries = dashboardCohort(dataset, 'deliveries');
  const restaurants = dashboardCohort(dataset, 'restaurants');
  const costs = dashboardCohort(dataset, 'net-cost');

  // Eligibility belongs to each story's population. An unrelated uncertain
  // receipt must not replace the catalogue with account-wide diagnostics.
  const append = (cohort: DashboardDataset, build: (candidates: InsightCandidate[]) => void) => {
    const candidates: InsightCandidate[] = [];
    build(candidates);
    for (const candidate of candidates) {
      candidate.insight.currencyCode = dataset.currencyCode;
      if (cohort.cohort === 'net-cost') {
        candidate.insight.methodology = {
          ...candidate.insight.methodology,
          estimated: cohort.receipts.some((r) => orderMetricEligibility(r.source).estimatedAmount),
          assumption: [candidate.insight.methodology?.assumption, 'Based on recorded order costs in the displayed currency, after refunds.'].filter(Boolean).join(' '),
        };
      }
    }
    eligible.push(...candidates);
  };

  append(deliveries, (candidates) => {
    addMerchantFavorites(deliveries, candidates, suppressed);
    addCalendarHabits(deliveries, candidates, suppressed);
    addTimingStories(deliveries, candidates, suppressed);
    addRecentFrequency(deliveries, candidates);
    addDeliveryRecords(deliveries, candidates);
    addDeliveryStories(deliveries, candidates, suppressed);
    addDeliveryDistributionStories(deliveries, candidates);
  });
  append(restaurants, (candidates) => {
    addRestaurantStories(restaurants, candidates, suppressed);
    addItemFavorites(restaurants, candidates, suppressed);
    addItemAndBasketStories(restaurants, candidates, suppressed);
  });
  if (dataset.currencyCode !== 'UNKNOWN') {
    append(costs, (candidates) => {
      addCostRecords(costs, candidates);
      addRecentMovement(costs, candidates, suppressed);
      addInvestmentStory(costs, candidates, suppressed, market);
      addCostDistributionStories(costs, candidates);
    });
  }

  // Outcomes are one optional insight among the existing families, not a
  // permanent dashboard panel or a substitute for the user's other stories.
  if (metrics.canceled || metrics.confirmedRefunds) {
    add(
      eligible,
      {
        id: 'refunds-and-cancellations',
        presentation: 'timeline',
        category: 'progress',
        icon: 'receipt',
        eyebrow: 'Along the way',
        title: 'Refunds and cancellations',
        detail: 'Not every order went to plan.',
        events: [
          ...(metrics.canceled ? [{ label: 'Canceled orders', value: metrics.canceled }] : []),
          ...(metrics.confirmedRefunds ? [{ label: 'Refunded orders', value: metrics.confirmedRefunds }] : []),
          ...metrics.currencies.flatMap((currency) =>
            currency.currencyCode !== 'UNKNOWN' && currency.confirmedRefundAmount > 0
              ? [{ label: `Refunded · ${currency.currencyCode}`, value: currency.confirmedRefundAmount.toFixed(2) }]
              : [],
          ),
        ],
      },
      'refunds-cancellations',
      65,
      {
        orderIds: orderIds(dataset.receipts.filter((receipt) =>
          matchesReceiptOutcome(receipt.source, 'canceled') || matchesReceiptOutcome(receipt.source, 'refunded'))),
      },
    );
  }
  addLockedCandidate(dataset, eligible);
  return { eligible, suppressed };
}

export function buildCandidateCatalogue(dataset: DashboardDataset, market?: InvestmentContext): CandidateCatalogue {
  const eligible: InsightCandidate[] = [];
  const suppressed: SuppressedCandidate[] = [];
  if (!dataset.receipts.length)
    return { eligible, suppressed: [{ id: 'all', reason: 'insufficient_history' }] };
  if (dataset.orderMetrics) return buildOrderEventCatalogue(dataset, market);
  addMerchantFavorites(dataset, eligible, suppressed);
  addCalendarHabits(dataset, eligible, suppressed);
  addCostRecords(dataset, eligible);
  addItemFavorites(dataset, eligible, suppressed);
  addDeliveryRecords(dataset, eligible);
  addRecentMovement(dataset, eligible, suppressed);
  addRecentFrequency(dataset, eligible);
  addRestaurantStories(dataset, eligible, suppressed);
  addItemAndBasketStories(dataset, eligible, suppressed);
  addTimingStories(dataset, eligible, suppressed);
  addDeliveryStories(dataset, eligible, suppressed);
  addInvestmentStory(dataset, eligible, suppressed, market);
  addLockedCandidate(dataset, eligible);
  addCostDistributionStories(dataset, eligible);
  addDeliveryDistributionStories(dataset, eligible);
  const estimated = dataset.receipts.some(
    (r) => r.source.resolution?.amountBasis !== 'receipt_total',
  );
  for (const candidate of eligible) {
    const insight = candidate.insight;
    insight.currencyCode = dataset.currencyCode;
    const currency =
      (insight.presentation === 'hero' && insight.valueFormat === 'currency') ||
      (insight.presentation === 'comparison' && insight.comparison.valueFormat === 'currency');
    if (currency)
      insight.methodology = {
        ...insight.methodology,
        estimated,
        assumption: `${dataset.currencyCode}; ${estimated ? 'best available receipt/export amounts' : 'receipt totals'}. Other currencies are separate.`,
      };
  }
  return { eligible, suppressed };
}
