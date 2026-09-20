const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVE_RECEIPT_POLICY } = require('../dist/services/receipt/ReceiptPolicy');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { ReceiptEmailBatchExtractor } = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { reconcileReceiptGroups, projectReconciledGroup } = require('../dist/services/receipt/ReceiptGroupReconciler');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');

test('active policy preserves legacy costs without inventing completed deliveries or known currency', () => {
  const metrics = summarizeOrderMetrics([{ amountSpent: 12.50, dataSource: 'email' }]);
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.deliveries, 0);
  assert.equal(metrics.unknownFulfillment, 1);
  assert.equal(metrics.legacyOrders, 1);
  assert.equal(metrics.currencies[0].currencyCode, 'UNKNOWN');
  assert.equal(metrics.currencies[0].netSpend, 12.50);
});

test('serving defaults use policy 3 from extraction through reconciliation and wallet-inclusive metrics', async () => {
  assert.equal(ACTIVE_RECEIPT_POLICY, 3);
  const exports = await new CsvImportService().parseUberEatsCsv(Buffer.from(fixture.csv), 'user', 'America/Toronto');
  const emails = await new ReceiptEmailBatchExtractor(new ReceiptExtractor(), { capture: async () => {} }).extract(
    fixture.emails.map(email => ({ userId: 'user', provider: 'gmail', providerMessageId: email.id,
      from: 'receipts@uber.com', to: 'redacted@example.test', subject: 'Your Uber Eats receipt', body: email.text,
      receivedAt: new Date('2023-12-11T17:00Z') })), 'America/Toronto', { userId: 'user', trigger: 'manual' });
  assert.equal(exports.receipts.length, 5);
  assert.equal(emails.supportedReceipts.length, 6);
  const observations = [...exports.receipts, ...emails.supportedReceipts].map((receipt, index) => ({ id: `source-${index}`, receipt }));
  for (const receipt of observations.map(o => o.receipt)) assert.equal(receipt.resolution.orderEvidence.parserVersion, 3);
  for (const evidence of [observations, [...observations].reverse()]) {
    const orders = reconcileReceiptGroups(evidence, 'America/Toronto').map((group, index) => projectReconciledGroup(group, `order-${index}`));
    const metrics = summarizeOrderMetrics(orders);
    assert.equal(orders.length, 5);
    assert.equal(metrics.attempts, 5);
    assert.equal(metrics.deliveries, 4);
    assert.equal(metrics.chargedCancellations, 1);
    assert.equal(metrics.fullyRefunded, 1);
    assert.equal(metrics.currencies[0].netSpend, 157.02);
    assert.equal(metrics.currencies[0].confirmedRefundAmount, 22.48);
  }
});
