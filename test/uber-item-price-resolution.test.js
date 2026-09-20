const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');
const { mapReceiptResponse } = require('../dist/http/mappers/receiptResponse');
const { buildDashboardInsightCatalogue } = require('../dist/services/analytics/dashboard');
const { reconstructUberItems } = require('../dist/services/receipt/OrderReconstruction');
const { createUberItemPriceResolver } = require('../dist/services/receipt/UberItemPriceResolver');

const row = (name, quantity, price) => ({
  Item_Name: name,
  Item_quantity: String(quantity),
  Item_Price: String(price),
  Customizations: '',
  Customization_Cost_Local: '',
});
const document = (date, rows, merchant = 'Tim Hortons', currency = 'CAD') => ({
  merchant,
  currency,
  orderDate: date,
  rows,
});

test('same-item quantity-one anchors distinguish old unit prices from line totals', () => {
  const reference = document('2021-02-10', [row("Farmer's Breakfast Wrap", 1, 5.49)]);
  const oldOrder = document('2021-02-14', [row("Farmer's Breakfast Wrap", 2, 5.49)]);
  const newerOrder = document('2021-03-01', [row("Farmer's Breakfast Wrap", 2, 10.98)]);
  const resolve = createUberItemPriceResolver([reference, oldOrder, newerOrder]);

  assert.deepEqual(resolve(oldOrder, oldOrder.rows[0]), {
    status: 'unit_inferred',
    recordedAmount: 5.49,
    unitAmount: 5.49,
    lineAmount: 10.98,
    reasons: ['same_item_quantity_one_reference'],
  });
  assert.deepEqual(resolve(newerOrder, newerOrder.rows[0]), {
    status: 'line_inferred',
    recordedAmount: 10.98,
    unitAmount: 5.49,
    lineAmount: 10.98,
    reasons: ['same_item_quantity_one_reference'],
  });
});

test('cohort inference needs three distinct unanimous anchors and rejects conflicts', () => {
  const anchors = [
    ['Coffee', 2],
    ['Cookie', 3],
    ['Donut', 4],
  ].flatMap(([name, quantity], index) => [
    document(`2024-01-0${index + 1}`, [row(name, 1, 2)], `Merchant ${index}`),
    document(`2024-01-1${index + 1}`, [row(name, quantity, 2)], `Merchant ${index}`),
  ]);
  const target = document('2024-02-01', [row('Wrap', 2, 5.49)], 'Another Merchant');
  const unanimous = createUberItemPriceResolver([...anchors, target])(target, target.rows[0]);
  assert.equal(unanimous.status, 'unit_inferred');
  assert.equal(unanimous.unitAmount, 5.49);

  const conflict = document('2024-01-20', [row('Donut', 4, 8)], 'Merchant 2');
  const unresolved = createUberItemPriceResolver([...anchors, conflict, target])(target, target.rows[0]);
  assert.equal(unresolved.status, 'ambiguous');
});

test('trustworthy subtotal reconstruction recovers the Farmers Wrap unit price', () => {
  const items = reconstructUberItems(
    [
      row('Chocolate Dip Donuts', 4, 1.42),
      row("Farmer's Breakfast Wrap", 2, 5.49),
      row('Sea Salted Caramel Dream Donut Donuts', 2, 2.19),
    ],
    21.04,
  );
  const wrap = items.find((item) => item.name.includes('Breakfast Wrap'));
  assert.equal(wrap.price, 5.49);
  assert.equal(wrap.evidence.configuredLineTotal, 10.98);
  assert.equal(wrap.evidence.priceResolution.status, 'unit_reconciled');
  assert.equal(Math.round(((5.99 - wrap.price) / wrap.price) * 100), 9);
  assert.equal(items.find((item) => item.name.startsWith('Chocolate')).price, 1.42);
  assert.equal(items.find((item) => item.name.startsWith('Sea Salted')).price, 2.19);
});

test('ambiguous price evidence is private, recorded-only in the API, and excluded from Foodflation', () => {
  const ambiguous = {
    name: "Farmer's Breakfast Wrap",
    quantity: 2,
    price: 0,
    evidence: {
      priceResolution: { status: 'ambiguous', recordedAmount: 5.49, reasons: ['no_price_basis_evidence'] },
      priceBasis: 'ambiguous',
      rawName: "Farmer's Breakfast Wrap",
      configuredName: "Farmer's Breakfast Wrap",
      baseLineTotal: 5.49,
      configuredLineTotal: 5.49,
      modifierTotal: 0,
      method: 'observed',
      sourceRows: [0],
      alternatives: [],
      components: [],
    },
  };
  const receipt = new Receipt('user', [ambiguous], 20, ReceiptType.UBER_EATS, 'Tim Hortons', new Date('2021-02-14T12:00:00Z'), DataSource.CSV, undefined, undefined, 'receipt-1', { currencyCode: 'CAD' });
  receipt.resolution = { version: 1, amountBasis: 'export_total', adjustments: [], issues: [] };
  const response = mapReceiptResponse(receipt);
  assert.deepEqual(response.items[0], { name: ambiguous.name, quantity: 2, price: 0, recordedPrice: 5.49, inferred: false });
  assert.doesNotMatch(JSON.stringify(response), /unit_reconciled|line_reconciled|unit_inferred|line_inferred|ambiguous|priceResolution|no_price_basis_evidence/);

  const recent = new Receipt('user', [{ name: ambiguous.name, quantity: 1, price: 5.99 }], 20, ReceiptType.UBER_EATS, 'Tim Hortons', new Date('2024-08-14T12:00:00Z'), DataSource.CSV, undefined, undefined, 'receipt-2', { currencyCode: 'CAD' });
  const catalogue = buildDashboardInsightCatalogue([receipt, recent], 'UTC', new Date('2024-09-01T12:00:00Z'));
  assert.equal(catalogue.eligible.some((candidate) => candidate.family === 'foodflation'), false);
});
