require('./helpers/legacyReceiptPolicy');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDashboardInsightCatalogue,
  buildDashboardInsightEdition,
  DASHBOARD_INSIGHT_METRIC_VERSION,
  selectDailyInsights,
} = require('../dist/services/analytics/dashboard');

const now = new Date('2026-09-20T12:00:00Z');
const day = (start, offset) => new Date(Date.parse(start) + offset * 86400000).toISOString();
function receipt(id, restaurant, date, minutes = 30, event = false) {
  return {
    id, userId: 'rank-user', restaurantName: restaurant, orderDate: new Date(date),
    deliveryTime: new Date(Date.parse(date) + minutes * 60000),
    receiptType: 'uber_eats', dataSource: 'csv', amountSpent: 20, items: [],
    monetaryDetails: { currencyCode: 'CAD' },
    ...(event ? { resolution: {
      version: 1, amountBasis: 'receipt_total', sources: ['csv'], issues: [], adjustments: [],
      timestamp: { raw: date, role: 'placed', precision: 'minute', timezone: 'UTC', convention: 'fixture' },
      reconciliation: { policyVersion: 3, status: 'standalone', method: 'fixture', observationIds: [id] },
      orderOutcome: {
        version: 3, kind: 'order', fulfillment: 'completed', fulfillmentConfidence: 'confirmed',
        refundStatus: 'none_established', refundConfidence: 'unknown', originalCharge: 20,
        netAmount: 20, confirmedRefundAmount: null, estimatedRefundAmount: null,
        financialObservationIds: [id], cancellationCharge: null, financialConfidence: 'confirmed',
        events: [], issues: [],
      },
    } } : {}),
  };
}
const catalogue = (rows, date = now) => buildDashboardInsightCatalogue(rows, 'UTC', date).eligible;
const group = (rows, name, date = now) => catalogue(rows, date).filter(c => c.subjectGroup === name);
function assertRanks(cards, base, score) {
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map(c => c.insight.id), [base, `${base}-rank-2`, `${base}-rank-3`]);
  assert.deepEqual(cards.map(c => c.subjectRank), [1, 2, 3]);
  assert.deepEqual(cards.map(c => c.score), [score, score - 4, score - 8]);
  assert.ok(cards.every(c => c.orderIds.length > 0));
  assert.ok(cards.slice(1).every(c => /Second|Third|#2|#3/.test(c.insight.eyebrow)));
}

for (const event of [false, true]) {
  const mode = event ? 'order events' : 'legacy receipts';
  const make = (id, restaurant, date, minutes) => receipt(id, restaurant, date, minutes, event);
  test(`${mode}: three delivery rankings preserve thresholds, evidence and branch identity`, () => {
    const specs = [
      ['Burger Kitchen (King Street)', [10, 10, 10]],
      ['Burger Kitchen (Queen Street)', [20, 22, 24]],
      ['Pizza Kitchen', [20, 32, 44]], // inclusive consistency boundary
      ['Sushi Kitchen', [20, 35, 50]], // inclusive unpredictability boundary
      ['Taco Kitchen', [20, 40, 60]],
      ['Noodle Kitchen', [20, 45, 70]],
      ['Sparse Kitchen', [5, 5]],
      ['Middle Kitchen', [20, 33, 46]], // neither consistency nor unpredictability
    ];
    const rows = specs.flatMap(([name, waits], restaurantIndex) => waits.map((wait, i) =>
      make(`${restaurantIndex}-${i}`, name, day('2026-08-01T18:00:00Z', restaurantIndex * 5 + i), wait)));
    const fastest = group(rows, 'fastest-regulars');
    const consistent = group(rows, 'consistent-restaurants');
    const unpredictable = group(rows, 'unpredictable-restaurants');
    assertRanks(fastest, 'fastest-regular', 81);
    assertRanks(consistent, 'most-reliable-restaurant', 76);
    assertRanks(unpredictable, 'most-unpredictable-restaurant', 71);
    assert.deepEqual(fastest.map(c => c.insight.value), [10, 22, 32]);
    assert.deepEqual(consistent.map(c => c.insight.value), [0, 2, 12]);
    assert.deepEqual(unpredictable.map(c => c.insight.value), [25, 20, 15]);
    for (const cards of [fastest, consistent, unpredictable]) {
      assert.ok(cards.every(c => c.insight.methodology.sampleSize === 3));
      assert.ok(cards.every(c => c.orderIds.length === 3));
      assert.deepEqual(group([...rows].reverse(), cards[0].subjectGroup).map(c => c.insight), cards.map(c => c.insight));
    }
    assert.deepEqual(fastest[1].orderIds.slice().sort(), ['1-0', '1-1', '1-2']);
    assert.equal(group(rows.filter(r => r.restaurantName === 'Sparse Kitchen'), 'fastest-regulars').length, 0);
  });

  test(`${mode}: delivery ties prefer larger samples, then canonical branch keys`, () => {
    const rows = ['Taco Kitchen', 'Burger Kitchen', 'Pizza Kitchen'].flatMap((name, j) =>
      Array.from({ length: j === 0 ? 4 : 3 }, (_, i) => make(`${j}-${i}`, name, day('2026-08-01T18:00:00Z', j * 5 + i), 30)));
    const cards = group(rows, 'fastest-regulars');
    assert.deepEqual(cards.map(c => c.insight.title), ['Taco Kitchen', 'Burger Kitchen', 'Pizza Kitchen']);
    assert.deepEqual(cards.map(c => c.insight.value), [30, 30, 30]);
    assert.deepEqual(group(rows, 'consistent-restaurants').map(c => c.insight.title), cards.map(c => c.insight.title));
  });

  test(`${mode}: full historical streaks and distinct restaurant runs have precise evidence`, () => {
    const rows = [5, 4, 3].flatMap((length, j) => Array.from({ length }, (_, i) =>
      make(`${j}-${i}`, ['Burger Kitchen', 'Pizza Kitchen', 'Sushi Kitchen'][j], day('2026-08-01T18:00:00Z', j * 10 + i))));
    // An additional, shorter run from the first restaurant must not get another slot.
    rows.push(...[0, 1, 2].map(i => make(`repeat-${i}`, 'Burger Kitchen', day('2026-09-01T18:00:00Z', i))));
    const streaks = group(rows, 'ordering-streaks');
    const runs = group(rows, 'restaurant-runs');
    assertRanks(streaks, 'longest-order-streak', 86);
    assertRanks(runs, 'restaurant-tunnel-vision', 82);
    assert.deepEqual(streaks.map(c => c.orderIds.length), [5, 4, 3]);
    assert.deepEqual(runs.map(c => c.insight.value), [5, 4, 3]);
    assert.equal(new Set(streaks.flatMap(c => c.orderIds)).size, 12);
    assert.equal(new Set(runs.map(c => c.insight.headline)).size, 3);
    assert.deepEqual(runs[0].orderIds.slice().sort(), ['0-0', '0-1', '0-2', '0-3', '0-4']);
    assert.ok(catalogue(rows, new Date('2026-09-03T23:00:00Z')).some(c => c.insight.id === 'current-order-streak'));
    assert.equal(group(rows.slice(0, 2), 'ordering-streaks').length, 0);
    assert.equal(group(rows.slice(0, 5), 'ordering-streaks').length, 1);
    assert.equal(group(rows.slice(0, 9), 'ordering-streaks').length, 2);
  });

  test(`${mode}: same-day restaurant runs link exact orders, not every visit that day`, () => {
    const names = ['Burger Kitchen', 'Burger Kitchen', 'Burger Kitchen', 'Pizza Kitchen', 'Burger Kitchen'];
    const rows = names.map((name, i) => make(`same-day-${i}`, name, `2026-08-01T${String(10 + i).padStart(2, '0')}:00:00Z`));
    assert.deepEqual(group(rows, 'restaurant-runs')[0].orderIds.slice().sort(), ['same-day-0', 'same-day-1', 'same-day-2']);
  });

  test(`${mode}: comebacks rank distinct restaurants and link only the bounding pair`, () => {
    const rows = [150, 120, 90, 89].flatMap((gap, j) => {
      const returned = '2026-08-20T18:00:00Z';
      return [make(`${j}-first`, `Kitchen ${['Burger', 'Pizza', 'Sushi', 'Taco'][j]}`, day(returned, -gap - 1)),
        make(`${j}-before`, `Kitchen ${['Burger', 'Pizza', 'Sushi', 'Taco'][j]}`, day(returned, -gap)),
        make(`${j}-return`, `Kitchen ${['Burger', 'Pizza', 'Sushi', 'Taco'][j]}`, returned)];
    });
    const cards = group(rows, 'restaurant-comebacks');
    assertRanks(cards, 'restaurant-comeback', 80);
    assert.deepEqual(cards.map(c => c.insight.events[0].value), ['150 days', '120 days', '90 days']);
    cards.forEach((c, i) => assert.deepEqual(c.orderIds.slice().sort(), [`${i}-before`, `${i}-return`]));
    assert.equal(group(rows.slice(0, 2), 'restaurant-comebacks').length, 0);
    assert.equal(group(rows, 'restaurant-comebacks', new Date(day('2026-08-20T18:00:00Z', 365))).length, 3);
    assert.equal(group(rows, 'restaurant-comebacks', new Date(day('2026-08-20T18:00:00Z', 366))).length, 0);
  });

  test(`${mode}: eras are complete and former favourites retain crown and history requirements`, () => {
    const rows = [];
    // Equal two-year eras are separated by a missing year; one merchant can have two eras.
    const years = [[2015, 'Burger Kitchen'], [2016, 'Burger Kitchen'], [2017, 'Burger Kitchen'],
      [2018, 'Pizza Kitchen'], [2019, 'Pizza Kitchen'], [2021, 'Burger Kitchen'], [2022, 'Burger Kitchen'],
      [2023, 'Sushi Kitchen'], [2024, 'Sushi Kitchen']];
    for (const [year, name] of years) for (let i = 0; i < 3; i++) rows.push(make(`${year}-${i}`, name, `${year}-01-0${i + 1}T18:00:00Z`));
    const eras = group(rows, 'restaurant-eras');
    const former = group(rows, 'former-favourites');
    assertRanks(eras, 'restaurant-era', 79);
    assertRanks(former, 'former-favourite', 72);
    assert.deepEqual(eras.map(c => c.insight.events[0].value), ['2015', '2018', '2021']);
    assert.deepEqual(eras.map(c => c.orderIds.length), [9, 6, 6]);
    assert.deepEqual(former.map(c => c.insight.events[0].value), [15, 6, 6]);
    assert.deepEqual(former.map(c => c.insight.detail), [15, 6, 6].map(count =>
      `${count} tracked orders historically, but none recorded in the latest 180 days.`));
    rows.push(make('recent', 'Burger Kitchen', day(now.toISOString(), -180)));
    assert.equal(group(rows, 'former-favourites').length, 2);
    assert.ok(group(rows, 'former-favourites').every(c => !c.insight.title.includes('Burger')));
    assert.equal(group(rows.filter(r => r.orderDate.getUTCFullYear() === 2015), 'former-favourites').length, 0);
  });

  test(`${mode}: latest checkout ranks cross midnight and preserve single-order evidence`, () => {
    const rows = ['23:59', '00:30', '03:30', '03:30', '12:00'].map((time, i) =>
      make(`late-${i}`, 'Burger Kitchen', `2026-08-01T${time}:00Z`));
    const cards = group(rows, 'latest-order-times');
    assertRanks(cards, 'latest-ever-order', 77);
    assert.deepEqual(cards.map(c => c.orderIds), [['late-2'], ['late-3'], ['late-1']]);
    assert.deepEqual(cards.map(c => c.insight.events[0].value), ['3:30 AM', '3:30 AM', '12:30 AM']);
    assert.doesNotMatch(cards[1].insight.title, /^Latest recorded/);
    assert.equal(group(rows.slice(-1), 'latest-order-times').length, 0);
    assert.equal(group(rows.slice(0, 1), 'latest-order-times').length, 1);
    assert.equal(group(rows.slice(0, 2), 'latest-order-times').length, 2);
    const edition = buildDashboardInsightEdition(rows, 'UTC', 'rank-user', now);
    assert.equal(edition.metricVersion, 'daily-v22');
  });
}

function candidate(id, category, score, family, subjectGroup) {
  return { family, subjectGroup, score, insight: {
    id, presentation: 'hero', category, icon: 'calendar', eyebrow: id, title: id, value: 1, valueFormat: 'number',
  } };
}
test('sparse editions and opener replacement never introduce a second ranked sibling', () => {
  // The earlier related family is a different group: opener replacement must prefer its own sibling.
  const candidates = [
    candidate('related', 'progress', 100, 'shared-family', 'other-group'),
    candidate('winner', 'favorites', 86, 'shared-family', 'ranked-group'),
    candidate('runner-up', 'favorites', 82, 'shared-family', 'ranked-group'),
    candidate('third', 'favorites', 78, 'shared-family', 'ranked-group'),
  ];
  const seen = new Set();
  for (let i = 0; i < 90; i++) {
    const date = day('2026-01-01T12:00:00Z', i).slice(0, 10);
    const edition = selectDailyInsights(candidates, 'rank-user', date, DASHBOARD_INSIGHT_METRIC_VERSION);
    const siblings = edition.filter(c => ['winner', 'runner-up', 'third'].includes(c.id));
    assert.ok(siblings.length <= 1);
    siblings.forEach(c => seen.add(c.id));
    assert.deepEqual(selectDailyInsights(candidates, 'rank-user', date, DASHBOARD_INSIGHT_METRIC_VERSION), edition);
  }
  assert.ok(seen.has('runner-up'));
  assert.ok(seen.has('third'));
});

test('comebacks choose one longest gap per restaurant, then the latest return and canonical key', () => {
  const histories = [
    ['Burger Kitchen', ['2025-09-01', '2025-12-10', '2026-03-20']], // two equal 100-day gaps
    ['Pizza Kitchen', ['2025-12-09', '2025-12-10', '2026-03-20']],
    ['Sushi Kitchen', ['2025-11-30', '2025-12-01', '2026-03-11']],
  ];
  const rows = histories.flatMap(([name, dates], j) => dates.map((date, i) => receipt(`${j}-${i}`, name, `${date}T18:00:00Z`, 30, true)));
  const cards = group(rows, 'restaurant-comebacks');
  assert.deepEqual(cards.map(c => c.insight.title), ['Burger Kitchen returned', 'Pizza Kitchen returned', 'Sushi Kitchen returned']);
  assert.deepEqual(cards[0].orderIds.slice().sort(), ['0-1', '0-2']);
});

test('shared yearly crowns break eras and do not qualify as a former sole favourite', () => {
  const rows = [];
  for (const year of [2020, 2021, 2022, 2023, 2024]) {
    for (let i = 0; i < 3; i++) {
      rows.push(receipt(`${year}-burger-${i}`, 'Burger Kitchen', `${year}-01-0${i + 1}T18:00:00Z`, 30, true));
      if (year === 2022) rows.push(receipt(`${year}-pizza-${i}`, 'Pizza Kitchen', `${year}-02-0${i + 1}T18:00:00Z`, 30, true));
    }
  }
  const cards = group(rows, 'restaurant-eras');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(c => c.insight.events[0].value), ['2020', '2023']);
  assert.deepEqual(cards.map(c => c.orderIds.length), [6, 6]);
  assert.deepEqual(group(rows, 'former-favourites').map(c => c.insight.title), ['Whatever happened to Burger Kitchen?']);
});

test('order-event rankings respect delivery status and per-order local time evidence', () => {
  const rows = ['04:30', '07:30', '06:30', '05:30'].map((time, i) => {
    const row = receipt(`tz-${i}`, 'Burger Kitchen', `2026-08-01T${time}:00Z`, 30, true);
    row.resolution.timestamp.timezone = 'America/Toronto';
    return row;
  });
  rows[1].resolution.orderOutcome.fulfillment = 'canceled';
  rows[2].resolution.timestamp.precision = 'date';
  const cards = group(rows, 'latest-order-times');
  assert.deepEqual(cards.map(c => c.orderIds), [['tz-3'], ['tz-0']]);
  assert.deepEqual(cards.map(c => c.insight.events[0].value), ['1:30 AM', '12:30 AM']);
  assert.equal(group(rows, 'fastest-regulars').length, 0);
});

test('cooldown editions rotate all new ranked families without sibling collisions', () => {
  const groups = ['fastest-regulars', 'consistent-restaurants', 'unpredictable-restaurants',
    'ordering-streaks', 'restaurant-runs', 'restaurant-comebacks', 'former-favourites',
    'latest-order-times', 'restaurant-eras'];
  const candidates = groups.flatMap((name, i) => [1, 2, 3].map(rank => ({
    ...candidate(`${name}-${rank}`, ['favorites', 'habits', 'extremes'][i % 3], 86 - rank * 4, name, name),
    subjectRank: rank,
  })));
  const seen = new Set();
  for (let i = 0; i < 90; i++) {
    const edition = selectDailyInsights(candidates, 'rank-user', day('2026-01-01T12:00:00Z', i).slice(0, 10), DASHBOARD_INSIGHT_METRIC_VERSION);
    for (const name of groups) assert.ok(edition.filter(c => c.id.startsWith(`${name}-`)).length <= 1);
    edition.forEach(c => seen.add(c.id));
  }
  for (const name of groups) {
    assert.ok(seen.has(`${name}-2`), `${name} second rank rotates`);
    assert.ok(seen.has(`${name}-3`), `${name} third rank rotates`);
  }
});

test('dashboard cache reads and writes use the new metric version', async () => {
  const { GetDashboardInsightsService } = require('../dist/services/user/GetDashboardInsightsService');
  const keys = [];
  const service = new GetDashboardInsightsService(
    { findProjectionProfileById: async () => ({ id: 'rank-user', timezone: 'UTC', receiptProjectionRevision: '7' }) },
    { findByUserId: async () => [] },
    {
      getDashboardInsightEdition: async key => { keys.push(key); return null; },
      cacheDashboardInsightEdition: async key => { keys.push(key); },
    },
  );
  const result = await service.execute({ userId: 'rank-user', devDayOffset: 0 });
  assert.equal(result.metricVersion, 'daily-v22');
  assert.ok(keys.length >= 2);
  assert.ok(keys.every(key => key.startsWith('rank-user:r7:daily-v22:UTC:')));
});
