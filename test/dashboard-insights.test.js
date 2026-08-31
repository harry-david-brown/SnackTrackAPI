const test = require('node:test');
const assert = require('node:assert/strict');

const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');
const { CacheService } = require('../dist/services/core/CacheService');
const { redisConfig } = require('../dist/config/redis');
const {
  DASHBOARD_INSIGHT_METRIC_VERSION,
  GENERIC_ITEM_PUNCHLINES,
  ITEM_PERSONALITY_PROFILES,
  buildDashboardDataset,
  buildDashboardInsightCatalogue,
  buildDashboardInsightEdition,
  canonicalBasketKey,
  classifyItemPersonality,
  classifyMerchant,
  getNextLocalMidnight,
  getDashboardInsightPreviewNow,
  getInsightValueBand,
  getItemPhysicalMultiplier,
  isLateNightHour,
  normalizeItem,
  normalizeRestaurantName,
  applyDailyCopyVariant,
  selectDailyInsights,
} = require('../dist/services/analytics/dashboard');

const receipt = ({
  amount = 20,
  restaurant = 'Test Kitchen',
  date,
  deliveryMinutes,
  source = DataSource.CSV,
  items = [],
}) => new Receipt(
  'user-id',
  items,
  amount,
  ReceiptType.UBER_EATS,
  restaurant,
  date ? new Date(date) : undefined,
  source,
  date && deliveryMinutes ? new Date(Date.parse(date) + deliveryMinutes * 60_000) : undefined,
);

test('restaurant, merchant, item, and basket normalization is conservative and stable', () => {
  assert.deepEqual(normalizeRestaurantName(" McDonald's - #1042 "), {
    key: 'mcdonalds', label: "McDonald's", merchantClass: 'restaurant',
  });
  assert.equal(normalizeRestaurantName("McDonald's (123 King Street)").key, 'mcdonalds');
  assert.equal(normalizeRestaurantName('Fresh Bowl - Downtown').key, 'fresh bowl downtown');
  assert.equal(normalizeRestaurantName('Fresh Bowl').key, 'fresh bowl');
  assert.equal(classifyMerchant('walmart grocery'), 'grocery');
  assert.equal(classifyMerchant('shoppers drug mart pharmacy'), 'pharmacy');
  assert.equal(classifyMerchant('lcbo'), 'alcohol');

  const nuggets = normalizeItem({ name: '10 McNuggets® (830 Cals)', quantity: 2, price: 8 });
  const cookies = normalizeItem({ name: '12-Pack Cookies', quantity: 1, price: 10 });
  assert.equal(nuggets.family, 'nugget');
  assert.equal(nuggets.physicalUnits, 20);
  assert.equal(cookies.family, 'cookie');
  assert.equal(cookies.physicalUnits, 12);
  assert.equal(classifyItemPersonality('pepperoni pizza'), 'pizza');
  assert.equal(classifyItemPersonality('brown sugar bubble tea'), 'bubble_tea');
  assert.equal(classifyItemPersonality('mystery bowl'), 'other');
  assert.equal(getItemPhysicalMultiplier('20 mcnuggets', 'nugget'), 20);
  assert.equal(getItemPhysicalMultiplier('6 piece wings', 'fried_chicken'), 6);
  assert.equal(
    canonicalBasketKey('test kitchen', [nuggets, cookies]),
    canonicalBasketKey('test kitchen', [cookies, nuggets]),
  );
});

test('shared late-night window and humour value bands use canonical boundaries', () => {
  assert.equal(isLateNightHour(21), false);
  assert.equal(isLateNightHour(22), true);
  assert.equal(isLateNightHour(3), true);
  assert.equal(isLateNightHour(4), false);
  assert.equal(getInsightValueBand(19), 'small');
  assert.equal(getInsightValueBand(20), 'notable');
  assert.equal(getInsightValueBand(500), 'legendary');
});

test('dataset is built once with positive, local, source, delivery, and item indexes', () => {
  const data = buildDashboardDataset([
    receipt({ amount: 0, date: '2026-01-01T04:30:00.000Z' }),
    receipt({ restaurant: 'Walmart Grocery', date: '2026-01-02T04:30:00.000Z', deliveryMinutes: 50, items: [{ name: '12-Pack Cookies', quantity: 1, price: 10 }] }),
    receipt({ restaurant: 'Night Kitchen', date: '2026-01-03T04:30:00.000Z', source: DataSource.EMAIL }),
    receipt({ date: undefined, items: [] }),
  ], 'America/Toronto', new Date('2026-01-04T12:00:00.000Z'));

  assert.equal(data.receipts.length, 4);
  assert.equal(data.positive.length, 3);
  assert.equal(data.dated.length, 2);
  assert.equal(data.sourceCoverage, 'mixed');
  assert.equal(data.deliveryReceipts.length, 1);
  assert.equal(data.itemTotals.get('12 pack cookies').units, 12);
  assert.equal(data.byLocalDate.get('2026-01-01').length, 1, 'UTC Jan 2 is still Jan 1 locally');
});

test('catalogue covers repeated baskets, physical item totals, restaurant stories, waits, and investment metadata', () => {
  const receipts = [];
  for (let index = 0; index < 18; index++) {
    const year = index < 9 ? 2024 : 2025;
    const restaurant = index < 9 ? 'Old Favourite' : 'New Favourite';
    receipts.push(receipt({
      amount: 18 + index,
      restaurant,
      date: `${year}-${String((index % 9) + 1).padStart(2, '0')}-05T18:00:00.000Z`,
      deliveryMinutes: 25 + (index % 3) * 5,
      items: [
        { name: '10 McNuggets', quantity: 1, price: 8 },
        { name: 'Cookie', quantity: 1, price: 2 },
      ],
    }));
  }
  const catalogue = buildDashboardInsightCatalogue(receipts, 'America/Toronto', new Date('2026-01-10T15:00:00.000Z'));
  const byId = new Map(catalogue.eligible.map(candidate => [candidate.insight.id, candidate.insight]));

  assert.ok(byId.has('exact-basket-soulmate'));
  assert.ok(byId.has('item-obsession-nugget'));
  assert.ok(byId.has('item-obsession-cookie'));
  assert.ok(byId.has('restaurant-crown-changed'));
  assert.ok(byId.has('former-favourite'));
  assert.ok(byId.has('most-predictable-order'));
  assert.ok(byId.has('accumulated-delivery-time'));
  assert.ok(byId.has('fastest-regular'));
  const itemObsession = byId.get('item-obsession-nugget');
  assert.equal(itemObsession.title, '180 nuggets');
  assert.equal(itemObsession.detail, 'Your tracked orders included 180 nuggets.');
  assert.deepEqual(itemObsession.methodology, { sampleSize: 18 });
  assert.doesNotMatch(JSON.stringify(itemObsession), /roughly|approximately|estimated|\babout\b|customization rows/i);
  const investment = byId.get('hypothetical-investment');
  assert.equal(investment.presentation, 'comparison');
  assert.equal(investment.comparison.variant, 'investment');
  assert.equal(investment.comparison.previousLabel, 'You spent');
  assert.equal(investment.comparison.currentLabel, "You'd have");
  assert.equal(investment.methodology.disclaimer, 'For fun—not financial advice.');
});

test('anonymized sample-derived fixtures preserve distinct loyalist and explorer stories', () => {
  const repeatedItems = [{ name: 'House Combo', quantity: 1, price: 12 }];
  const sampleA = Array.from({ length: 40 }, (_, index) => receipt({
    restaurant: index < 31 ? 'Brand Alpha' : 'Brand Beta',
    amount: 20 + index % 3,
    date: new Date(Date.UTC(2024, 0, index + 1, 18)).toISOString(),
    items: index < 31 ? repeatedItems : [{ name: `Other ${index}`, quantity: 1, price: 10 }],
    deliveryMinutes: 30 + index % 4,
  }));
  const sampleB = Array.from({ length: 36 }, (_, index) => receipt({
    restaurant: index < 16 ? 'Brand Gamma' : `Explorer Stop ${index}`,
    amount: 24 + index % 5,
    date: new Date(Date.UTC(2024, 0, index + 1, 18)).toISOString(),
    items: index < 16 ? repeatedItems : [{ name: `Discovery ${index}`, quantity: 1, price: 10 }],
    deliveryMinutes: 35 + index % 6,
  }));
  const catalogueA = buildDashboardInsightCatalogue(sampleA, 'UTC', new Date('2025-02-15T12:00:00.000Z'));
  const catalogueB = buildDashboardInsightCatalogue(sampleB, 'UTC', new Date('2025-02-15T12:00:00.000Z'));
  const exactA = catalogueA.eligible.find(candidate => candidate.insight.id === 'exact-basket-soulmate');
  const exactB = catalogueB.eligible.find(candidate => candidate.insight.id === 'exact-basket-soulmate');
  const personalityA = catalogueA.eligible.find(candidate => candidate.insight.id === 'restaurant-personality').insight;
  const personalityB = catalogueB.eligible.find(candidate => candidate.insight.id === 'restaurant-personality').insight;
  assert.equal(exactA.facts.value, 31);
  assert.equal(exactB.facts.value, 16);
  assert.equal(personalityA.title, 'Comfort orderer');
  assert.equal(personalityB.title, 'Menu explorer');
  assert.equal(personalityA.presentation, 'ranking');
  assert.equal(personalityB.presentation, 'ranking');
  assert.equal(personalityA.rows.length, 3);
  assert.equal(personalityB.rows.length, 3);
  assert.deepEqual(personalityA.rows[0], { label: 'House Combo', context: 'Brand Alpha', count: 31 });
  assert.deepEqual(personalityB.rows[0], { label: 'House Combo', context: 'Brand Gamma', count: 16 });
});

test('foodflation compares one named identical order or item with clear earlier and recent prices', () => {
  const receipts = [
    receipt({ restaurant: 'Burger Lab', amount: 20, date: '2024-01-05T18:00:00.000Z', items: [{ name: 'Classic Burger', quantity: 1, price: 10 }, { name: 'Fries', quantity: 1, price: 4 }] }),
    receipt({ restaurant: 'Burger Lab', amount: 24, date: '2025-01-05T18:00:00.000Z', items: [{ name: 'Classic Burger', quantity: 1, price: 12 }, { name: 'Fries', quantity: 1, price: 4 }] }),
    receipt({ restaurant: 'Burger Lab', amount: 30, date: '2026-01-05T18:00:00.000Z', items: [{ name: 'Classic Burger', quantity: 1, price: 15 }, { name: 'Fries', quantity: 1, price: 4 }] }),
  ];
  const catalogue = buildDashboardInsightCatalogue(receipts, 'UTC', new Date('2026-02-01T12:00:00.000Z'));
  const foodflation = catalogue.eligible.filter(candidate => candidate.family === 'foodflation').map(candidate => candidate.insight);
  const meal = foodflation.find(insight => insight.comparison.subject.kind === 'meal');
  const item = foodflation.find(insight => insight.comparison.subject.kind === 'item');

  assert.ok(meal);
  assert.equal(meal.eyebrow, 'Foodflation');
  assert.equal(meal.title, 'The same order costs 50% more');
  assert.equal(meal.comparison.subject.name, 'Classic Burger + Fries');
  assert.equal(meal.comparison.subject.restaurant, 'Burger Lab');
  assert.equal(meal.comparison.previousLabel, 'Earlier price');
  assert.equal(meal.comparison.currentLabel, 'Recent price');
  assert.deepEqual(meal.period, { startDate: '2024-01-05', endDate: '2026-01-05' });
  assert.deepEqual(meal.methodology, { sampleSize: 3 });
  assert.ok(item);
  assert.equal(item.title, 'The same item costs 50% more');
  assert.equal(item.comparison.subject.name, 'Classic Burger');
  assert.doesNotMatch(JSON.stringify(foodflation), /first match|latest match|repeat basket/i);
});

test('yearly champions preserve every qualifying year, ties, counts, and the current-year label', () => {
  const receipts = [
    ...Array.from({ length: 4 }, (_, index) => receipt({ restaurant: 'Alpha Kitchen', date: `2023-01-${String(index + 1).padStart(2, '0')}T18:00:00.000Z` })),
    ...Array.from({ length: 5 }, (_, index) => receipt({ restaurant: 'Beta Grill', date: `2024-02-${String(index + 1).padStart(2, '0')}T18:00:00.000Z` })),
    ...Array.from({ length: 3 }, (_, index) => receipt({ restaurant: 'Beta Grill', date: `2025-03-${String(index + 1).padStart(2, '0')}T18:00:00.000Z` })),
    ...Array.from({ length: 3 }, (_, index) => receipt({ restaurant: 'Gamma Cafe', date: `2025-04-${String(index + 1).padStart(2, '0')}T18:00:00.000Z` })),
    ...Array.from({ length: 4 }, (_, index) => receipt({ restaurant: 'Gamma Cafe', date: `2026-05-${String(index + 1).padStart(2, '0')}T18:00:00.000Z` })),
  ];
  const catalogue = buildDashboardInsightCatalogue(receipts, 'UTC', new Date('2026-08-13T12:00:00.000Z'));
  const champions = catalogue.eligible.find(candidate => candidate.insight.id === 'restaurant-champions-by-year').insight;

  assert.deepEqual(champions.years, [
    { year: 2023, winners: ['Alpha Kitchen'], orderCount: 4, currentYear: false },
    { year: 2024, winners: ['Beta Grill'], orderCount: 5, currentYear: false },
    { year: 2025, winners: ['Beta Grill', 'Gamma Cafe'], orderCount: 3, currentYear: false },
    { year: 2026, winners: ['Gamma Cafe'], orderCount: 4, currentYear: true },
  ]);
  assert.equal(catalogue.eligible.some(candidate => candidate.insight.id === 'restaurant-crown-changed'), false);
});

test('recent comparisons require fresh coverage and adequate bases', () => {
  const recent = [];
  for (let day = 1; day <= 6; day++) {
    recent.push(receipt({ amount: 20, date: `2026-07-${String(day).padStart(2, '0')}T18:00:00.000Z`, source: DataSource.EMAIL }));
    recent.push(receipt({ amount: 35, date: `2026-08-${String(day).padStart(2, '0')}T18:00:00.000Z`, source: DataSource.EMAIL }));
  }
  const fresh = buildDashboardInsightCatalogue(recent, 'America/Toronto', new Date('2026-08-07T15:00:00.000Z'));
  assert.ok(fresh.eligible.some(candidate => candidate.insight.id === 'month-to-date-spending'));
  assert.ok(fresh.eligible.some(candidate => candidate.insight.id === 'rolling-average-basket'));

  const stale = buildDashboardInsightCatalogue(recent, 'America/Toronto', new Date('2026-10-07T15:00:00.000Z'));
  assert.equal(stale.eligible.some(candidate => candidate.insight.id.includes('spending')), false);
  assert.ok(stale.suppressed.some(candidate => candidate.id === 'recent-movement' && candidate.reason === 'stale_coverage'));
});

test('timing catalogue covers active streaks, multi-order days, and late-night favourites', () => {
  const receipts = [
    receipt({ restaurant: 'Night Place', date: '2026-08-02T03:20:00.000Z', items: [{ name: 'Cookie', quantity: 1, price: 2 }] }),
    receipt({ restaurant: 'Night Place', date: '2026-08-03T03:30:00.000Z', items: [{ name: 'Cookie', quantity: 1, price: 2 }] }),
    receipt({ restaurant: 'Night Place', date: '2026-08-04T03:40:00.000Z', items: [{ name: 'Cookie', quantity: 1, price: 2 }] }),
    receipt({ restaurant: 'Night Place', date: '2026-08-05T03:50:00.000Z', items: [{ name: 'Cookie', quantity: 1, price: 2 }] }),
    receipt({ restaurant: 'Second Place', date: '2026-08-05T02:10:00.000Z' }),
    receipt({ restaurant: 'Third Place', date: '2026-08-05T01:10:00.000Z' }),
  ];
  const catalogue = buildDashboardInsightCatalogue(receipts, 'America/Toronto', new Date('2026-08-05T14:00:00.000Z'));
  const ids = new Set(catalogue.eligible.map(candidate => candidate.insight.id));
  const multiOrderDay = catalogue.eligible.find(candidate => candidate.insight.id === 'multi-order-day').insight;
  const tunnelVision = catalogue.eligible.find(candidate => candidate.insight.id === 'restaurant-tunnel-vision').insight;
  const lateRestaurant = catalogue.eligible.find(candidate => candidate.insight.id === 'favourite-late-night-restaurant').insight;
  const lateItem = catalogue.eligible.find(candidate => candidate.insight.id === 'favourite-late-night-item').insight;
  assert.ok(ids.has('current-order-streak'));
  assert.ok(ids.has('multi-order-day'));
  assert.ok(ids.has('latest-ever-order'));
  assert.ok(ids.has('favourite-late-night-restaurant'));
  assert.ok(ids.has('favourite-late-night-item'));
  assert.deepEqual(multiOrderDay.order.restaurants, ['Third Place', 'Second Place', 'Night Place']);
  assert.equal(multiOrderDay.order.restaurant, 'Third Place');
  assert.deepEqual(multiOrderDay.period, { startDate: '2026-08-04' });
  assert.deepEqual(tunnelVision.period, { startDate: '2026-08-01', endDate: '2026-08-03' });
  assert.deepEqual(lateRestaurant.period, { startDate: '2026-08-01', endDate: '2026-08-04' });
  assert.deepEqual(lateItem.period, { startDate: '2026-08-01', endDate: '2026-08-04' });
});

test('quiet-streak periods exclude the order that began the break', () => {
  const receipts = [
    receipt({ date: '2026-01-01T18:00:00.000Z' }),
    receipt({ date: '2026-01-20T18:00:00.000Z' }),
  ];
  const catalogue = buildDashboardInsightCatalogue(receipts, 'UTC', new Date('2026-01-22T12:00:00.000Z'));
  const detox = catalogue.eligible.find(candidate => candidate.insight.id === 'delivery-detox').insight;
  assert.equal(detox.value, 18);
  assert.deepEqual(detox.period, { startDate: '2026-01-02', endDate: '2026-01-19' });
});

test('latest late-night order treats after-midnight times as later in the same night', () => {
  const catalogue = buildDashboardInsightCatalogue([
    receipt({ restaurant: 'Evening Place', date: '2026-08-01T23:30:00.000Z' }),
    receipt({ restaurant: 'After Midnight', date: '2026-08-02T03:15:00.000Z' }),
    receipt({ restaurant: 'Dinner Place', date: '2026-08-03T20:00:00.000Z' }),
  ], 'UTC', new Date('2026-08-04T12:00:00.000Z'));
  const latest = catalogue.eligible.find(candidate => candidate.insight.id === 'latest-ever-order').insight;
  assert.equal(latest.events[1].value, 'After Midnight');
});

test('investment math compounds each contribution from its own order date', () => {
  const receipts = Array.from({ length: 5 }, (_, index) => receipt({
    amount: 100,
    date: `2025-01-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
  }));
  const catalogue = buildDashboardInsightCatalogue(receipts, 'UTC', new Date('2026-01-03T12:00:00.000Z'));
  const investment = catalogue.eligible.find(candidate => candidate.insight.id === 'hypothetical-investment').insight;
  const contributions = investment.comparison.previous;
  const value = investment.comparison.current;
  assert.equal(contributions, 500);
  assert.ok(value > 534 && value < 536, `expected approximately 535, received ${value}`);
  assert.equal(investment.comparison.delta, Math.round((value - contributions) * 100) / 100);
});

test('ranked candidates expose runner-up insights without calling them the top result', () => {
  const receipts = Array.from({ length: 6 }, (_, index) => receipt({
    amount: 200 - index * 20,
    restaurant: ['LCBO', 'Second Place', 'Third Place', 'Fourth Place', 'Fifth Place', 'Sixth Place'][index],
    date: `2026-0${index + 1}-01T18:00:00.000Z`,
    deliveryMinutes: 80 - index * 5,
    items: [
      { name: 'Burger', quantity: 1, price: 10 },
      ...(index < 5 ? [{ name: 'Fries', quantity: 1, price: 5 }] : []),
      ...(index < 4 ? [{ name: 'Cookie', quantity: 1, price: 3 }] : []),
    ],
  }));
  const catalogue = buildDashboardInsightCatalogue(receipts, 'UTC', new Date('2026-08-13T12:00:00.000Z'));
  const byId = new Map(catalogue.eligible.map(candidate => [candidate.insight.id, candidate]));

  assert.equal(byId.get('biggest-splurge').insight.order.restaurant, 'LCBO');
  assert.equal(byId.get('biggest-splurge-rank-2').insight.order.restaurant, 'Second Place');
  assert.match(byId.get('biggest-splurge-rank-2').insight.title, /second-biggest/i);
  assert.doesNotMatch(byId.get('biggest-splurge-rank-2').insight.title, /^Your biggest/i);
  assert.equal(byId.get('longest-delivery-rank-3').insight.value, 70);
  assert.equal(byId.get('most-ordered-meal-rank-2').subjectGroup, 'repeated-menu-items');
});

test('daily editions show at most one ranked sibling and rotate beyond rank one', () => {
  const rankedCandidates = [1, 2, 3].map(rank => ({
    family: 'ranked-orders', subjectGroup: 'biggest-orders', subjectRank: rank, score: 88 - rank,
    insight: { id: `rank-${rank}`, presentation: 'hero', category: 'extremes', icon: 'receipt', eyebrow: `Rank ${rank}`, title: `Order rank ${rank}`, value: rank, valueFormat: 'number' },
  }));
  const fillers = Array.from({ length: 18 }, (_, index) => ({
    family: `filler-${index}`, score: 70 + index % 12,
    insight: { id: `filler-${index}`, presentation: 'hero', category: ['favorites', 'habits', 'progress'][index % 3], icon: 'sparkles', eyebrow: 'Test', title: `Filler ${index}`, value: index, valueFormat: 'number' },
  }));
  const seenRanks = new Set();
  for (let day = 0; day < 12; day++) {
    const edition = selectDailyInsights([...rankedCandidates, ...fillers], 'rank-user', `2026-08-${String(day + 1).padStart(2, '0')}`, DASHBOARD_INSIGHT_METRIC_VERSION);
    const ranks = edition.filter(insight => insight.id.startsWith('rank-'));
    assert.ok(ranks.length <= 1, `edition contained ${ranks.length} ranked siblings`);
    ranks.forEach(insight => seenRanks.add(insight.id));
  }
  assert.ok(seenRanks.has('rank-2') || seenRanks.has('rank-3'), 'a runner-up should appear across daily editions');
});

test('copy variants are deterministic for a seed and rotate across daily seeds', () => {
  const candidate = {
    family: 'exact-basket', score: 90,
    insight: { id: 'basket', presentation: 'hero', category: 'favorites', icon: 'repeat', eyebrow: 'Test', title: 'Basket', value: 4, valueFormat: 'number', detail: 'Repeated four times.' },
    facts: { value: 4, valueFormat: 'number' },
    copy: { eyebrow: 'Test', title: 'Basket', detail: 'Repeated four times.' },
  };
  const first = applyDailyCopyVariant(candidate, 'user:2026-08-13:daily-v13');
  const repeat = applyDailyCopyVariant(candidate, 'user:2026-08-13:daily-v13');
  assert.deepEqual(first, repeat);
  const details = new Set(Array.from({ length: 10 }, (_, day) => applyDailyCopyVariant(candidate, `user:2026-08-${String(day + 10).padStart(2, '0')}:daily-v13`).detail));
  assert.ok(details.size > 1);
});

test('every item obsession family receives rotating family-specific character', () => {
  assert.ok(Object.keys(ITEM_PERSONALITY_PROFILES).length >= 18, 'registry should cover a broad item catalogue');
  for (const [family, profile] of Object.entries(ITEM_PERSONALITY_PROFILES)) {
    const baseDetail = `Your tracked orders included 96 ${profile.label}.`;
    assert.doesNotMatch(baseDetail, /\b(?:roughly|approximately|estimated)\b|\babout\s+\d/i);
    const candidate = {
      family: `item-${family}`, score: 82,
      insight: { id: `item-obsession-${family}`, presentation: 'hero', category: 'favorites', icon: profile.icon, eyebrow: 'Item obsession', title: `96 ${profile.label}`, value: 96, valueFormat: 'number', detail: baseDetail },
      facts: { value: 96, valueFormat: 'number' },
      copy: { eyebrow: 'Item obsession', title: `96 ${profile.label}`, detail: baseDetail },
      copyVariants: profile.punchlines,
    };
    const details = new Set(Array.from({ length: 14 }, (_, day) => applyDailyCopyVariant(candidate, `user:2026-09-${String(day + 1).padStart(2, '0')}:daily-v13`).detail));
    assert.ok(details.size > 1, `${family} copy should rotate`);
    for (const detail of details) {
      assert.ok(detail.startsWith(baseDetail), `${family} should preserve its factual sentence`);
      assert.notEqual(detail, baseDetail, `${family} should always add a punchline`);
    }
  }
});

test('dipping-sauce rankings use flavour selections and count each sauce once per order', () => {
  const receipts = [
    receipt({ date: '2026-01-01T18:00:00.000Z', items: [{ name: 'Dipping Sauce', quantity: 1, price: 1, customizations: ['Creamy Garlic'] }] }),
    receipt({ date: '2026-01-02T18:00:00.000Z', items: [{ name: 'Dipping Sauce', quantity: 1, price: 1, customizations: ['Creamy Garlic'] }, { name: 'Dipping Sauce', quantity: 1, price: 1, customizations: ['Creamy Garlic'] }] }),
    receipt({ date: '2026-01-03T18:00:00.000Z', items: [{ name: 'Single Pizza + Dipping Sauce', quantity: 1, price: 12, customizations: ['Pepperoni', 'Creamy Garlic', 'Regular Pizza Sauce'] }] }),
    receipt({ date: '2026-01-04T18:00:00.000Z', items: [{ name: 'Tender Combo', quantity: 1, price: 14, customizations: ['Blackened Ranch', 'Bayou Buffalo'] }] }),
    receipt({ date: '2026-01-05T18:00:00.000Z', items: [{ name: 'Tender Combo', quantity: 1, price: 14, customizations: ['Blackened Ranch'] }] }),
    receipt({ date: '2026-01-06T18:00:00.000Z', items: [{ name: '10 Chicken McNuggets', quantity: 1, price: 10, customizations: ['Hot Mustard'] }] }),
    receipt({ date: '2026-01-07T18:00:00.000Z', items: [{ name: 'Spicy Buffalo Chicken Mac & Cheese', quantity: 1, price: 13 }] }),
  ];
  const catalogue = buildDashboardInsightCatalogue(receipts, 'UTC', new Date('2026-02-01T12:00:00.000Z'));
  const sauces = catalogue.eligible.find(candidate => candidate.insight.id === 'top-dipping-sauces').insight;

  assert.deepEqual(sauces.rows, [
    { label: 'Creamy Garlic', count: 3 },
    { label: 'Blackened Ranch', count: 2 },
    { label: 'Bayou Buffalo', count: 1 },
  ]);
  assert.deepEqual(sauces.methodology, { sampleSize: 6 });
  assert.equal(catalogue.eligible.some(candidate => candidate.insight.id === 'item-obsession-sauce'), false);
  assert.doesNotMatch(JSON.stringify(sauces), /pizza sauce|mac & cheese/i);
});

test('item personality copy stays concise and avoids the retired corporate-meme voice', () => {
  const retiredVoice = /\b(?:economy|legacy|agenda|infrastructure|portfolio|documented|receipts)\b|strategic importance|body of evidence|loyalty program/i;
  const banks = [...Object.entries(ITEM_PERSONALITY_PROFILES).map(([family, profile]) => [family, profile.punchlines]), ['generic', GENERIC_ITEM_PUNCHLINES]];
  for (const [family, punchlines] of banks) {
    assert.ok(punchlines.length >= 4, `${family} needs enough copy to rotate`);
    for (const line of punchlines) {
      assert.ok(line.length <= 75, `${family} punchline is too long: ${line}`);
      assert.doesNotMatch(line, retiredVoice, `${family} still uses the retired voice`);
    }
  }
});

test('frequently repeated unknown items receive the generic personality fallback', () => {
  const receipts = Array.from({ length: 7 }, (_, index) => receipt({
    date: `2026-07-${String(index + 1).padStart(2, '0')}T18:00:00.000Z`,
    items: [{ name: 'Mystery Power Bowl', quantity: 1, price: 14 }],
  }));
  const catalogue = buildDashboardInsightCatalogue(receipts, 'UTC', new Date('2026-07-10T12:00:00.000Z'));
  const candidate = catalogue.eligible.find(value => value.insight.id === 'item-obsession-recurring-item');
  assert.ok(candidate);
  assert.equal(candidate.insight.title, 'Mystery Power Bowl');
  assert.equal(candidate.insight.detail, 'It showed up 7 times in your tracked orders.');
  assert.ok(candidate.copyVariants.length >= 3);
});

test('daily selection is deterministic, varied, category-aware, and capped at seven', () => {
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    family: `family-${index}`,
    score: 72 + index,
    insight: {
      id: `insight-${index}`,
      presentation: 'hero',
      category: ['favorites', 'habits', 'extremes', 'progress'][index % 4],
      icon: 'sparkles',
      eyebrow: 'Test',
      title: `Insight ${index}`,
      value: index,
      valueFormat: 'number',
    },
  }));
  candidates.push({
    family: 'locked', score: 20, locked: true,
    insight: { id: 'locked', presentation: 'locked', category: 'favorites', icon: 'lock', eyebrow: 'Locked', title: 'Locked', action: 'open_export' },
  });
  const first = selectDailyInsights(candidates, 'user-id', '2026-08-13', DASHBOARD_INSIGHT_METRIC_VERSION);
  const repeat = selectDailyInsights(candidates, 'user-id', '2026-08-13', DASHBOARD_INSIGHT_METRIC_VERSION);
  const next = selectDailyInsights(candidates, 'user-id', '2026-08-14', DASHBOARD_INSIGHT_METRIC_VERSION);
  assert.deepEqual(first, repeat);
  assert.equal(first.length, 7);
  assert.equal(first.filter(card => card.presentation === 'locked').length, 1, 'Gmail-only editions reserve one locked preview slot');
  assert.equal(first.at(-1).presentation, 'locked');
  assert.ok(new Set(first.map(card => card.category)).size >= 3);
  assert.notDeepEqual(first.map(card => card.id), next.map(card => card.id));
  assert.notEqual(first[0].id, next[0].id);
});

test('Gmail-only locked previews survive large-catalogue cooldown selection', () => {
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    family: `cooldown-family-${index}`,
    score: 70 + index,
    insight: {
      id: `cooldown-insight-${index}`,
      presentation: 'hero',
      category: ['favorites', 'habits', 'extremes', 'progress'][index % 4],
      icon: 'sparkles', eyebrow: 'Test', title: `Insight ${index}`, value: index, valueFormat: 'number',
    },
  }));
  candidates.push({
    family: 'locked', score: 20, locked: true,
    insight: { id: 'locked', presentation: 'locked', category: 'favorites', icon: 'lock', eyebrow: 'Locked', title: 'Locked', action: 'open_export' },
  });

  for (let day = 13; day <= 16; day++) {
    const edition = selectDailyInsights(candidates, 'gmail-only-user', `2026-08-${day}`, DASHBOARD_INSIGHT_METRIC_VERSION);
    assert.equal(edition.length, 7);
    assert.equal(edition.filter(card => card.presentation === 'locked').length, 1);
    assert.equal(edition.at(-1).presentation, 'locked');
  }
});

test('large catalogues enforce a two-day cooldown without shrinking the edition', () => {
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    family: `cooldown-family-${index}`,
    score: 70 + index % 20,
    insight: {
      id: `cooldown-insight-${index}`,
      presentation: 'hero',
      category: ['favorites', 'habits', 'extremes', 'progress'][index % 4],
      icon: 'sparkles',
      eyebrow: 'Test',
      title: `Insight ${index}`,
      value: index,
      valueFormat: 'number',
    },
  }));
  const editions = Array.from({ length: 4 }, (_, day) => selectDailyInsights(
    candidates,
    'cooldown-user',
    `2026-08-${String(day + 13).padStart(2, '0')}`,
    DASHBOARD_INSIGHT_METRIC_VERSION,
  ));

  for (const edition of editions) {
    assert.equal(edition.length, 7);
    assert.ok(new Set(edition.map(card => card.category)).size >= 3);
  }
  for (let current = 1; current < editions.length; current++) {
    const currentIds = new Set(editions[current].map(card => card.id));
    for (let distance = 1; distance <= Math.min(2, current); distance++) {
      assert.equal(editions[current - distance].some(card => currentIds.has(card.id)), false, `day ${current} repeated a card from ${distance} day(s) ago`);
    }
  }
});

test('medium catalogues avoid next-day repeats and small catalogues fall back gracefully', () => {
  const makeCandidates = count => Array.from({ length: count }, (_, index) => ({
    family: `family-${index}`,
    score: 70 + index,
    insight: {
      id: `insight-${index}`,
      presentation: 'hero',
      category: ['favorites', 'habits', 'extremes', 'progress'][index % 4],
      icon: 'sparkles',
      eyebrow: 'Test',
      title: `Insight ${index}`,
      value: index,
      valueFormat: 'number',
    },
  }));
  const medium = makeCandidates(14);
  const mediumToday = selectDailyInsights(medium, 'medium-user', '2026-08-13', DASHBOARD_INSIGHT_METRIC_VERSION);
  const mediumTomorrow = selectDailyInsights(medium, 'medium-user', '2026-08-14', DASHBOARD_INSIGHT_METRIC_VERSION);
  assert.equal(mediumToday.length, 7);
  assert.equal(mediumTomorrow.length, 7);
  assert.equal(mediumToday.some(card => mediumTomorrow.some(next => next.id === card.id)), false);

  const small = makeCandidates(10);
  const smallToday = selectDailyInsights(small, 'small-user', '2026-08-13', DASHBOARD_INSIGHT_METRIC_VERSION);
  const smallTomorrow = selectDailyInsights(small, 'small-user', '2026-08-14', DASHBOARD_INSIGHT_METRIC_VERSION);
  assert.equal(smallToday.length, 7);
  assert.equal(smallTomorrow.length, 7);
  assert.ok(smallToday.some(card => smallTomorrow.some(next => next.id === card.id)), 'a small catalogue must reuse cards instead of returning fewer than seven');
});

test('edition metadata and next local midnight are correct across DST', () => {
  const spring = getNextLocalMidnight(new Date('2026-03-08T12:00:00.000Z'), 'America/Toronto');
  assert.equal(spring.toISOString(), '2026-03-09T04:00:00.000Z');
  const fall = getNextLocalMidnight(new Date('2026-11-01T13:00:00.000Z'), 'America/Toronto');
  assert.equal(fall.toISOString(), '2026-11-02T05:00:00.000Z');

  const edition = buildDashboardInsightEdition([], 'America/Toronto', 'user-id', new Date('2026-08-14T02:00:00.000Z'));
  assert.equal(edition.localDate, '2026-08-13');
  assert.equal(edition.timezone, 'America/Toronto');
  assert.equal(edition.metricVersion, DASHBOARD_INSIGHT_METRIC_VERSION);
  assert.equal(edition.insights.length, 0);
  assert.equal(edition.nextRefreshAt, '2026-08-14T04:00:00.000Z');
});

test('edition exposes partial export coverage only for exactly one supported provider', () => {
  const uber = receipt({ date: '2026-08-01T18:00:00.000Z' });
  const doorDash = new Receipt(
    'user-id', [], 25, ReceiptType.DOORDASH, 'DoorDash Kitchen',
    new Date('2026-08-02T18:00:00.000Z'), DataSource.CSV,
  );
  const gmail = receipt({ date: '2026-08-03T18:00:00.000Z', source: DataSource.EMAIL });
  const now = new Date('2026-08-13T15:00:00.000Z');

  assert.equal(buildDashboardInsightEdition([uber], 'UTC', 'user-id', now).partialExportProvider, 'uber_eats');
  assert.equal(buildDashboardInsightEdition([doorDash], 'UTC', 'user-id', now).partialExportProvider, 'doordash');
  assert.equal(buildDashboardInsightEdition([uber, doorDash], 'UTC', 'user-id', now).partialExportProvider, undefined);
  assert.equal(buildDashboardInsightEdition([gmail], 'UTC', 'user-id', now).partialExportProvider, undefined);
});

test('development day previews advance by local calendar date across DST', () => {
  const spring = getDashboardInsightPreviewNow(new Date('2026-03-07T17:30:00.000Z'), 'America/Toronto', 1);
  assert.equal(spring.toISOString(), '2026-03-08T16:30:00.000Z');
  const fall = getDashboardInsightPreviewNow(new Date('2026-10-31T16:30:00.000Z'), 'America/Toronto', 1);
  assert.equal(fall.toISOString(), '2026-11-01T17:30:00.000Z');
  assert.throws(() => getDashboardInsightPreviewNow(new Date(), 'UTC', 366), /dayOffset/);
});

test('dashboard edition cache is namespaced, honors midnight TTL, and participates in user invalidation', async () => {
  const calls = [];
  const originals = { set: redisConfig.set, get: redisConfig.get, delPattern: redisConfig.delPattern, isAvailable: redisConfig.isAvailable };
  redisConfig.set = async (...args) => { calls.push(['set', ...args]); return true; };
  redisConfig.get = async () => null;
  redisConfig.delPattern = async pattern => { calls.push(['delPattern', pattern]); return 0; };
  redisConfig.isAvailable = () => false;
  try {
    const cache = new CacheService();
    const edition = buildDashboardInsightEdition([], 'America/Toronto', 'user-id', new Date('2026-08-13T15:00:00.000Z'));
    await cache.cacheDashboardInsightEdition('user-id:daily-v13:America/Toronto:2026-08-13', edition, 46_860);
    assert.equal(calls[0][1], 'dashboard_insights:user-id:daily-v13:America/Toronto:2026-08-13');
    assert.equal(calls[0][3], 46_860);
    await cache.invalidateAllUserCaches('user-id');
    assert.ok(calls.some(call => call[0] === 'delPattern' && call[1] === 'dashboard_insights:user-id*'));
  } finally {
    Object.assign(redisConfig, originals);
  }
});

test('users router declares the protected dedicated dashboard-insight contract', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'src/routes/users.ts'), 'utf8');
  assert.match(source, /router\.get\('\/:id\/dashboard-insights',\s*authenticateToken,\s*validateOwnership,\s*validateUUIDParam\('id'\)/);
  assert.match(source, /buildDashboardInsightEdition\(receipts, timezone, userId, now\)/);
  assert.match(source, /process\.env\.NODE_ENV === 'production'/);
  assert.match(source, /const cached = isDevPreview \? null : await cacheService\.getDashboardInsightEdition/);
  assert.match(source, /if \(!isDevPreview\) \{[\s\S]*cacheDashboardInsightEdition\(cacheKey, edition, ttlSeconds\)/);
});
