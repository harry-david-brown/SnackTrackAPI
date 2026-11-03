const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTrackedSpend } = require('../dist/services/analytics/shared/normalizedTrackedSpend');
const rates = { rates: { CAD: 1.5, USD: 1, JPY: 150 } };
test('converts and sums known net costs including refunds', () => {
  assert.deepEqual(normalizeTrackedSpend({ CAD: { total: 100, count: 2 }, USD: { total: -10, count: 1 } }, 'CAD', rates),
    { amount: 85, currencyCode: 'CAD', approximate: true });
  assert.equal(normalizeTrackedSpend({ USD: { total: 10, count: 1 } }, 'JPY', rates).amount, 1500);
});
test('same currency needs no rate, missing conversion data is not a partial total', () => {
  assert.deepEqual(normalizeTrackedSpend({ CAD: { total: 100, count: 1 } }, 'CAD'),
    { amount: 100, currencyCode: 'CAD', approximate: false });
  for (const source of ['USD', 'UNKNOWN']) {
    assert.equal(normalizeTrackedSpend({ CAD: { total: 100, count: 1 }, [source]: { total: 10, count: 1 } }, 'CAD').amount, null);
  }
  assert.equal(normalizeTrackedSpend({ CAD: { total: 0, count: 0 } }, 'CAD').amount, null);
  assert.equal(normalizeTrackedSpend({}, 'CAD').amount, 0);
});
