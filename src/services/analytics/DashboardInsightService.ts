import { DataSource, Receipt } from '../../models/Receipt';
import { getLocalDateKey, getLocalDateTimeParts } from '../../utils/timezone';

export type DashboardInsightCategory = 'favorites' | 'habits' | 'extremes' | 'progress';
export type DashboardInsightIcon = 'restaurant' | 'time' | 'calendar' | 'moon' | 'heart' | 'receipt' | 'meal' | 'delivery' | 'lock';

export interface DashboardInsightRankingRow {
  label: string;
  count: number;
  amount: number;
}

export interface DashboardInsight {
  id: string;
  category: DashboardInsightCategory;
  kind: 'ranking' | 'stat' | 'order' | 'locked';
  icon: DashboardInsightIcon;
  eyebrow: string;
  title: string;
  headline?: string;
  detail?: string;
  value?: number;
  valueFormat?: 'currency' | 'number' | 'percent' | 'minutes';
  rows?: DashboardInsightRankingRow[];
  items?: string[];
  locked?: boolean;
  action?: 'open_export';
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rotate<T>(items: T[], seed: string): T[] {
  if (items.length < 2) return items;
  const offset = stableHash(seed) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function weekKey(now: Date, timezone: string): string {
  const localDate = getLocalDateKey(now, timezone) ?? now.toISOString().slice(0, 10);
  const date = new Date(`${localDate}T00:00:00.000Z`);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date.getTime() - yearStart.getTime()) / 86_400_000);
  return `${date.getUTCFullYear()}-${Math.floor(day / 7)}`;
}

function validRestaurant(name?: string): name is string {
  const trimmed = name?.trim();
  return Boolean(trimmed && /[\p{L}\p{N}]/u.test(trimmed) && trimmed.toLowerCase() !== 'unknown restaurant');
}

function validItemName(name?: string): name is string {
  const trimmed = name?.trim();
  return Boolean(trimmed && trimmed.toLowerCase() !== 'unknown');
}

/**
 * Builds the small, dashboard-specific insight set. The dashboard consumes
 * this contract directly so metric eligibility stays on the server alongside
 * the slideshow calculations and timezone rules.
 */
export function buildDashboardInsights(
  receipts: Receipt[],
  timezone: string,
  userId: string,
  now: Date = new Date()
): DashboardInsight[] {
  const datedReceipts = receipts.filter((receipt): receipt is Receipt & { orderDate: Date } => Boolean(receipt.orderDate));
  if (receipts.length === 0) return [];

  const restaurantStats = new Map<string, { label: string; count: number; amount: number }>();
  for (const receipt of receipts) {
    if (!validRestaurant(receipt.restaurantName)) continue;
    const label = receipt.restaurantName.trim();
    const key = label.toLocaleLowerCase('en-US');
    const current = restaurantStats.get(key) ?? { label, count: 0, amount: 0 };
    current.count += 1;
    current.amount += receipt.amountSpent;
    restaurantStats.set(key, current);
  }

  const topRestaurants = [...restaurantStats.values()]
    .sort((a, b) => b.count - a.count || b.amount - a.amount || a.label.localeCompare(b.label))
    .slice(0, 3);

  const anchor: DashboardInsight[] = topRestaurants.length > 0 ? [{
    id: 'top-restaurants',
    category: 'favorites',
    kind: 'ranking',
    icon: 'restaurant',
    eyebrow: 'Your regulars',
    title: 'Top restaurants',
    rows: topRestaurants.map(({ label, count, amount }) => ({ label, count, amount: roundMoney(amount) })),
  }] : [];

  const basic: DashboardInsight[] = [];

  if (datedReceipts.length >= 3) {
    const weekdayCounts = new Map<string, number>();
    const hourCounts = new Map<number, number>();
    const monthCounts = new Map<string, number>();
    let nightOrders = 0;

    for (const receipt of datedReceipts) {
      const parts = getLocalDateTimeParts(receipt.orderDate, timezone);
      const dateKey = getLocalDateKey(receipt.orderDate, timezone);
      if (!parts || !dateKey) continue;
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(receipt.orderDate);
      weekdayCounts.set(weekday, (weekdayCounts.get(weekday) ?? 0) + 1);
      hourCounts.set(parts.hour, (hourCounts.get(parts.hour) ?? 0) + 1);
      monthCounts.set(dateKey.slice(0, 7), (monthCounts.get(dateKey.slice(0, 7)) ?? 0) + 1);
      if (parts.hour >= 22 || parts.hour < 4) nightOrders += 1;
    }

    const favoriteDay = [...weekdayCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (favoriteDay) {
      basic.push({
        id: 'favorite-day', category: 'habits', kind: 'stat', icon: 'calendar', eyebrow: 'Weekly ritual',
        title: 'Your delivery day', headline: favoriteDay[0],
        detail: `${favoriteDay[1]} of your tracked orders landed on ${favoriteDay[0]}s.`,
      });
    }

    const peakHour = [...hourCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (peakHour) {
      const display = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone: 'UTC' })
        .format(new Date(Date.UTC(2020, 0, 1, peakHour[0])));
      basic.push({
        id: 'peak-hunger-hour', category: 'habits', kind: 'stat', icon: 'time', eyebrow: 'Peak hunger',
        title: 'Your usual order time', headline: display,
        detail: `${peakHour[1]} tracked orders were placed during this hour.`,
      });
    }

    if (nightOrders >= 3) {
      basic.push({
        id: 'night-owl', category: 'habits', kind: 'stat', icon: 'moon', eyebrow: 'After hours',
        title: 'Night owl', value: Math.round((nightOrders / datedReceipts.length) * 100), valueFormat: 'percent',
        detail: `${nightOrders} tracked orders were placed between 10 PM and 4 AM.`,
      });
    }

    const busiestMonth = [...monthCounts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
    if (busiestMonth) {
      const [year, month] = busiestMonth[0].split('-').map(Number);
      const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(Date.UTC(year, month - 1, 1)));
      basic.push({
        id: 'busiest-month', category: 'progress', kind: 'stat', icon: 'calendar', eyebrow: 'Peak season',
        title: 'Your busiest month', headline: label,
        detail: `${busiestMonth[1]} tracked orders in one month.`,
      });
    }
  }

  if (topRestaurants[0] && receipts.length >= 3) {
    const percentage = Math.round((topRestaurants[0].count / receipts.length) * 100);
    basic.push({
      id: 'restaurant-loyalty', category: 'favorites', kind: 'stat', icon: 'heart', eyebrow: 'Creature of habit',
      title: 'Your number one', headline: topRestaurants[0].label,
      detail: `${percentage}% of your tracked orders came from this restaurant.`,
    });
  }

  const mostExpensive = receipts
    .filter(receipt => validRestaurant(receipt.restaurantName))
    .sort((a, b) => b.amountSpent - a.amountSpent)[0];
  if (mostExpensive) {
    basic.push({
      id: 'biggest-splurge', category: 'extremes', kind: 'order', icon: 'receipt', eyebrow: 'Biggest splurge',
      title: mostExpensive.restaurantName!.trim(), value: roundMoney(mostExpensive.amountSpent), valueFormat: 'currency',
      detail: mostExpensive.orderDate
        ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' }).format(mostExpensive.orderDate)
        : undefined,
    });
  }

  const exportReceipts = receipts.filter(receipt => receipt.dataSource === DataSource.CSV);
  const rich: DashboardInsight[] = [];
  if (exportReceipts.length > 0) {
    const itemCounts = new Map<string, { label: string; count: number }>();
    for (const receipt of exportReceipts) {
      for (const item of receipt.items) {
        if (!validItemName(item.name)) continue;
        const label = item.name.trim();
        const key = label.toLocaleLowerCase('en-US');
        const current = itemCounts.get(key) ?? { label, count: 0 };
        current.count += Math.max(1, item.quantity);
        itemCounts.set(key, current);
      }
    }
    const mostOrdered = [...itemCounts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
    if (mostOrdered && mostOrdered.count >= 2) {
      rich.push({
        id: 'most-ordered-meal', category: 'favorites', kind: 'stat', icon: 'meal', eyebrow: 'Signature order',
        title: 'Your most ordered meal', headline: mostOrdered.label,
        detail: `Ordered ${mostOrdered.count} times across your export.`,
      });
    }

    const detailedWorst = exportReceipts
      .filter(receipt => validRestaurant(receipt.restaurantName) && receipt.items.some(item => validItemName(item.name)))
      .sort((a, b) => b.amountSpent - a.amountSpent)[0];
    if (detailedWorst) {
      const time = detailedWorst.orderDate
        ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(detailedWorst.orderDate)
        : undefined;
      rich.push({
        id: 'worst-order', category: 'extremes', kind: 'order', icon: 'receipt', eyebrow: 'We need to talk',
        title: 'Your worst order', value: roundMoney(detailedWorst.amountSpent), valueFormat: 'currency',
        headline: detailedWorst.restaurantName!.trim(), detail: time,
        items: detailedWorst.items.filter(item => validItemName(item.name)).slice(0, 3).map(item => `${item.quantity > 1 ? `${item.quantity}× ` : ''}${item.name.trim()}`),
      });
    }

    const waits = exportReceipts.flatMap(receipt => {
      if (!receipt.orderDate || !receipt.deliveryTime) return [];
      const minutes = Math.round((receipt.deliveryTime.getTime() - receipt.orderDate.getTime()) / 60_000);
      return minutes > 0 && minutes <= 720 ? [{ receipt, minutes }] : [];
    });
    if (waits.length >= 2) {
      const longest = waits.sort((a, b) => b.minutes - a.minutes)[0];
      rich.push({
        id: 'longest-wait', category: 'extremes', kind: 'stat', icon: 'delivery', eyebrow: 'Worth the wait?',
        title: 'Your longest delivery', value: longest.minutes, valueFormat: 'minutes',
        detail: validRestaurant(longest.receipt.restaurantName) ? `From ${longest.receipt.restaurantName!.trim()}.` : undefined,
      });
    }
  }

  const seed = `${userId}:${weekKey(now, timezone)}`;
  const selectedBasic = rotate(basic, `${seed}:basic`).slice(0, 3);
  const selectedRich = rotate(rich, `${seed}:rich`).slice(0, 2);
  const insights = [...anchor, ...selectedBasic, ...selectedRich].slice(0, 6);

  // A locked preview appears in two out of every three weekly rotations and is
  // always placed last, so it never crowds out the user's real insights.
  if (exportReceipts.length === 0 && receipts.length >= 3 && stableHash(`${seed}:locked`) % 3 !== 0) {
    const lockedOptions: DashboardInsight[] = [
      { id: 'locked-most-ordered-meal', category: 'favorites', kind: 'locked', icon: 'lock', eyebrow: 'Hidden in your history', title: 'What meal do you order most?', detail: 'Your Uber export includes the menu items needed to reveal it.', locked: true, action: 'open_export' },
      { id: 'locked-worst-order', category: 'extremes', kind: 'locked', icon: 'lock', eyebrow: 'We found the receipt', title: 'Unlock your worst order', detail: 'See the time, restaurant, and everything that was in the order.', locked: true, action: 'open_export' },
      { id: 'locked-longest-wait', category: 'extremes', kind: 'locked', icon: 'lock', eyebrow: 'Worth the wait?', title: 'Which delivery took the longest?', detail: 'Upload your Uber data to unlock delivery-time insights.', locked: true, action: 'open_export' },
    ];
    insights.splice(Math.min(5, insights.length), 0, rotate(lockedOptions, `${seed}:locked-choice`)[0]);
  }

  return insights.slice(0, 6);
}
