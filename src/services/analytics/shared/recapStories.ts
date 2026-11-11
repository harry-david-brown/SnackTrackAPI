import type { ReceiptForAnalytics, WrappedAnalytics } from '../WrappedAnalyticsTypes';
import type { RecapCurrency, RecapRateSnapshot } from '../../ports/RecapExchangeRatesPort';
import { orderMetricEligibility, hasOrderTimeEvidence } from './orderMetrics';
import {
  RECAP_POLICY_VERSION,
  recapMedian,
  scoreRecapStory,
  type RecapScoreInput,
} from './recapScoring';
import { canonicalBasketKey, normalizeItem } from '../dashboard/normalization';
import { merchantIdentity } from '../../receipt/ReceiptObservationMatching';
import { isSingleItemOrder, singleItemDisplayName } from './singleItemOrders';
import { isLateNightHour } from './timeWindows';
import { overnightMinute, currencyOf, spendingByCurrency } from './receiptMetrics';
import { usesOrderEventMetrics } from './orderMetrics';
import { getLocalDateKey, getLocalMinuteOfDay } from '../../../utils/timezone';

export interface RecapDayOrder {
  id: string;
  restaurant: string;
  /** Local placement time (HH:mm); absent for date-only evidence. */
  localTime?: string;
}

export interface RecapEvidenceOrder extends RecapDayOrder {
  date?: string;
  amount?: number;
  approximate?: boolean;
  items?: { name: string; quantity: number }[];
}

export interface RecapEvidence {
  kind: 'receipt' | 'items' | 'late-night' | 'spending' | 'single-items' | 'streak';
  orders: RecapEvidenceOrder[];
  total: number;
}

export interface RecapStory {
  id: string;
  category: 'perspective' | 'trend' | 'places' | 'habit' | 'pattern' | 'extreme-moment';
  family: string;
  subject?: string;
  overlaps: string[];
  specificity: number;
  score: number;
  title: string;
  value: number | string;
  format: 'number' | 'money' | 'text';
  label: string;
  detail: string;
  punchline: string;
  approximate?: boolean;
  orders?: RecapDayOrder[];
  evidence?: RecapEvidence;
  supportingMoney?: { amount: number; approximate: boolean; label: string };
  startDate?: string;
  endDate?: string;
  fallbackOrder?: number;
  protected?: boolean;
}
export interface RecapStoryCollection {
  version: 1;
  currency: RecapCurrency;
  rateSnapshot: string;
  spending: {
    amount: number;
    approximate: boolean;
    pricedOrders: number;
    missingPrices: number;
    assumedCurrencies: number;
  };
  stories: RecapStory[];
}
export interface RecapCoverageInterval {
  provider: string;
  start: string;
  end: string;
}
const dayNumber = (s: string) => Math.floor(Date.parse(`${s}T12:00:00Z`) / 86400000);
const dayString = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const supported = (s: string | null | undefined): s is RecapCurrency =>
  ['CAD', 'USD', 'EUR', 'GBP'].includes(s ?? '');

export function recapOriginalAmount(r: ReceiptForAnalytics): number | null {
  const o = r.resolution?.orderOutcome;
  if (o?.financialConfidence !== 'conflicted') {
    if (o?.originalCharge != null) return o.originalCharge;
    // Reconstruct only an established balance equation, never sum receipt revisions.
    if (
      o?.netAmount != null &&
      o.confirmedRefundAmount != null &&
      !o.events.some((e) => e.kind === 'charge_adjustment' || e.kind === 'refund_reversal')
    )
      return money(o.netAmount + o.confirmedRefundAmount);
  }
  const candidates = [
    r.resolution?.receiptTotal,
    o?.netAmount,
    r.resolution?.exportedTotal,
    o && o.netAmount === null && r.amountSpent === 0 ? null : r.amountSpent,
  ];
  return candidates.find((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) ?? null;
}

export function buildRecapStories(
  input: readonly ReceiptForAnalytics[],
  timezone: string,
  currency: RecapCurrency,
  rates: RecapRateSnapshot,
  legacy: WrappedAnalytics,
  coverage: readonly RecapCoverageInterval[] = [],
  now = new Date(),
): RecapStoryCollection {
  const unique = [...new Map(input.map((r) => [r.id, r])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const convert = (amount: number | null, from: RecapCurrency, to = currency): number | null => {
    if (amount === null) return null;
    if (from === to) return amount;
    const f = rates.rates[from],
      t = rates.rates[to];
    return f && t ? (amount * t) / f : null;
  };
  const records = unique
    .filter((r) => orderMetricEligibility(r).establishedAttempt)
    .map((r) => {
      const net = orderMetricEligibility(r).netAmount;
      const knownCurrency = supported(r.currencyCode);
      const source: RecapCurrency = supported(r.currencyCode) ? r.currencyCode : currency;
      const amount = convert(net, source);
      const outcome = r.resolution?.orderOutcome;
      const refunded = Boolean(
        outcome && ['full', 'partial', 'confirmed_unclassified'].includes(outcome.refundStatus),
      );
      const day =
        r.orderDate && Number.isFinite(r.orderDate.getTime())
          ? getLocalDateKey(
              r.orderDate,
              r.resolution?.timestamp?.timezone ?? r.timezone ?? timezone,
            )
          : undefined;
      const restaurant = merchantIdentity(r.restaurantName ?? undefined);
      return {
        r,
        amount,
        cad: convert(net, source, 'CAD'),
        day: day || undefined,
        restaurant,
        delivered: orderMetricEligibility(r).delivered,
        refunded,
        refund: refunded ? convert(outcome?.confirmedRefundAmount ?? null, source) : null,
        assumed: !knownCurrency,
        approximate:
          !knownCurrency ||
          source !== currency ||
          amount === null ||
          !outcome ||
          outcome.netAmount === null ||
          outcome.financialConfidence !== 'confirmed',
      };
    });
  type R = (typeof records)[number];
  const deliveries = records.filter((r) => r.delivered);
  const priced = records.filter((r) => r.amount !== null);
  const spend = (rs: R[]) => money(sum(rs.map((r) => r.amount ?? 0)));
  const approx = (rs: R[]) => rs.some((r) => r.approximate);
  const groups = (rs: R[], key: (r: R) => string | undefined) => {
    const map = new Map<string, R[]>();
    for (const r of rs) {
      const k = key(r);
      if (k) map.set(k, [...(map.get(k) ?? []), r]);
    }
    return [...map.entries()].sort(
      ([a, ar], [b, br]) => br.length - ar.length || a.localeCompare(b),
    );
  };
  const stories: RecapStory[] = [];
  const add = (
    story: Omit<RecapStory, 'score' | 'overlaps' | 'specificity'> &
      Partial<Pick<RecapStory, 'overlaps' | 'specificity'>>,
    score: RecapScoreInput,
  ) => {
    stories.push({ overlaps: [], specificity: 1, ...story, score: scoreRecapStory(score).score });
  };
  const dayGroups = groups(deliveries, (r) => r.day);
  const bestDay = dayGroups[0];
  if (bestDay && bestDay[1].length >= 3)
    add(
      {
        id: 'most-deliveries-day',
        category: 'extreme-moment',
        family: 'busy-day',
        title: 'ONE BUSY DAY.',
        value: bestDay[1].length,
        format: 'number',
        label: 'completed deliveries',
        detail: 'In your tracked history',
        punchline: 'Your doorbell worked overtime.',
        startDate: bestDay[0],
        orders: bestDay[1]
          .map(({ r }) => {
            const localTime =
              hasOrderTimeEvidence(r) && r.orderDate
                ? new Intl.DateTimeFormat('en-GB', {
                    timeZone: r.resolution?.timestamp?.timezone ?? r.timezone ?? timezone,
                    hour: '2-digit',
                    minute: '2-digit',
                    hourCycle: 'h23',
                  }).format(r.orderDate)
                : undefined;
            return {
              id: r.id,
              restaurant: r.restaurantName?.trim() || 'Unknown restaurant',
              localTime,
            };
          })
          .sort(
            (a, b) =>
              (a.localTime ?? '99:99').localeCompare(b.localTime ?? '99:99') ||
              a.id.localeCompare(b.id),
          ),
        protected: true,
      },
      {
        value: bestDay[1].length,
        baseline: recapMedian(dayGroups.slice(1).map((g) => g[1].length)),
        comparisonCount: dayGroups.length - 1,
        magnitude: (bestDay[1].length / 5) * 100,
      },
    );
  const restaurants = groups(deliveries, (r) => r.restaurant);
  const top = restaurants[0];
  if (top && top[1].length >= 10)
    add(
      {
        id: 'restaurant-loyalty',
        category: 'habit',
        family: 'restaurant',
        subject: top[0],
        overlaps: ['chain-dependency', 'top-spots'],
        specificity: 2,
        title: 'YOUR USUAL.',
        value: top[1].length,
        format: 'number',
        label: 'orders from one restaurant',
        detail: top[1][0].r.restaurantName ?? '',
        punchline: 'At this point, you have a usual.',
      },
      {
        share: top[1].length / deliveries.length,
        denominator: deliveries.length,
        magnitude: (top[1].length / 50) * 100,
      },
    );

  const itemized = deliveries.filter(
    (r) =>
      r.r.items.length > 0 &&
      r.r.items.every(
        (i) => i.name.trim() && i.quantity > 0 && i.evidence?.method !== 'preserved_ambiguous',
      ),
  );
  const baskets = groups(itemized, (r) =>
    canonicalBasketKey(
      `${r.r.receiptType}:${r.restaurant}`,
      r.r.items
        .map((item) => normalizeItem(item, r.r))
        .filter((i): i is NonNullable<typeof i> => i !== null),
    ),
  );
  const basket = baskets[0];
  if (basket && basket[1].length >= 5)
    add(
      {
        id: 'repeated-basket',
        category: 'habit',
        family: 'menu',
        subject: basket[1][0].restaurant,
        overlaps: ['single-item-orders', 'coffee-addiction'],
        specificity: 3,
        title: 'ON REPEAT.',
        value: basket[1].length,
        format: 'number',
        label: 'times you ordered this meal',
        detail: `${basket[1][0].r.restaurantName}: ${basket[1][0].r.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}`,
        punchline: 'Why interrupt a good thing?',
      },
      {
        share: basket[1].length / itemized.length,
        denominator: itemized.length,
        magnitude: (basket[1].length / 20) * 100,
      },
    );

  const dated = records
    .filter((r) => r.day)
    .sort((a, b) => a.day!.localeCompare(b.day!) || a.r.id.localeCompare(b.r.id));
  const covered = (start: string, end: string) =>
    [...new Set(records.map((r) => r.r.receiptType))].every((provider) =>
      coverage.some(
        (c) =>
          c.provider === provider && c.start.slice(0, 10) <= start && c.end.slice(0, 10) >= end,
      ),
    );
  const windows = [...new Set(dated.map((r) => r.day!))].map((start) => ({
    start,
    end: dayString(dayNumber(start) + 6),
    rs: dated.filter(
      (r) => dayNumber(r.day!) >= dayNumber(start) && dayNumber(r.day!) <= dayNumber(start) + 6,
    ),
  }));
  const bestWeek = windows
    .filter((w) => w.rs.length >= 3 && spend(w.rs) > 0)
    .sort((a, b) => spend(b.rs) - spend(a.rs) || a.start.localeCompare(b.start))[0];
  if (bestWeek) {
    const peers: number[] = [];
    let previousEnd = '';
    for (const w of windows)
      if (
        w.start > previousEnd &&
        (w.end < bestWeek.start || w.start > bestWeek.end) &&
        covered(w.start, w.end)
      ) {
        peers.push(spend(w.rs));
        previousEnd = w.end;
      }
    add(
      {
        id: 'spending-burst',
        category: 'extreme-moment',
        family: 'spending',
        title: 'ONE WEEK.',
        value: spend(bestWeek.rs),
        format: 'money',
        label: `${bestWeek.rs.length} orders in seven days`,
        detail: 'In your tracked history',
        punchline: 'That was quite a week.',
        startDate: bestWeek.start,
        endDate: bestWeek.end,
        approximate: approx(bestWeek.rs),
      },
      {
        value: spend(bestWeek.rs),
        baseline: recapMedian(peers),
        comparisonCount: peers.length,
        magnitude: (sum(bestWeek.rs.map((r) => r.cad ?? 0)) / 1000) * 100,
      },
    );
  }
  const streaks: { start: string; end: string; length: number }[] = [];
  for (const day of dayGroups.map((g) => g[0]).sort()) {
    const last = streaks[streaks.length - 1];
    if (last && dayNumber(day) === dayNumber(last.end) + 1) {
      last.end = day;
      last.length++;
    } else streaks.push({ start: day, end: day, length: 1 });
  }
  streaks.sort((a, b) => b.length - a.length || a.start.localeCompare(b.start));
  if (streaks[0]?.length >= 5) {
    const s = streaks[0];
    add(
      {
        id: 'longest-streak',
        category: 'habit',
        family: 'frequency',
        title: 'THE ROUTINE.',
        value: s.length,
        format: 'number',
        label: 'consecutive delivery days',
        detail: 'A delivery on every one of them',
        punchline: 'Consistency is a skill.',
        startDate: s.start,
        endDate: s.end,
      },
      {
        value: s.length,
        baseline: recapMedian(streaks.slice(1).map((s) => s.length)),
        comparisonCount: streaks.length - 1,
        magnitude: (s.length / 30) * 100,
      },
    );
  }
  const spendingRestaurants = groups(priced, (r) => r.restaurant).sort(
    (a, b) => spend(b[1]) - spend(a[1]) || a[0].localeCompare(b[0]),
  );
  const concentration = spendingRestaurants[0];
  if (
    priced.length >= 10 &&
    concentration &&
    spend(priced) > 0 &&
    spend(concentration[1]) / spend(priced) >= 0.3
  )
    add(
      {
        id: 'restaurant-concentration',
        category: 'habit',
        family: 'restaurant',
        subject: concentration[0],
        overlaps: concentration[0] === top?.[0] ? ['restaurant-loyalty', 'top-spots'] : [],
        title: 'THE BIGGEST SLICE.',
        value: Math.round((spend(concentration[1]) / spend(priced)) * 100),
        format: 'number',
        label: '% of your tracked spending',
        detail: concentration[1][0].r.restaurantName ?? '',
        punchline: 'One restaurant. A sizable commitment.',
        approximate: approx(priced),
      },
      {
        share: spend(concentration[1]) / spend(priced),
        denominator: priced.length,
        magnitude: (spend(concentration[1]) / spend(priced)) * 100,
      },
    );
  const refunds = records.filter((r) => r.refunded);
  if (refunds.length >= 10)
    add(
      {
        id: 'refunded-orders',
        category: 'pattern',
        family: 'refund',
        title: 'PLOT TWIST.',
        value: refunds.length,
        format: 'number',
        label: 'orders were refunded',
        detail: `${Math.round((refunds.length / records.length) * 100)}% of your tracked orders`,
        punchline: 'Not every order went to plan.',
        ...(refunds.some((r) => r.refund !== null)
          ? {
              supportingMoney: {
                amount: money(sum(refunds.map((r) => r.refund ?? 0))),
                approximate: refunds.some((r) => r.refund === null || r.approximate),
                label: 'recovered, including Uber Cash',
              },
            }
          : {}),
      },
      {
        share: refunds.length / records.length,
        denominator: records.length,
        refund: true,
        magnitude: (refunds.length / 20) * 100,
      },
    );
  const bestOrder = [...deliveries]
    .filter((r) => r.amount !== null)
    .sort((a, b) => b.amount! - a.amount! || a.r.id.localeCompare(b.r.id))[0];
  if (bestOrder) {
    const peers = priced.filter((r) => r !== bestOrder).map((r) => r.amount!);
    add(
      {
        id: 'most-expensive-order',
        category: 'extreme-moment',
        family: 'spending',
        title: 'THE BIG ONE.',
        value: bestOrder.amount!,
        format: 'money',
        label: 'for a single order',
        detail: bestOrder.r.restaurantName ?? 'Your biggest tracked order',
        startDate: bestOrder.day,
        approximate: bestOrder.approximate,
        punchline: 'You made that order count.',
      },
      {
        value: bestOrder.amount!,
        baseline: recapMedian(peers),
        comparisonCount: peers.length,
        magnitude: ((bestOrder.cad ?? 0) / 150) * 100,
      },
    );
  }

  const monthGroups = groups(deliveries, (r) => r.day?.slice(0, 7));
  for (const [month, rs] of monthGroups) {
    const start = `${month}-01`,
      date = new Date(`${start}T12:00:00Z`);
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    const earlier = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 3, 1))
      .toISOString()
      .slice(0, 10);
    const prior = deliveries.filter((r) => r.day && r.day >= earlier && r.day < start);
    if (
      end >= (getLocalDateKey(now, timezone) ?? '') ||
      !covered(earlier, end) ||
      rs.length < 10 ||
      prior.length < 10 ||
      rs.length <= prior.length
    )
      continue;
    add(
      {
        id: `ordering-escalation-${month}`,
        category: 'trend',
        family: 'frequency',
        title: 'THAT ESCALATED.',
        value: rs.length,
        format: 'number',
        label: 'deliveries in one month',
        detail: `More than the previous three months combined (${prior.length})`,
        startDate: start,
        endDate: end,
        punchline: 'A change of pace.',
      },
      {
        value: rs.length,
        baseline: prior.length / 3,
        comparisonCount: 3,
        magnitude: (rs.length / 30) * 100,
      },
    );
  }

  // Preserve useful established timing stories, but score against this user's eligible history.
  const timed = deliveries.filter((r) => hasOrderTimeEvidence(r.r));
  const timing = [
    {
      id: 'late-night-orders',
      count: legacy.shame.lateNightOrders?.count,
      title: 'AFTER HOURS.',
      label: 'late-night deliveries',
      detail: 'Between 10 PM and 4 AM',
      family: 'late-night',
    },
    {
      id: 'peak-hunger-hour',
      count: legacy.patterns.peakHungerHour?.orderCount,
      title: 'RIGHT ON TIME.',
      label: 'orders at your favorite hour',
      detail: legacy.patterns.peakHungerHour?.hourDisplay ?? '',
      family: 'hour',
    },
  ];
  for (const t of timing)
    if (t.count)
      add(
        {
          id: t.id,
          category: 'pattern',
          family: t.family,
          title: t.title,
          value: t.count,
          format: 'number',
          label: t.label,
          detail: t.detail,
          punchline: 'Your appetite has a schedule.',
        },
        {
          share: t.count / Math.max(timed.length, 1),
          denominator: timed.length,
          magnitude: (t.count / 20) * 100,
        },
      );
  const owl = legacy.flex.nightOwl;
  if (owl)
    add(
      {
        id: 'night-owl',
        category: 'pattern',
        family: 'late-night',
        overlaps: ['late-night-orders'],
        title: 'NIGHT OWL.',
        value: Math.round(owl.percentage),
        format: 'number',
        label: '% of timed deliveries after hours',
        detail: `${owl.count} late-night deliveries`,
        punchline: 'Your kitchen has a night shift.',
      },
      {
        share: owl.count / Math.max(timed.length, 1),
        denominator: timed.length,
        magnitude: owl.percentage,
      },
    );

  const chain = legacy.shame.chainDependency;
  if (chain)
    add(
      {
        id: 'chain-dependency',
        category: 'habit',
        family: 'restaurant',
        subject: merchantIdentity(chain.worstOffender),
        overlaps: merchantIdentity(chain.worstOffender) === top?.[0] ? ['restaurant-loyalty'] : [],
        title: 'A LOYAL FOLLOWING.',
        value: chain.orderCount,
        format: 'number',
        label: 'orders from your favorite chain',
        detail: chain.worstOffender,
        punchline: 'Some relationships are built on delivery.',
      },
      {
        share: chain.orderCount / Math.max(deliveries.length, 1),
        denominator: deliveries.length,
        magnitude: chain.percentage,
      },
    );
  const single = legacy.shame.singleItemOrders;
  if (single)
    add(
      {
        id: 'single-item-orders',
        category: 'habit',
        family: 'menu',
        title: 'JUST THE ONE.',
        value: single.count,
        format: 'number',
        label: 'single-item deliveries',
        detail: single.mostCommon,
        punchline: 'You knew exactly what you wanted.',
      },
      {
        share: single.count / Math.max(itemized.length, 1),
        denominator: itemized.length,
        magnitude: (single.count / 30) * 100,
      },
    );
  const coffee = legacy.flex.coffeeAddiction;
  if (coffee)
    add(
      {
        id: 'coffee-addiction',
        category: 'habit',
        family: 'menu',
        title: 'CAFFEINE, DELIVERED.',
        value: coffee.orderCount,
        format: 'number',
        label: 'coffee orders',
        detail: coffee.mostOrdered,
        punchline: 'A well-established ritual.',
      },
      {
        share: coffee.orderCount / Math.max(itemized.length, 1),
        denominator: itemized.length,
        magnitude: (coffee.orderCount / 50) * 100,
      },
    );
  const weekend = legacy.patterns.weekendWarrior;
  if (weekend) {
    const weekendHeavy = weekend.weekendOrders / 2 > weekend.weekdayOrders / 5;
    const n = weekendHeavy ? weekend.weekendOrders : weekend.weekdayOrders;
    const normalized = weekend.weekendOrders / 2 + weekend.weekdayOrders / 5;
    add(
      {
        id: 'weekend-warrior',
        category: 'pattern',
        family: 'week-pattern',
        title: weekendHeavy ? 'WEEKEND PLANS.' : 'THE WEEKDAY ROUTINE.',
        value: n,
        format: 'number',
        label: weekendHeavy ? 'weekend deliveries' : 'weekday deliveries',
        detail: 'Your busier side of the week, per calendar day',
        punchline: 'Your week has a flavor.',
      },
      {
        share: normalized
          ? (weekendHeavy ? weekend.weekendOrders / 2 : weekend.weekdayOrders / 5) / normalized
          : 0,
        denominator: weekend.weekendOrders + weekend.weekdayOrders,
        magnitude:
          100 * Math.abs((normalized ? weekend.weekendOrders / 2 / normalized : 0.5) - 0.5) * 2,
      },
    );
  }
  const waits = legacy.patterns.deliveryWaits;
  if (waits)
    add(
      {
        id: 'delivery-waits',
        category: 'perspective',
        family: 'delivery-time',
        title: 'ON THE WAY.',
        value: Math.round((waits.totalMinutes / 60) * 10) / 10,
        format: 'number',
        label: 'combined delivery-window hours',
        detail: `${waits.totalOrders} deliveries · ${Math.round(waits.averageMinutes)} minutes on average`,
        punchline: 'A lot of little journeys to your door.',
      },
      {
        value: waits.longestWait?.minutes,
        baseline: waits.averageMinutes,
        comparisonCount: Math.max(waits.totalOrders - 1, 0),
        magnitude: (waits.totalMinutes / 1440) * 100,
      },
    );
  if (restaurants.length >= 3)
    add(
      {
        id: 'top-spots',
        category: 'places',
        family: 'restaurant',
        subject: top?.[0],
        overlaps: ['restaurant-loyalty'],
        specificity: 1,
        title: 'YOUR REGULARS.',
        value: restaurants
          .slice(0, 3)
          .map((g, i) => `${i + 1}. ${g[1][0].r.restaurantName}`)
          .join('\n'),
        format: 'text',
        label: 'the top of your delivery list',
        detail: restaurants
          .slice(0, 3)
          .map((g) => `${g[1].length} orders`)
          .join(' · '),
        punchline: 'A very personal podium.',
      },
      {
        share: top ? top[1].length / deliveries.length : 0,
        denominator: deliveries.length,
        magnitude: 100,
      },
    );
  const feeRecords = deliveries.filter(
    (r) => typeof r.r.deliveryFee === 'number' && r.r.deliveryFee >= 0,
  );
  const feeValues = feeRecords.flatMap((r) => {
    const amount = convert(
      r.r.deliveryFee!,
      supported(r.r.currencyCode) ? r.r.currencyCode : currency,
    );
    return amount === null ? [] : [amount];
  });
  if (feeValues.length && legacy.comparative.costPerMeal)
    add(
      {
        id: 'delivery-tax',
        category: 'perspective',
        family: 'fees',
        title: 'THE DELIVERY EXTRA.',
        value: money(sum(feeValues)),
        format: 'money',
        label: 'recorded delivery fees',
        detail: `Across ${feeValues.length} deliveries with recorded fee details`,
        approximate: true,
        punchline: 'The food had company on the bill.',
      },
      {
        value: Math.max(...feeValues),
        baseline: recapMedian(
          feeValues.filter((_, i) => i !== feeValues.indexOf(Math.max(...feeValues))),
        ),
        comparisonCount: feeValues.length - 1,
        magnitude: (legacy.comparative.costPerMeal.averageDeliveryFeePerMeal / 8) * 100,
      },
    );

  // Monetary perspectives use the same net, converted projection as the opener.
  const comparisons = legacy.comparative.couldHaveBought?.comparisons;
  if (comparisons?.length && legacy.comparative.couldHaveBought!.totalSpent > 0) {
    const c = comparisons[0];
    const sourceCurrency = supported(legacy.currencyCode) ? legacy.currencyCode : currency;
    const unit =
      c.quantity > 0
        ? convert(legacy.comparative.couldHaveBought!.totalSpent / c.quantity, sourceCurrency)
        : null;
    if (unit && unit > 0)
      add(
        {
          id: 'could-have-bought',
          category: 'perspective',
          family: 'spending',
          title: 'ANOTHER WAY TO SEE IT.',
          value: Math.floor(spend(records) / unit),
          format: 'number',
          label: c.item,
          detail: 'An approximate spending comparison',
          punchline: 'Same money. Different possibilities.',
        },
        { magnitude: (sum(records.map((r) => r.cad ?? 0)) / 5000) * 100 },
      );
  }
  const investment = legacy.comparative.missedInvestment;
  if (investment && investment.amountSpent > 0) {
    const growth = investment.wouldBeWorth / investment.amountSpent;
    add(
      {
        id: 'missed-investment',
        category: 'perspective',
        family: 'spending',
        title: 'THE WHAT-IF.',
        value: money(spend(records) * growth),
        format: 'money',
        approximate: true,
        label: 'hypothetical investment value',
        detail: `${investment.daysElapsed} days · ${investment.sp500Return}% assumed annual return`,
        punchline: 'An illustration, not a prediction.',
      },
      { magnitude: ((sum(records.map((r) => r.cad ?? 0)) * (growth - 1)) / 1500) * 100 },
    );
  }

  const fallback = (
    id: string,
    order: number,
    title: string,
    value: number | string,
    label: string,
    detail = '',
    format: RecapStory['format'] = 'number',
    approximate = false,
  ) =>
    add(
      {
        id,
        fallbackOrder: order,
        category: 'perspective',
        family: id,
        title,
        value,
        format,
        label,
        detail,
        punchline: '',
        approximate,
      },
      { magnitude: 0 },
    );
  fallback('history-total', 0, 'ORDER BY ORDER.', records.length, 'tracked orders');
  fallback(
    'history-restaurants',
    1,
    'YOUR FOOD MAP.',
    restaurants.length,
    'restaurants in your delivery history',
  );
  const provider = groups(records, (r) => r.r.receiptType)[0];
  if (provider)
    fallback(
      'history-provider',
      2,
      'YOUR GO-TO APP.',
      provider[0] === 'uber_eats'
        ? 'Uber Eats'
        : provider[0] === 'doordash'
          ? 'DoorDash'
          : provider[0],
      `${provider[1].length} tracked orders`,
      '',
      'text',
    );
  if (dated.length) {
    fallback(
      'history-first',
      3,
      'WHERE IT STARTED.',
      dated[0].day!,
      'your first tracked order',
      dated[0].r.restaurantName ?? '',
      'text',
    );
    fallback(
      'history-latest',
      4,
      'THE LATEST CHAPTER.',
      dated[dated.length - 1].day!,
      'your latest tracked order',
      dated[dated.length - 1].r.restaurantName ?? '',
      'text',
    );
    fallback(
      'history-duration',
      5,
      'THE LONG VIEW.',
      dayNumber(dated[dated.length - 1].day!) - dayNumber(dated[0].day!) + 1,
      'calendar days spanned by your history',
    );
  }
  if (priced.length)
    fallback(
      'history-average',
      6,
      'YOUR TYPICAL CHECK.',
      money(spend(priced) / priced.length),
      'average available order amount',
      '',
      'money',
      approx(records),
    );
  if (top)
    fallback(
      'history-top-restaurant',
      7,
      'A FAMILIAR FAVORITE.',
      top[1][0].r.restaurantName ?? '',
      `${top[1].length} completed deliveries`,
      '',
      'text',
    );
  // Date-less/minimal histories still have truthful descriptive dimensions.
  fallback(
    'history-provider-count',
    8,
    'THE APP LINEUP.',
    groups(records, (r) => r.r.receiptType).length,
    'delivery apps represented',
  );
  fallback(
    'history-itemized',
    9,
    'ON THE MENU.',
    itemized.length,
    'deliveries with recorded item details',
  );
  fallback(
    'history-item-count',
    10,
    'ITEM BY ITEM.',
    sum(itemized.map((r) => sum(r.r.items.map((i) => i.quantity)))),
    'items recorded in your delivery history',
  );
  fallback(
    'history-menu-variety',
    11,
    'YOUR MENU INDEX.',
    new Set(itemized.flatMap((r) => r.r.items.map((i) => merchantIdentity(i.name)))).size,
    'different item names in your receipts',
  );
  fallback(
    'history-ordering-days',
    12,
    'DAY BY DAY.',
    dayGroups.length,
    'delivery dates in your history',
  );
  // Supporting records come from the exact selected cohorts, never a second client query.
  const eventTimezone = (r: R) => r.r.resolution?.timestamp?.timezone ?? r.r.timezone ?? timezone;
  const evidenceOrder = (r: R): RecapEvidenceOrder => ({
    id: r.r.id,
    restaurant: r.r.restaurantName?.trim() || 'Unknown restaurant',
    date: r.day,
    localTime:
      hasOrderTimeEvidence(r.r) && r.r.orderDate
        ? new Intl.DateTimeFormat('en-GB', {
            timeZone: eventTimezone(r),
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(r.r.orderDate)
        : undefined,
    ...(r.amount !== null ? { amount: money(r.amount), approximate: r.approximate } : {}),
    items: r.r.items
      .filter(
        (i) =>
          i.name.trim() &&
          i.name.toLowerCase() !== 'unknown' &&
          i.quantity > 0 &&
          i.evidence?.method !== 'preserved_ambiguous',
      )
      .map((i) => ({ name: singleItemDisplayName(r.r, i), quantity: i.quantity })),
  });
  const minute = (r: R) =>
    r.r.orderDate ? (getLocalMinuteOfDay(r.r.orderDate, eventTimezone(r)) ?? -1) : -1;
  const byDate = (a: R, b: R) =>
    (a.day ?? '').localeCompare(b.day ?? '') ||
    minute(a) - minute(b) ||
    a.r.id.localeCompare(b.r.id);
  const chronological = [...dated].sort(byDate);
  const nights = timed
    .filter((r) => isLateNightHour(Math.floor(minute(r) / 60)))
    .sort((a, b) => overnightMinute(minute(b)) - overnightMinute(minute(a)) || byDate(b, a));
  const primaryCurrency = spendingByCurrency(unique).primary;
  const singles = deliveries
    .filter(
      (r) =>
        currencyOf(r.r) === primaryCurrency &&
        isSingleItemOrder(r.r, usesOrderEventMetrics(unique)),
    )
    .sort((a, b) => byDate(b, a));
  for (const story of stories) {
    let cohort: R[] = [];
    let kind: RecapEvidence['kind'] = 'receipt';
    let total = 0;
    switch (story.id) {
      case 'most-expensive-order':
        cohort = bestOrder ? [bestOrder] : [];
        break;
      case 'history-first':
        cohort = chronological.slice(0, 1);
        break;
      case 'history-latest':
        cohort = chronological.slice(-1);
        break;
      case 'repeated-basket':
        cohort = basket ? basket[1].slice(0, 1) : [];
        kind = 'items';
        break;
      case 'late-night-orders':
      case 'night-owl':
        cohort = nights.slice(0, 3);
        total = nights.length;
        kind = 'late-night';
        break;
      case 'spending-burst':
        cohort = [...(bestWeek?.rs ?? [])]
          .filter((r) => r.amount !== null)
          .sort((a, b) => b.amount! - a.amount! || byDate(a, b))
          .slice(0, 3);
        total = bestWeek?.rs.length ?? 0;
        kind = 'spending';
        break;
      case 'single-item-orders':
        cohort = singles.slice(0, 3);
        total = singles.length;
        kind = 'single-items';
        break;
      case 'longest-streak': {
        const days = dayGroups
          .filter(([day]) => day >= story.startDate! && day <= story.endDate!)
          .sort(([a], [b]) => a.localeCompare(b));
        // Keep both ends visible for long streaks, with an explicit omitted-days label.
        const shown = days.length > 7 ? [...days.slice(0, 3), ...days.slice(-3)] : days;
        cohort = shown.map(([, rs]) => [...rs].sort(byDate)[0]);
        total = days.length;
        kind = 'streak';
        break;
      }
    }
    if (!cohort.length) continue;
    story.evidence = { kind, orders: cohort.map(evidenceOrder), total: total || cohort.length };
    if (story.id === 'repeated-basket') story.detail = cohort[0].r.restaurantName ?? '';
    if (story.id === 'history-first' || story.id === 'history-latest') {
      story.value = cohort[0].day!;
      story.detail = '';
      story.punchline = story.id === 'history-first' ? 'The first chapter.' : 'The latest chapter.';
    }
  }
  return {
    version: RECAP_POLICY_VERSION,
    currency,
    rateSnapshot: rates.id,
    spending: {
      amount: spend(records),
      approximate: approx(records),
      pricedOrders: priced.length,
      missingPrices: records.length - priced.length,
      assumedCurrencies: records.filter((r) => r.assumed).length,
    },
    stories,
  };
}
