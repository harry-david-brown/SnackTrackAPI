import { DataSource, ReceiptType, type ReceiptItem, type ReceiptWriteCommand } from '../../models/Receipt';
import { CURRENT_UBER_EXPORT_PARSER_VERSION } from '../../models/OrderEvidence';
import { moneySum, type ItemEvidence } from '../../models/ReceiptResolution';
import { reconstructUberItems, type ExportItemRow } from './OrderReconstruction';
import { createUberItemPriceResolver, type UberPriceDocument } from './UberItemPriceResolver';

const validRows = (receipt: ReceiptWriteCommand): ExportItemRow[] | undefined => {
  const rows = receipt.resolution?.rows;
  if (!rows?.length || !rows.every(row => row.Item_Name && Number(row.Item_quantity) > 0 && Number.isFinite(Number(row.Item_Price)))) return undefined;
  return rows.map(row => ({ Item_Name: row.Item_Name, Item_quantity: row.Item_quantity, Item_Price: row.Item_Price,
    Customizations: row.Customizations ?? '', Customization_Cost_Local: row.Customization_Cost_Local ?? '' }));
};

const legacyRows = (receipt: ReceiptWriteCommand): ExportItemRow[] => receipt.items.map(item => ({
  Item_Name: item.name,
  Item_quantity: String(item.quantity),
  Item_Price: String(item.price * item.quantity),
  Customizations: item.customizations?.join(', ') ?? '',
  Customization_Cost_Local: '',
}));

const document = (receipt: ReceiptWriteCommand, rows: readonly ExportItemRow[]): UberPriceDocument => ({
  merchant: receipt.restaurantName ?? '',
  currency: receipt.monetaryDetails?.currencyCode ?? 'UNKNOWN',
  orderDate: receipt.orderDate?.toISOString() ?? '',
  rows,
});

const resolvedSubtotal = (items: readonly ReceiptItem[]): number | undefined =>
  items.every(item => item.evidence?.priceResolution?.status !== 'ambiguous')
    ? moneySum(items.map(item => item.evidence?.configuredLineTotal ?? item.price * item.quantity))
    : undefined;

/** Reinterprets source facts without using a charged order total as item-price evidence. */
export function createUberPriceReinterpreter(receipts: readonly ReceiptWriteCommand[]) {
  const candidates = receipts.filter(receipt => receipt.receiptType === ReceiptType.UBER_EATS && receipt.dataSource === DataSource.CSV);
  const documents = candidates.map(receipt => document(receipt, validRows(receipt) ?? legacyRows(receipt)));
  const resolvePrice = createUberItemPriceResolver(documents);
  return (receipt: ReceiptWriteCommand, legacy = false): ReceiptWriteCommand => {
    if (receipt.receiptType !== ReceiptType.UBER_EATS || receipt.dataSource !== DataSource.CSV) return receipt;
    const sourceRows = validRows(receipt);
    const rows = sourceRows ?? legacyRows(receipt);
    const context = document(receipt, rows);
    const items = sourceRows
      ? reconstructUberItems(rows, undefined, false, 'per_item', row => resolvePrice(context, row))
      : receipt.items.map((item, index) => {
          const resolution = resolvePrice(context, rows[index]);
          const lineAmount = resolution.status === 'ambiguous' ? resolution.recordedAmount : resolution.lineAmount;
          const evidence: ItemEvidence = {
            priceResolution: resolution,
            ...(item.customizations?.length ? { customizationPriceBasis: 'unavailable' as const } : {}),
            priceBasis: resolution.status === 'ambiguous' ? 'ambiguous' : resolution.status.startsWith('unit_') ? 'unit_assumed' : 'line_assumed',
            rawName: item.name,
            configuredName: item.name,
            baseLineTotal: lineAmount,
            configuredLineTotal: lineAmount,
            modifierTotal: 0,
            method: 'observed',
            sourceRows: [index],
            alternatives: resolution.status === 'ambiguous' ? ['Recorded amount cannot be identified as a unit price or line total'] : [],
            components: [],
          };
          return { ...item, price: resolution.status === 'ambiguous' ? 0 : resolution.unitAmount, evidence };
        });
    const reconstructedSubtotal = resolvedSubtotal(items);
    const resolution = {
      ...(receipt.resolution ?? { version: 1 as const, amountBasis: 'legacy' as const, adjustments: [], issues: [] }),
      ...(receipt.resolution?.orderEvidence
        ? { orderEvidence: { ...receipt.resolution.orderEvidence, parserVersion: CURRENT_UBER_EXPORT_PARSER_VERSION } }
        : {
            orderEvidence: {
              version: 1 as const,
              parserVersion: CURRENT_UBER_EXPORT_PARSER_VERSION,
              documentKind: 'export' as const,
              fulfillment: 'unknown' as const,
              timestamps: [],
              recordedTotal: receipt.amountSpent,
              totalState: 'known' as const,
              payments: [],
              issues: ['Legacy observation lacks complete order-event evidence'],
            },
          }),
      issues: [...new Set([
        ...(receipt.resolution?.issues ?? []),
        ...(legacy ? ['Legacy recorded item prices recovered from the prior normalization'] : []),
        ...(legacy && receipt.items.some(item => item.customizations?.length)
          ? ['Legacy customization pricing is unavailable']
          : []),
      ])],
      ...(reconstructedSubtotal === undefined ? {} : { reconstructedSubtotal }),
    };
    if (reconstructedSubtotal === undefined) delete resolution.reconstructedSubtotal;
    return { ...receipt, items, resolution };
  };
}
