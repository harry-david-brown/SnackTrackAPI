const { CsvImportService } = require('../../dist/services/import/CsvImportService');
const {
  extractEmailOrderEvidence,
} = require('../../dist/services/extraction/ReceiptOrderEvidenceExtractor');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../../dist/services/receipt/ReceiptGroupReconciler');
const fixture = require('../fixtures/receipt-accuracy/december-10-2023');

async function decemberSourceObservations() {
  const timezone = 'America/Toronto';
  const exports = await new CsvImportService().parseUberEatsCsv(
    Buffer.from(fixture.csv),
    'fixture-user',
    timezone,
    3,
  );
  const observations = [
    ...exports.receipts.map((receipt, i) => ({ id: `export-${i}`, receipt })),
    ...fixture.emails.map((email) => ({
      id: email.id,
      receipt: {
        userId: 'fixture-user',
        dataSource: 'email',
        receiptType: 'uber_eats',
        restaurantName: email.merchant,
        orderDate: new Date('2023-12-10T17:00:00Z'),
        amountSpent: email.total,
        items: [],
        monetaryDetails: { currencyCode: 'CAD' },
        resolution: {
          version: 1,
          amountBasis: 'receipt_total',
          adjustments: [],
          issues: [],
          sourceMessageId: `gmail:${email.id}`,
          orderEvidence: extractEmailOrderEvidence({
            text: email.text,
            total: email.total,
            timezone,
          }),
        },
      },
    })),
  ];
  return observations;
}

async function decemberCanonicalOrders() {
  return reconcileReceiptGroups(await decemberSourceObservations(), 'America/Toronto', [], 3).map(
    (group, i) => projectReconciledGroup(group, `canonical-${i}`),
  );
}

const analyticsReceipts = (receipts) =>
  receipts.map((r) => ({
    ...r,
    currencyCode: r.monetaryDetails?.currencyCode,
    timezone: r.resolution?.timestamp?.timezone,
    deliveryTime: r.deliveryTime ?? null,
  }));
module.exports = { decemberCanonicalOrders, decemberSourceObservations, analyticsReceipts };
