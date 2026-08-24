import { DataSource, Receipt, ReceiptItem } from '../../../models/Receipt';
import { getLocalDateKey, getLocalDateTimeParts } from '../../../utils/timezone';
import { classifyItemPersonality, getItemPhysicalMultiplier, ItemPersonalityFamily } from './itemPersonalities';

export type MerchantClass = 'restaurant' | 'grocery' | 'pharmacy' | 'convenience' | 'alcohol' | 'unknown';
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
  customizations: string[];
}

export interface NormalizedReceipt {
  source: Receipt;
  stableIndex: number;
  amount: number;
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
  timezone: string;
  now: Date;
  localDate: string;
  receipts: NormalizedReceipt[];
  dated: NormalizedReceipt[];
  positive: NormalizedReceipt[];
  exportReceipts: NormalizedReceipt[];
  byRestaurant: Map<string, NormalizedReceipt[]>;
  byLocalDate: Map<string, NormalizedReceipt[]>;
  itemTotals: Map<string, { key: string; label: string; family: ItemFamily; units: number; appearances: number; estimated: boolean }>;
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

const titleCase = (value: string) => value.replace(/\b\p{L}/gu, character => character.toLocaleUpperCase('en-US'));

export function normalizeRestaurantName(raw?: string): { key: string; label: string; merchantClass: MerchantClass } | null {
  if (!raw || !/[\p{L}\p{N}]/u.test(raw)) return null;
  let value = raw.normalize('NFKC').replace(/[®™©]/g, '').replace(/[’']/g, '').trim();
  value = value
    .replace(/\s*[|•]\s*.+$/u, '')
    .replace(/\s+-\s+(?:#?\d[\w-]*|\d{1,6}\s+.+)$/u, '')
    .replace(/\s*\((?:store|location|branch)?\s*#?\d[^)]*\)\s*$/iu, '')
    .replace(/\s*\((?:#?\d|[^)]*\b(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|mall|plaza)\b)[^)]*\)\s*$/iu, '')
    .replace(/\s+#\d[\w-]*$/u, '')
    .replace(/[^\p{L}\p{N}&+]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
  if (!value || value === 'unknown restaurant') return null;
  const compact = value.replace(/\s/g, '');
  const key = RESTAURANT_ALIASES[value] ?? RESTAURANT_ALIASES[compact] ?? value;
  return { key, label: RESTAURANT_LABELS[key] ?? titleCase(key), merchantClass: classifyMerchant(key) };
}

export function classifyMerchant(key: string): MerchantClass {
  if (/\b(?:lcbo|wine rack|beer store|liquor|wine|spirits)\b/i.test(key)) return 'alcohol';
  if (/\b(?:pharmacy|drug mart|rexall|walgreens|cvs)\b/i.test(key)) return 'pharmacy';
  if (/\b(?:walmart|costco|grocery|supermarket|loblaws|metro|whole foods|farm boy|food basics)\b/i.test(key)) return 'grocery';
  if (/\b(?:7 eleven|circle k|convenience|hasty market)\b/i.test(key)) return 'convenience';
  return 'restaurant';
}

export function normalizeItem(item: ReceiptItem): NormalizedItem | null {
  if (!item.name || !/[\p{L}\p{N}]/u.test(item.name) || item.name.trim().toLocaleLowerCase('en-US') === 'unknown') return null;
  const quantity = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
  const key = item.name.normalize('NFKC')
    .replace(/[®™©]/g, '')
    .replace(/\([^)]*\bcal(?:ories)?\b[^)]*\)/gi, '')
    .replace(/\b\d{1,4}\s*(?:cal|cals|calories)\b/gi, '')
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
  return {
    rawName: item.name,
    key,
    label: titleCase(key),
    quantity,
    physicalUnits: quantity * multiplier,
    family,
    estimated: multiplier !== 1 || family !== 'other',
    price: Number.isFinite(item.price) ? item.price : 0,
    customizations: Array.isArray(item.customizations) ? item.customizations.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()) : [],
  };
}

export function canonicalBasketKey(restaurantKey: string | undefined, items: NormalizedItem[]): string | undefined {
  if (!restaurantKey || items.length === 0) return undefined;
  const quantities = new Map<string, number>();
  for (const item of items) quantities.set(item.key, (quantities.get(item.key) ?? 0) + item.quantity);
  const itemKey = [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, quantity]) => `${key}×${quantity}`).join('|');
  return `${restaurantKey}::${itemKey}`;
}

export function buildDashboardDataset(receipts: Receipt[], timezone: string, now: Date = new Date()): DashboardDataset {
  const localDate = getLocalDateKey(now, timezone) ?? now.toISOString().slice(0, 10);
  const normalized = receipts.map((receipt, stableIndex): NormalizedReceipt => {
    const restaurant = normalizeRestaurantName(receipt.restaurantName);
    const parts = receipt.orderDate ? getLocalDateTimeParts(receipt.orderDate, timezone) : null;
    const receiptLocalDate = receipt.orderDate ? getLocalDateKey(receipt.orderDate, timezone) ?? undefined : undefined;
    const items = receipt.items.map(normalizeItem).filter((item): item is NormalizedItem => Boolean(item));
    const deliveryMinutes = receipt.orderDate && receipt.deliveryTime
      ? Math.round((receipt.deliveryTime.getTime() - receipt.orderDate.getTime()) / 60_000)
      : undefined;
    return {
      source: receipt,
      stableIndex,
      amount: Number.isFinite(receipt.amountSpent) ? receipt.amountSpent : 0,
      localDate: receiptLocalDate,
      localMonth: receiptLocalDate?.slice(0, 7),
      localYear: parts?.year,
      weekday: receipt.orderDate ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(receipt.orderDate) : undefined,
      hour: parts?.hour,
      minute: parts?.minute,
      restaurantKey: restaurant?.key,
      restaurantLabel: restaurant?.label,
      merchantClass: restaurant?.merchantClass ?? 'unknown',
      items,
      basketKey: canonicalBasketKey(restaurant?.key, items),
      deliveryMinutes: deliveryMinutes && deliveryMinutes > 0 && deliveryMinutes <= 720 ? deliveryMinutes : undefined,
    };
  });

  normalized.sort((a, b) => {
    const aTime = a.source.orderDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.source.orderDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aTime - bTime || a.stableIndex - b.stableIndex;
  });
  const positive = normalized.filter(receipt => receipt.amount > 0);
  const dated = positive.filter(receipt => Boolean(receipt.localDate));
  const exportReceipts = positive.filter(receipt => receipt.source.dataSource === DataSource.CSV);
  const byRestaurant = new Map<string, NormalizedReceipt[]>();
  const byLocalDate = new Map<string, NormalizedReceipt[]>();
  const itemTotals = new Map<string, { key: string; label: string; family: ItemFamily; units: number; appearances: number; estimated: boolean }>();
  for (const receipt of positive) {
    if (receipt.restaurantKey) byRestaurant.set(receipt.restaurantKey, [...(byRestaurant.get(receipt.restaurantKey) ?? []), receipt]);
    if (receipt.localDate) byLocalDate.set(receipt.localDate, [...(byLocalDate.get(receipt.localDate) ?? []), receipt]);
    if (receipt.source.dataSource === DataSource.CSV) {
      for (const item of receipt.items) {
        const current = itemTotals.get(item.key) ?? { key: item.key, label: item.label, family: item.family, units: 0, appearances: 0, estimated: false };
        current.units += item.physicalUnits;
        current.appearances += 1;
        current.estimated ||= item.estimated;
        itemTotals.set(item.key, current);
      }
    }
  }
  const hasEmail = positive.some(receipt => receipt.source.dataSource === DataSource.EMAIL);
  const hasExport = exportReceipts.length > 0;
  return {
    timezone,
    now,
    localDate,
    receipts: normalized,
    dated,
    positive,
    exportReceipts,
    byRestaurant,
    byLocalDate,
    itemTotals,
    deliveryReceipts: positive.filter(receipt => receipt.deliveryMinutes !== undefined),
    earliestDate: dated[0]?.localDate,
    latestDate: dated.at(-1)?.localDate,
    sourceCoverage: hasEmail && hasExport ? 'mixed' : hasEmail ? 'email' : hasExport ? 'export' : 'none',
  };
}
