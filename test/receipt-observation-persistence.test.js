const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { Receipt } = require('../dist/models/Receipt');

const { database } = require('./helpers/receiptDatabase');
function observations() {
  const date = new Date('2025-08-06T13:48:00Z');
  const exported = new Receipt(
    'user',
    [
      { name: 'Sandwich', quantity: 2, price: 6.59 },
      { name: 'Hash Brown', quantity: 1, price: 2.69 },
    ],
    19.87,
    'uber_eats',
    'Example Branch',
    date,
    'csv',
    new Date('2025-08-06T14:15:00Z'),
    undefined,
    undefined,
    { currencyCode: 'CAD' },
    {
      version: 1,
      amountBasis: 'export_total',
      exportedTotal: 19.87,
      reconstructedSubtotal: 15.87,
      adjustments: [],
      issues: [],
    },
  );
  const email = new Receipt(
    'user',
    [],
    21.86,
    'uber_eats',
    'Example Branch',
    date,
    'email',
    undefined,
    'order-id',
    undefined,
    { currencyCode: 'CAD' },
    {
      version: 1,
      amountBasis: 'receipt_total',
      receiptTotal: 21.86,
      sourceMessageId: 'gmail:1',
      sourceRevisionAt: '2025-08-06T14:16:00Z',
      adjustments: [],
      issues: [],
    },
  );
  return { exported, email };
}
for (const order of ['email-first', 'export-first'])
  test(`${order}: both observations survive, stable ID and reimports are unchanged`, async () => {
    const db = database(),
      repo = new ReceiptRepository(db, 2),
      { email, exported } = observations(),
      allow = async () => {};
    if (order === 'email-first') await repo.upsertEmailReceipts([email], allow);
    else await repo.replaceProviderExport('user', [exported], allow);
    const id = db.state.receipts[0].id;
    if (order === 'email-first') await repo.replaceProviderExport('user', [exported], allow);
    else await repo.upsertEmailReceipts([email], allow);
    assert.equal(db.state.receipts.length, 1);
    assert.equal(db.state.receipts[0].id, id);
    assert.equal(db.state.observations.length, 2);
    assert.deepEqual(db.state.receipts[0].resolution.sources, ['csv', 'email']);
    assert.equal(db.state.receipts[0].resolution.checkoutDifference.amount, 5.99);
    const before = structuredClone(db.state);
    await repo.replaceProviderExport('user', [exported], allow);
    assert.deepEqual(await repo.upsertEmailReceipts([email], allow), {
      newOrders: 0,
      updatedOrders: 0,
      unchangedOrders: 1,
      unresolvedOrders: 0,
    });
    assert.deepEqual(db.state, before);
  });

test('competing exports cannot claim the same total-only email in either batch order', async () => {
  for (const emailFirst of [false, true])
    for (const reverse of [false, true]) {
      const db = database(),
        repo = new ReceiptRepository(db, 2),
        { email, exported } = observations(),
        allow = async () => {};
      const second = { ...exported, orderDate: new Date(exported.orderDate.getTime() + 30_000) };
      const batch = reverse ? [second, exported] : [exported, second];
      if (emailFirst) await repo.upsertEmailReceipts([email], allow);
      await repo.replaceProviderExport('user', batch, allow);
      if (!emailFirst) await repo.upsertEmailReceipts([email], allow);
      assert.equal(db.state.receipts.length, 3);
      assert.equal(db.state.observations.length, 3);
      assert.equal(db.state.receipts.filter((r) => r.resolution.checkoutDifference).length, 0);
    }
});

test('a lower revised email updates the same combined order and retains the original', async () => {
  const db = database(),
    repo = new ReceiptRepository(db, 2),
    { email, exported } = observations(),
    allow = async () => {};
  await repo.replaceProviderExport('user', [exported], allow);
  await repo.upsertEmailReceipts([email], allow);
  const revised = {
    ...email,
    amountSpent: 18,
    resolution: {
      ...email.resolution,
      receiptTotal: 18,
      sourceMessageId: 'gmail:2',
      sourceRevisionAt: '2025-08-07T12:00:00Z',
    },
  };
  assert.deepEqual(await repo.upsertEmailReceipts([revised], allow), {
    newOrders: 0,
    updatedOrders: 1,
    unchangedOrders: 0,
    unresolvedOrders: 0,
  });
  assert.equal(db.state.receipts.length, 1);
  assert.equal(db.state.observations.length, 3);
  assert.equal(db.state.receipts[0].amount_spent, 18);
  assert.equal(db.state.receipts[0].resolution.checkoutDifference.amount, 2.13);
});

test('unmatched email history is retained and a lost write guard rolls back both stores', async () => {
  const db = database(),
    repo = new ReceiptRepository(db, 2),
    { email, exported } = observations(),
    allow = async () => {};
  email.restaurantName = 'Other Restaurant';
  await repo.upsertEmailReceipts([email], allow);
  const before = structuredClone(db.state);
  let guards = 0;
  await assert.rejects(
    repo.replaceProviderExport('user', [exported], async () => {
      if (++guards === 3) throw Error('stale generation');
    }),
    /stale generation/,
  );
  assert.deepEqual(db.state, before);
  await repo.replaceProviderExport('user', [exported], allow);
  assert.equal(db.state.receipts.length, 2);
  assert.equal(db.state.observations.length, 2);
});

test('later identifying evidence joins earlier unmatched projections without losing any observations', async () => {
  const db = database(),
    repo = new ReceiptRepository(db, 2),
    { email, exported } = observations(),
    allow = async () => {};
  const original = { ...email, restaurantName: 'Unknown Branch' };
  await repo.upsertEmailReceipts([original], allow);
  const emailId = db.state.receipts[0].id;
  await repo.replaceProviderExport('user', [exported], allow);
  assert.equal(db.state.receipts.length, 2);
  const corrected = {
    ...email,
    resolution: {
      ...email.resolution,
      sourceMessageId: 'gmail:2',
      sourceRevisionAt: '2025-08-07T12:00:00Z',
    },
  };
  await repo.upsertEmailReceipts([corrected], allow);
  assert.equal(db.state.receipts.length, 1);
  assert.equal(db.state.receipts[0].id, emailId);
  assert.equal(db.state.observations.length, 3);
  assert.equal(
    db.state.observations.every((o) => o.receipt_id === emailId),
    true,
  );
  assert.equal(db.state.receipts[0].resolution.checkoutDifference.amount, 5.99);
  const before = structuredClone(db.state);
  await repo.replaceProviderExport('user', [exported], allow);
  assert.deepEqual(db.state, before);
});
