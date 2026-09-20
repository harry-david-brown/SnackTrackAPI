import { decodeItemEvidence, decodeResolution } from '../../models/ReceiptResolution';
import { DatabaseRow } from '../ports/DatabasePort';
import { DatabaseError } from '../../core/errors';
import { DataSource, Receipt, ReceiptItem, ReceiptType } from '../../models/Receipt';

export interface ReceiptRow extends DatabaseRow {
  id: unknown;
  user_id: unknown;
  items: unknown;
  amount_spent: unknown;
  receipt_type: unknown;
  restaurant_name: unknown;
  order_date: unknown;
  data_source: unknown;
  delivery_time: unknown;
  external_id: unknown;
  currency_code: unknown;
  subtotal_amount: unknown;
  tax_amount: unknown;
  tip_amount: unknown;
  delivery_fee_amount: unknown;
  service_fee_amount: unknown;
  savings_amount: unknown;
  resolution?: unknown;
}

type UnknownRecord = Record<string, unknown>;
const receiptTypes = new Set<string>(Object.values(ReceiptType));
const dataSources = new Set<string>(Object.values(DataSource));
const isReceiptType = (value: string): value is ReceiptType => receiptTypes.has(value);
const isDataSource = (value: string): value is DataSource => dataSources.has(value);
const invalid = (field: string): never => {
  throw new DatabaseError(`Invalid receipts row field: ${field}`);
};
const nonemptyString = (value: unknown, field: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : invalid(field);
const nullableString = (value: unknown, field: string): string | undefined =>
  value === null || value === undefined ? undefined : nonemptyString(value, field);
const nonnegativeNumber = (value: unknown, field: string): number => {
  const candidate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : invalid(field);
};
const nullableNonnegativeNumber = (value: unknown, field: string): number | undefined =>
  value === null || value === undefined ? undefined : nonnegativeNumber(value, field);
const record = (value: unknown, field: string): UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : invalid(field);

const parseDate = (value: unknown, field: string): Date | undefined => {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(nonemptyString(value, field));
  return Number.isNaN(date.getTime()) ? invalid(field) : date;
};

const parseItem = (value: unknown, field: string): ReceiptItem => {
  // Versioned migrations convert legacy TEXT[] items to a JSON string array.
  if (typeof value === 'string')
    return { name: nonemptyString(value, field), quantity: 1, price: 0 };
  const item = record(value, field);
  if (item.customizations !== undefined && !Array.isArray(item.customizations)) {
    invalid(`${field}.customizations`);
  }
  const customizations = item.customizations as unknown[] | undefined;
  return {
    ...(item.evidence === undefined ? {} : { evidence: decodeItemEvidence(item.evidence) }),
    name: nonemptyString(item.name, `${field}.name`),
    quantity: nonnegativeNumber(item.quantity, `${field}.quantity`),
    price: nonnegativeNumber(item.price, `${field}.price`),
    ...(item.category === undefined
      ? {}
      : { category: nonemptyString(item.category, `${field}.category`) }),
    ...(customizations === undefined
      ? {}
      : {
          customizations: customizations.map((entry, index) =>
            nonemptyString(entry, `${field}.customizations.${index}`),
          ),
        }),
  };
};

export const decodeReceiptItems = (value: unknown): ReceiptItem[] => {
  if (value === null) return [];
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch (cause) {
      throw new DatabaseError('Invalid receipts row field: items', cause);
    }
  }
  if (!Array.isArray(candidate)) invalid('items');
  return (candidate as unknown[]).map((item, index) => parseItem(item, `items.${index}`));
};

export const mapReceiptRow = (row: DatabaseRow): Receipt => {
  const receiptTypeValue = nonemptyString(row.receipt_type, 'receipt_type');
  const dataSourceValue = nonemptyString(row.data_source, 'data_source');
  const receiptType = isReceiptType(receiptTypeValue) ? receiptTypeValue : invalid('receipt_type');
  const dataSource = isDataSource(dataSourceValue) ? dataSourceValue : invalid('data_source');

  const rawCurrency = nullableString(row.currency_code, 'currency_code');
  const currencyCode = rawCurrency && ['CAD', 'USD', 'EUR', 'GBP', 'UNKNOWN'].includes(rawCurrency)
    ? rawCurrency as 'CAD' | 'USD' | 'EUR' | 'GBP' | 'UNKNOWN'
    : undefined;
  const monetaryDetails = {
    ...(currencyCode ? { currencyCode } : {}),
    ...(nullableNonnegativeNumber(row.subtotal_amount, 'subtotal_amount') === undefined ? {} : { subtotal: nullableNonnegativeNumber(row.subtotal_amount, 'subtotal_amount') }),
    ...(nullableNonnegativeNumber(row.tax_amount, 'tax_amount') === undefined ? {} : { tax: nullableNonnegativeNumber(row.tax_amount, 'tax_amount') }),
    ...(nullableNonnegativeNumber(row.tip_amount, 'tip_amount') === undefined ? {} : { tip: nullableNonnegativeNumber(row.tip_amount, 'tip_amount') }),
    ...(nullableNonnegativeNumber(row.delivery_fee_amount, 'delivery_fee_amount') === undefined ? {} : { deliveryFee: nullableNonnegativeNumber(row.delivery_fee_amount, 'delivery_fee_amount') }),
    ...(nullableNonnegativeNumber(row.service_fee_amount, 'service_fee_amount') === undefined ? {} : { serviceFee: nullableNonnegativeNumber(row.service_fee_amount, 'service_fee_amount') }),
    ...(nullableNonnegativeNumber(row.savings_amount, 'savings_amount') === undefined ? {} : { savings: nullableNonnegativeNumber(row.savings_amount, 'savings_amount') }),
  };
  return new Receipt(
    nonemptyString(row.user_id, 'user_id'),
    decodeReceiptItems(row.items),
    nonnegativeNumber(row.amount_spent, 'amount_spent'),
    receiptType,
    nullableString(row.restaurant_name, 'restaurant_name'),
    parseDate(row.order_date, 'order_date'),
    dataSource,
    parseDate(row.delivery_time, 'delivery_time'),
    nullableString(row.external_id, 'external_id'),
    nonemptyString(row.id, 'id'),
    Object.keys(monetaryDetails).length ? monetaryDetails : undefined,
    decodeResolution(row.resolution),
  );
};
