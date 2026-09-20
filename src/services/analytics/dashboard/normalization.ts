import { merchantIdentity } from '../../receipt/ReceiptResolutionService';
import { spendingByCurrency, receiptCurrency } from '../shared/receiptMetrics';
import {
  hasOrderTimeEvidence,
  mostDeliveriesDay,
  orderMetricEligibility,
  summarizeOrderMetrics,
  usesOrderEventMetrics,
  type DeliveryDayRanking,
  type OrderMetrics,
} from '../shared/orderMetrics';
import { DataSource, Receipt, ReceiptItem } from '../../../models/Receipt';
import { getLocalDateKey, getLocalDateTimeParts } from '../../../utils/timezone';
import { usableItemUnitPrice } from '../../receipt/ItemPrice';
import {
  classifyItemPersonality,
  getItemPhysicalMultiplier,
  ItemPersonalityFamily,
} from './itemPersonalities';

export type MerchantClass =
  'restaurant' | 'grocery' | 'pharmacy' | 'convenience' | 'alcohol' | 'unknown';
export type ItemFamily = ItemPersonalityFamily | 'other';

export interface NormalizedItem {
  rawName: string;
  key: string;
  label: string;
  quantity: number;
  physicalUnits: number;
  family: ItemFamily;
  estimated: boolean;
  price: number;
  priceKnown: boolean;
  customizations: string[];
}

export interface NormalizedReceipt {
  source: Receipt;
  stableIndex: number;
  amount: number;
  /** Numeric compatibility value is usable only when this flag is true. */
  amountKnown: boolean;
  currencyCode: string;
  localDate?: string;
  localMonth?: string;
  localYear?: number;
  weekday?: string;
  hour?: number;
  minute?: number;
  restaurantKey?: string;
  restaurantLabel?: string;
  merchantClass: MerchantClass;
  items: NormalizedItem[];
  basketKey?: string;
  deliveryMinutes?: number;
}

export interface DashboardDataset {
  cohort: 'legacy' | 'evidence' | 'deliveries' | 'restaurants' | 'net-cost';
  orderMetrics?: OrderMetrics;
  deliveryDayRanking?: DeliveryDayRanking;
  currencyCode: string;
  totalsByCurrency: Record<string, { total: number; count: number }>;
  timezone: string;
  now: Date;
  localDate: string;
  receipts: NormalizedReceipt[];
  dated: NormalizedReceipt[];
  positive: NormalizedReceipt[];
  exportReceipts: NormalizedReceipt[];
  byBranch: Map<string, NormalizedReceipt[]>;
  byRestaurant: Map<string, NormalizedReceipt[]>;
  byLocalDate: Map<string, NormalizedReceipt[]>;
  itemTotals: Map<
    string,
    {
      key: string;
      label: string;
      family: ItemFamily;
      units: number;
      appearances: number;
      estimated: boolean;
    }
  >;
  deliveryReceipts: NormalizedReceipt[];
  earliestDate?: string;
  latestDate?: string;
  sourceCoverage: 'none' | 'email' | 'export' | 'mixed';
}

const RESTAURANT_ALIASES: Record<string, string> = {
  mcdonald: 'mcdonalds',
  mcdonalds: 'mcdonalds',
  timhortons: 'tim hortons',
  'tim horton': 'tim hortons',
  popeye: 'popeyes',
};

const RESTAURANT_LABELS: Record<string, string> = {
  lcbo: 'LCBO',
  mcdonalds: "McDonald's",
  'tim hortons': 'Tim Hortons',
  popeyes: 'Popeyes',
};

const titleCase = (value: string) =>
  value.replace(/\b\p{L}/gu, (character) => character.toLocaleUpperCase('en-US'));

export function normalizeRestaurantName(
  raw?: string,
): { key: string; label: string; merchantClass: MerchantClass } | null {
  if (!raw || !/[\p{L}\p{N}]/u.test(raw)) return null;
  let value = raw.normalize('NFKC').replace(/[®™©]/g, '').replace(/[’']/g, '').trim();
  value = value
    .replace(/\s*[|•]\s*.+$/u, '')
    .replace(/\s+-\s+(?:#?\d[\w-]*|\d{1,6}\s+.+)$/u, '')
    .replace(/\s*\((?:store|location|branch)?\s*#?\d[^)]*\)\s*$/iu, '')
    .replace(
      /\s*\((?:#?\d|[^)]*\b(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|mall|plaza)\b)[^)]*\)\s*$/iu,
      '',
    )
    .replace(/\s+#\d[\w-]*$/u, '')
    .replace(/[^\p{L}\p{N}&+]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
  if (!value || value === 'unknown restaurant') return null;
  if (/^mcdonalds?\b/.test(value)) value = 'mcdonalds';
  if (/^tim hortons?\b/.test(value)) value = 'tim hortons';
  const compact = value.replace(/\s/g, '');
  const key = RESTAURANT_ALIASES[value] ?? RESTAURANT_ALIASES[compact] ?? value;
  return {
    key,
    label: RESTAURANT_LABELS[key] ?? titleCase(key),
    merchantClass: classifyMerchant(key),
  };
}

export function classifyMerchant(key: string): MerchantClass {
  if (/\b(?:lcbo|wine rack|beer store|liquor|wine|spirits)\b/i.test(key)) return 'alcohol';
  if (/\b(?:pharmacy|drug mart|rexall|walgreens|cvs)\b/i.test(key)) return 'pharmacy';
  if (
    /\b(?:walmart|costco|grocery|supermarket|loblaws|metro|whole foods|farm boy|food basics)\b/i.test(
      key,
    )
  )
    return 'grocery';
  if (/\b(?:7 eleven|circle k|convenience|hasty market)\b/i.test(key)) return 'convenience';
  return 'restaurant';
}

export function normalizeItem(item: ReceiptItem, source?: { receiptType?: string; dataSource?: string }): NormalizedItem | null {
  if (
    !item.name ||
    !/[\p{L}\p{N}]/u.test(item.name) ||
    item.name.trim().toLocaleLowerCase('en-US') === 'unknown'
  )
    return null;
  const quantity = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
  const key = item.name
    .normalize('NFKC')
    .replace(/[®™©]/g, '')
    .replace(/\[[^\]]*\bcal(?:s|ories)?\b[^\]]*\]/gi, '')
    .replace(/\([^)]*\bcal(?:s|ories)?\b[^)]*\)/gi, '')
    .replace(/\b\d{1,4}(?:\.\d+)?\s*(?:cal|cals|calories)\b/gi, '')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\bmc\s+nuggets?\b/g, 'mcnuggets')
    .replace(/\bchicken\s+mcnuggets?\b/g, 'mcnuggets')
    .replace(/\bhashbrowns?\b/g, 'hash brown');
  if (!key) return null;
  const family = classifyItemPersonality(key);
  const multiplier = getItemPhysicalMultiplier(key, family);
  const unitPrice = usableItemUnitPrice(item, source);
  return {
    rawName: item.name,
    key,
    label: titleCase(key),
    quantity,
    physicalUnits: quantity * multiplier,
    family,
    estimated: multiplier !== 1 || family !== 'other',
    price: unitPrice ?? 0,
    priceKnown: unitPrice !== undefined,
    customizations: Array.isArray(item.customizations)
      ? item.customizations
          .filter((value) => typeof value === 'string' && value.trim())
          .map((value) => value.trim())
      : [],
  };
}

export function canonicalBasketKey(
  restaurantKey: string | undefined,
  items: NormalizedItem[],
): string | undefined {
  if (!restaurantKey || items.length === 0) return undefined;
  const quantities = new Map<string, number>();
  for (const item of items) {
    const key = `${item.key}::${item.customizations
      .map((v) => v.toLowerCase())
      .sort()
      .join(';')}`;
    quantities.set(key, (quantities.get(key) ?? 0) + item.quantity);
  }
  const itemKey = [...quantities.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, quantity]) => `${key}×${quantity}`)
    .join('|');
  return `${restaurantKey}::${itemKey}`;
}

export function buildDashboardDataset(
  receipts: Receipt[],
  timezone: string,
  now: Date = new Date(),
): DashboardDataset {
  const spending = spendingByCurrency(receipts);
  const eventMetrics = usesOrderEventMetrics(receipts);
  const localDate = getLocalDateKey(now, timezone) ?? now.toISOString().slice(0, 10);
  const normalized = receipts.map((receipt, stableIndex): NormalizedReceipt => {
    const eventTimezone = receipt.resolution?.timestamp?.timezone ?? timezone;
    const eligibility = orderMetricEligibility(receipt);
    const currencyCode = receiptCurrency(receipt);
    const netAmount = eventMetrics ? eligibility.netAmount : receipt.amountSpent;
    const amountKnown =
      currencyCode === spending.primary && netAmount !== null && Number.isFinite(netAmount);
    const clockKnown = !eventMetrics || hasOrderTimeEvidence(receipt);
    const restaurant = normalizeRestaurantName(receipt.restaurantName);
    const parts = receipt.orderDate
      ? getLocalDateTimeParts(receipt.orderDate, eventTimezone)
      : null;
    const receiptLocalDate = receipt.orderDate
      ? (getLocalDateKey(receipt.orderDate, eventTimezone) ?? undefined)
      : undefined;
    const items = receipt.items
      .map(item => normalizeItem(item, receipt))
      .filter((item): item is NormalizedItem => Boolean(item));
    const deliveryMinutes =
      clockKnown &&
      (!eventMetrics || eligibility.delivered) &&
      receipt.orderDate &&
      receipt.deliveryTime
        ? Math.round((receipt.deliveryTime.getTime() - receipt.orderDate.getTime()) / 60_000)
        : undefined;
    return {
      source: receipt,
      stableIndex,
      amount: amountKnown && netAmount !== null ? netAmount : 0,
      amountKnown,
      currencyCode,
      localDate: receiptLocalDate,
      localMonth: receiptLocalDate?.slice(0, 7),
      localYear: parts?.year,
      weekday:
        parts && receipt.orderDate
          ? new Intl.DateTimeFormat('en-US', { timeZone: eventTimezone, weekday: 'long' }).format(
              receipt.orderDate,
            )
          : undefined,
      hour: clockKnown ? parts?.hour : undefined,
      minute: clockKnown ? parts?.minute : undefined,
      restaurantKey: restaurant?.key,
      restaurantLabel: restaurant?.label,
      merchantClass: restaurant?.merchantClass ?? 'unknown',
      items,
      basketKey: canonicalBasketKey(
        `${receipt.monetaryDetails?.currencyCode ?? 'UNKNOWN'}:${restaurant?.key}`,
        items,
      ),
      deliveryMinutes:
        deliveryMinutes && deliveryMinutes > 0 && deliveryMinutes <= 720
          ? deliveryMinutes
          : undefined,
    };
  });

  normalized.sort((a, b) => {
    const aTime = a.source.orderDate?.getTime();
    const bTime = b.source.orderDate?.getTime();
    const chronological =
      (aTime !== undefined && Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER) -
      (bTime !== undefined && Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER);
    const identity = (receipt: NormalizedReceipt) =>
      receipt.source.id ??
      JSON.stringify([
        receipt.source.receiptType,
        receipt.source.restaurantName,
        receipt.currencyCode,
        receipt.amount,
        receipt.basketKey,
      ]);
    return (
      chronological ||
      (eventMetrics ? identity(a).localeCompare(identity(b)) : a.stableIndex - b.stableIndex)
    );
  });
  if (eventMetrics)
    normalized.forEach((receipt, index) => {
      receipt.stableIndex = index;
    });
  const sources = new Set(
    receipts.flatMap((receipt) => receipt.resolution?.sources ?? [receipt.dataSource]),
  );
  const hasEmail = sources.has(DataSource.EMAIL);
  const hasExport = sources.has(DataSource.CSV);
  return indexDashboardDataset(
    {
      currencyCode: spending.primary,
      totalsByCurrency: spending.buckets,
      timezone,
      now,
      localDate,
      cohort: eventMetrics ? 'evidence' : 'legacy',
      orderMetrics: eventMetrics ? summarizeOrderMetrics(receipts) : undefined,
      deliveryDayRanking: eventMetrics ? mostDeliveriesDay(receipts, timezone) : undefined,
      sourceCoverage:
        hasEmail && hasExport ? 'mixed' : hasEmail ? 'email' : hasExport ? 'export' : 'none',
    },
    normalized,
  );
}

type DatasetContext = Pick<
  DashboardDataset,
  | 'currencyCode'
  | 'totalsByCurrency'
  | 'timezone'
  | 'now'
  | 'localDate'
  | 'sourceCoverage'
  | 'cohort'
  | 'orderMetrics'
  | 'deliveryDayRanking'
>;

/** Re-index a named population without losing the original evidence/quality context. */
function indexDashboardDataset(
  context: DatasetContext,
  normalized: NormalizedReceipt[],
): DashboardDataset {
  const positive = normalized.filter((receipt) => receipt.amountKnown && receipt.amount > 0);
  const dated = normalized.filter((receipt) => Boolean(receipt.localDate));
  const exportReceipts = normalized.filter((receipt) => hasExportSource(receipt));
  const byBranch = new Map<string, NormalizedReceipt[]>();
  const byRestaurant = new Map<string, NormalizedReceipt[]>();
  const byLocalDate = new Map<string, NormalizedReceipt[]>();
  const itemTotals = new Map<
    string,
    {
      key: string;
      label: string;
      family: ItemFamily;
      units: number;
      appearances: number;
      estimated: boolean;
    }
  >();
  for (const receipt of normalized) {
    const branchKey = `${receipt.source.receiptType}:${merchantIdentity(receipt.source.restaurantName)}`;
    byBranch.set(branchKey, [...(byBranch.get(branchKey) ?? []), receipt]);
    if (receipt.restaurantKey)
      byRestaurant.set(receipt.restaurantKey, [
        ...(byRestaurant.get(receipt.restaurantKey) ?? []),
        receipt,
      ]);
    if (receipt.localDate)
      byLocalDate.set(receipt.localDate, [...(byLocalDate.get(receipt.localDate) ?? []), receipt]);
    if (hasExportSource(receipt)) {
      const appeared = new Set<string>();
      const componentItems = receipt.source.items
        .flatMap((item) => item.evidence?.components ?? [])
        .map((component) =>
          normalizeItem({ name: component.name, quantity: component.quantity, price: 0 }),
        )
        .filter((item): item is NormalizedItem => Boolean(item));
      for (const item of [...receipt.items, ...componentItems]) {
        const current = itemTotals.get(item.key) ?? {
          key: item.key,
          label: item.label,
          family: item.family,
          units: 0,
          appearances: 0,
          estimated: false,
        };
        current.units += item.physicalUnits;
        if (!appeared.has(item.key)) current.appearances += 1;
        appeared.add(item.key);
        current.estimated ||= item.estimated;
        itemTotals.set(item.key, current);
      }
    }
  }
  return {
    ...context,
    receipts: normalized,
    dated,
    positive,
    exportReceipts,
    byBranch,
    byRestaurant,
    byLocalDate,
    itemTotals,
    deliveryReceipts: normalized.filter((receipt) => receipt.deliveryMinutes !== undefined),
    earliestDate: dated.map((r) => r.localDate!).sort()[0],
    latestDate: dated
      .map((r) => r.localDate!)
      .sort()
      .at(-1),
  };
}

export function hasExportSource(receipt: NormalizedReceipt): boolean {
  return (receipt.source.resolution?.sources ?? [receipt.source.dataSource]).includes(
    DataSource.CSV,
  );
}

export function dashboardCohort(
  dataset: DashboardDataset,
  cohort: 'deliveries' | 'restaurants' | 'net-cost',
): DashboardDataset {
  const receipts = dataset.receipts.filter((receipt) => {
    const eligibility = orderMetricEligibility(receipt.source);
    if (cohort === 'net-cost')
      return (
        eligibility.establishedAttempt && receipt.amountKnown && receipt.currencyCode !== 'UNKNOWN'
      );
    return (
      eligibility.delivered && (cohort !== 'restaurants' || receipt.merchantClass === 'restaurant')
    );
  });
  return indexDashboardDataset({ ...dataset, cohort }, receipts);
}
