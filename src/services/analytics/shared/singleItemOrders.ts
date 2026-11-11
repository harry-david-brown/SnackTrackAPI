import type { ReceiptForAnalytics } from '../WrappedAnalyticsTypes';
import { normalizeRestaurantName } from '../dashboard/normalization';
import { wrappedNetAmount } from './wrappedSpending';

const COMPOSITE_MENU_ITEM_PATTERN =
  /\b(?:meal|combo|bundle|box|platter|feast|family\s+pack|party\s+pack|variety\s+pack)\b/i;

const isCompositeMenuItem = (item: ReceiptForAnalytics['items'][number]): boolean =>
  item.evidence?.components.some((component) => component.quantity > 0) === true ||
  COMPOSITE_MENU_ITEM_PATTERN.test(item.name);

const GENERIC_PIZZA_SIZE_PATTERN = /^(?:small|medium|large|extra\s+large|x-?large)$/i;

export const singleItemDisplayName = (
  receipt: ReceiptForAnalytics,
  item: ReceiptForAnalytics['items'][number],
): string => {
  const name = item.name.trim();
  if (GENERIC_PIZZA_SIZE_PATTERN.test(name) && /\bpizza\b/i.test(receipt.restaurantName ?? '')) {
    return `${name} pizza`;
  }
  return name;
};

export function isSingleItemOrder(receipt: ReceiptForAnalytics, eventMetrics: boolean): boolean {
  const amount = wrappedNetAmount(receipt);
  return (
    (!eventMetrics ||
      normalizeRestaurantName(receipt.restaurantName ?? undefined)?.merchantClass ===
        'restaurant') &&
    receipt.items.length > 0 &&
    receipt.items.reduce((total, item) => total + item.quantity, 0) === 1 &&
    amount !== null &&
    amount < 20 &&
    receipt.items.every(
      (item) =>
        item.name.trim() && item.name.toLowerCase() !== 'unknown' && !isCompositeMenuItem(item),
    )
  );
}
