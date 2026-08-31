import { QueryResultRow } from 'pg';
import {
  DataSource,
  Receipt,
  ReceiptItem,
  ReceiptType,
} from '../../models/Receipt';

export interface ReceiptRow extends QueryResultRow {
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
}

const receiptTypes = new Set<string>(Object.values(ReceiptType));
const dataSources = new Set<string>(Object.values(DataSource));
const isReceiptType = (value: string): value is ReceiptType => receiptTypes.has(value);
const isDataSource = (value: string): value is DataSource => dataSources.has(value);

const parseDate = (value: unknown): Date | undefined => {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const parseItems = (value: unknown): ReceiptItem[] => {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];

  return candidate.map((item): ReceiptItem => {
    if (typeof item === 'string') return { name: item, quantity: 1, price: 0 };
    if (typeof item !== 'object' || item === null) {
      return { name: 'Unknown item', quantity: 1, price: 0 };
    }
    const record = item as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : 'Unknown item',
      quantity: typeof record.quantity === 'number' ? record.quantity : 1,
      price: typeof record.price === 'number' ? record.price : 0,
    };
  });
};

export const mapReceiptRow = (row: ReceiptRow): Receipt => {
  const receiptTypeValue = String(row.receipt_type ?? ReceiptType.UNKNOWN);
  const dataSourceValue = String(row.data_source ?? DataSource.CSV);
  const amount = Number(row.amount_spent ?? 0);

  return new Receipt(
    String(row.user_id),
    parseItems(row.items),
    Number.isFinite(amount) ? amount : 0,
    isReceiptType(receiptTypeValue) ? receiptTypeValue : ReceiptType.UNKNOWN,
    row.restaurant_name === null || row.restaurant_name === undefined
      ? undefined
      : String(row.restaurant_name),
    parseDate(row.order_date),
    isDataSource(dataSourceValue) ? dataSourceValue : DataSource.CSV,
    parseDate(row.delivery_time),
    row.external_id === null || row.external_id === undefined ? undefined : String(row.external_id),
    String(row.id)
  );
};
