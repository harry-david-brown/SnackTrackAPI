import type { ReceiptListFilters } from '../../services/ports/ReceiptPorts';
import { RECEIPT_OUTCOME_FILTERS } from '../../services/receipt/ReceiptHistoryFilters';
import { ReceiptType } from '../../models/Receipt';
import { ValidationError } from '../../core/errors';
import { optionalQueryString, parseQueryNumber } from './requestValues';

function boundary(value: unknown, field: string): { day?: string; instant?: Date } {
  const text = optionalQueryString(value, field);
  if (text === undefined) return {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text)
      throw new ValidationError('Must be a valid calendar date', field);
    return { day: text };
  }
  // Legacy instant callers remain supported, but timezone-free clock strings are ambiguous.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) ||
    !Number.isFinite(Date.parse(text))
  )
    throw new ValidationError('Use YYYY-MM-DD or an ISO timestamp with a timezone', field);
  boundary(text.slice(0, 10), field);
  return { instant: new Date(text) };
}

/** Authenticated identity is supplied by the route, never read from query parameters. */
export function parseReceiptListFilters(
  userId: string,
  query: Record<string, unknown>,
): ReceiptListFilters {
  const type = optionalQueryString(query.receiptType, 'receiptType');
  const receiptType =
    type === undefined ? undefined : Object.values(ReceiptType).find((value) => value === type);
  if (type !== undefined && receiptType === undefined)
    throw new ValidationError('Unsupported receipt type', 'receiptType');
  const requestedOutcome = optionalQueryString(query.outcome, 'outcome');
  const outcome = RECEIPT_OUTCOME_FILTERS.find((value) => value === requestedOutcome);
  if (requestedOutcome !== undefined && outcome === undefined)
    throw new ValidationError('Unsupported order outcome', 'outcome');
  const requestedCurrency = optionalQueryString(query.currencyCode, 'currencyCode');
  const currencyCode = (['CAD', 'USD', 'EUR', 'GBP', 'UNKNOWN'] as const).find(
    (value) => value === requestedCurrency,
  );
  if (requestedCurrency !== undefined && currencyCode === undefined)
    throw new ValidationError('Unsupported currency', 'currencyCode');
  const start = boundary(query.startDate, 'startDate');
  const end = boundary(query.endDate, 'endDate');
  if (
    (start.day && end.day && start.day > end.day) ||
    (start.instant && end.instant && start.instant > end.instant)
  )
    throw new ValidationError('End date must not precede start date', 'endDate');
  const minAmount = parseQueryNumber(query.minAmount, 'minAmount');
  const maxAmount = parseQueryNumber(query.maxAmount, 'maxAmount');
  for (const [field, amount] of [
    ['minAmount', minAmount],
    ['maxAmount', maxAmount],
  ] as const)
    if (
      amount !== undefined &&
      (amount < 0 ||
        amount > 1_000_000 ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001)
    )
      throw new ValidationError('Use a nonnegative amount with at most two decimal places', field);
  if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount)
    throw new ValidationError('Maximum amount must not be below minimum amount', 'maxAmount');
  return {
    userId,
    receiptType,
    restaurantName: optionalQueryString(query.restaurantName, 'restaurantName'),
    outcome,
    currencyCode,
    startDay: start.day,
    endDay: end.day,
    startDate: start.instant,
    endDate: end.instant,
    minAmount,
    maxAmount,
  };
}
