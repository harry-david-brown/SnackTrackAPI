import { Currency, ExtractionResult, ServiceType } from './types';
import { decodeAdjustments } from '../../models/ReceiptResolution';
import { decodeOrderSourceEvidence } from '../../models/OrderEvidence';

type UnknownRecord = Record<string, unknown>;

const invalid = (field: string): never => {
  throw new Error(`Invalid receipt extraction result: ${field}`);
};
const record = (value: unknown, field: string): UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : invalid(field);
const string = (value: unknown, field: string): string =>
  typeof value === 'string' ? value : invalid(field);
const nullableString = (value: unknown, field: string): string | null =>
  value === null ? null : string(value, field);
const finiteNumber = (value: unknown, field: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : invalid(field);
const nullableNumber = (value: unknown, field: string): number | null =>
  value === null ? null : finiteNumber(value, field);
const stringArray = (value: unknown, field: string): string[] =>
  Array.isArray(value)
    ? value.map((entry, index) => string(entry, `${field}.${index}`))
    : invalid(field);
const enumValue = <Value extends string>(
  value: unknown,
  values: readonly Value[],
  field: string,
): Value =>
  typeof value === 'string' && values.includes(value as Value) ? (value as Value) : invalid(field);
const nullableDate = (value: unknown, field: string): Date | null => {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return invalid(field);
  return value;
};

const currencies = Object.values(Currency);
const services = Object.values(ServiceType);

/** Decodes the parser output before it enters import orchestration. */
export const decodeExtractionResult = (value: unknown): ExtractionResult => {
  const result = record(value, 'result');
  const classification = record(result.classification, 'classification');
  const confidence = finiteNumber(classification.confidence, 'classification.confidence');
  if (confidence < 0 || confidence > 1) invalid('classification.confidence');

  let data: ExtractionResult['data'] = null;
  if (result.data !== null) {
    const candidate = record(result.data, 'data');
    const extractionConfidence = finiteNumber(
      candidate.extractionConfidence,
      'data.extractionConfidence',
    );
    if (extractionConfidence < 0 || extractionConfidence > 1) {
      invalid('data.extractionConfidence');
    }
    data = {
      ...(candidate.orderEvidence === undefined ? {} : { orderEvidence: decodeOrderSourceEvidence(candidate.orderEvidence) }),
      ...(candidate.items === undefined ? {} : { items: (() => {
        if (!Array.isArray(candidate.items) || candidate.items.length > 500) return invalid('data.items');
        return candidate.items.map((value,index) => {
          const item = record(value, `data.items.${index}`);
          const quantity = finiteNumber(item.quantity, 'item.quantity'), price = finiteNumber(item.price, 'item.price');
          if (quantity <= 0 || quantity > 1000 || price < 0 || price > 1_000_000) return invalid('item amounts');
          return { name: string(item.name, 'item.name'), quantity, price,
            ...(item.customizations === undefined ? {} : { customizations: stringArray(item.customizations, 'item.customizations') }) };
        });
      })() }),
      ...(candidate.adjustments === undefined ? {} : { adjustments: decodeAdjustments(candidate.adjustments) }),
      ...(candidate.headlineSavings === undefined ? {} : { headlineSavings: finiteNumber(candidate.headlineSavings, 'data.headlineSavings') }),
      orderId: nullableString(candidate.orderId, 'data.orderId'),
      service: enumValue(candidate.service, services, 'data.service'),
      merchant: nullableString(candidate.merchant, 'data.merchant'),
      orderDate: nullableString(candidate.orderDate, 'data.orderDate'),
      orderTime: nullableString(candidate.orderTime, 'data.orderTime'),
      parsedDate: nullableDate(candidate.parsedDate, 'data.parsedDate'),
      currency: enumValue(candidate.currency, currencies, 'data.currency'),
      total: nullableNumber(candidate.total, 'data.total'),
      subtotal: nullableNumber(candidate.subtotal, 'data.subtotal'),
      tax: nullableNumber(candidate.tax, 'data.tax'),
      tip: nullableNumber(candidate.tip, 'data.tip'),
      deliveryFee: nullableNumber(candidate.deliveryFee, 'data.deliveryFee'),
      serviceFee: nullableNumber(candidate.serviceFee, 'data.serviceFee'),
      savings: nullableNumber(candidate.savings, 'data.savings'),
      deliveryAddress: nullableString(candidate.deliveryAddress, 'data.deliveryAddress'),
      paymentMethod: nullableString(candidate.paymentMethod, 'data.paymentMethod'),
      subject: string(candidate.subject, 'data.subject'),
      from: string(candidate.from, 'data.from'),
      extractionConfidence,
      warnings: stringArray(candidate.warnings, 'data.warnings'),
    };
  }

  return {
    classification: {
      isReceipt:
        typeof classification.isReceipt === 'boolean'
          ? classification.isReceipt
          : invalid('classification.isReceipt'),
      confidence,
      reason: string(classification.reason, 'classification.reason'),
      matchedKeywords: stringArray(
        classification.matchedKeywords,
        'classification.matchedKeywords',
      ),
      tableWordHits: finiteNumber(classification.tableWordHits, 'classification.tableWordHits'),
    },
    data,
    rawText: string(result.rawText, 'rawText'),
    coreText: string(result.coreText, 'coreText'),
  };
};
