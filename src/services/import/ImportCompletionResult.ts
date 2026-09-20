import { decodeReceiptImportOutcome } from './ReceiptImportOutcome';

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Shared by notification dispatch and delivery; importedCount is never added to new/updated. */
export function importCompletionResult(result: Readonly<Record<string, unknown>> | null) {
  const outcome =
    result?.receiptOutcome === undefined
      ? undefined
      : decodeReceiptImportOutcome(result.receiptOutcome);
  const newOrders = outcome?.newOrders ?? count(result?.newOrders);
  const updatedOrders = outcome?.updatedOrders ?? count(result?.updatedOrders);
  const changed =
    newOrders !== null || updatedOrders !== null ? (newOrders ?? 0) + (updatedOrders ?? 0) : null;
  const checked = outcome?.ordersProcessed ?? count(result?.importedCount);
  const needsMatching =
    (outcome?.unresolvedOrders ?? count(result?.unresolvedOrders) ?? 0) > 0 ||
    (outcome?.unlinkedAdjustments ?? 0) > 0;
  const pieces = [
    newOrders ? `${newOrders} new ${newOrders === 1 ? 'order' : 'orders'} added.` : '',
    updatedOrders
      ? `${updatedOrders} existing ${updatedOrders === 1 ? 'order' : 'orders'} updated.`
      : '',
    needsMatching ? 'Some receipts still need matching.' : '',
  ].filter(Boolean);
  return {
    hasChanges: (changed ?? checked ?? 0) > 0,
    title: newOrders
      ? newOrders === 1
        ? 'New order found'
        : 'New orders found'
      : 'Order history updated',
    body:
      pieces.join(' ') ||
      (checked && changed === null
        ? `${checked} orders checked. View your history for details.`
        : 'Your receipt check finished with no new orders.'),
  };
}
