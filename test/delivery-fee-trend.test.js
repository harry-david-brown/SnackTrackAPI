const test = require('node:test');
const assert = require('node:assert/strict');
const { WrappedAnalyticsCalculator } = require('../dist/services/analytics/WrappedAnalyticsService');

const receipt = (date, deliveryFee, serviceFee, currencyCode = 'CAD') => ({
  orderDate: new Date(date), deliveryFee, serviceFee, currencyCode,
});

test('delivery fee trend uses explicit same-currency quarters with sufficient coverage', async () => {
  const calculator = new WrappedAnalyticsCalculator();
  const trend = await calculator.calculateDeliveryFeeTrend([
    receipt('2025-01-01', 2, 1), receipt('2025-01-10', 2, 1), receipt('2025-01-15', 2, 1),
    receipt('2025-04-05', 3, 2), receipt('2025-04-10', 3, 2), receipt('2025-04-15', 3, 2),
  ]);
  assert.equal(trend.trend, 'increased');
  assert.equal(trend.companyFeeChangePercent, 66.7);
  assert.equal(trend.coveredOrderCount, 6);
});

test('delivery fee trend omits mixed currencies and missing fee components', async () => {
  const calculator = new WrappedAnalyticsCalculator();
  const base = [
    receipt('2025-01-01', 2, 1), receipt('2025-01-10', 2, 1), receipt('2025-01-15', 2, 1),
    receipt('2025-04-05', 3, 2), receipt('2025-04-10', 3, 2), receipt('2025-04-15', 3, 2, 'USD'),
  ];
  assert.equal(await calculator.calculateDeliveryFeeTrend(base), undefined);
  assert.equal(await calculator.calculateDeliveryFeeTrend(base.map((value, index) => index === 5 ? { ...value, currencyCode: 'CAD', serviceFee: null } : value)), undefined);
});
