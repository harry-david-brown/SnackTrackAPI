const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { decemberSourceObservations } = require('./helpers/order-events-fixture');
const {
  prepareReceiptReviews,
  activeReceiptReviews,
  receiptReviewTips,
  compensateReceiptReviews,
  decodeReceiptReviewChanges,
} = require('../dist/services/receipt/ReceiptReviewDecisions');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const { mapReceiptResponse } = require('../dist/http/mappers/receiptResponse');
const { receiptRebuildOptions } = require('../dist/scripts/receiptRebuildOptions');
const timezone = 'America/Toronto';
const createdAt = '2026-09-13T12:00:00.000Z';
const change = (decision, ids, overrides = {}) => ({
  id: randomUUID(),
  decision,
  observationIds: ids,
  reviewer: 'fixture-reviewer',
  reason: 'Verified screenshot and retained export evidence',
  ...overrides,
});
async function scenario() {
  const userId = randomUUID();
  const named = new Map(
    (await decemberSourceObservations()).map((source) => {
      const name = source.id;
      source.id = randomUUID();
      source.receipt.userId = userId;
      return [name, source];
    }),
  );
  const sources = [...named.values()];
  const context = { userId, importGeneration: 0, createdAt };
  const prepare = (changes, history = []) =>
    prepareReceiptReviews(history, changes, sources, context);
  return { named, sources, context, prepare };
}
const reconcile = (sources, reviews = []) =>
  reconcileReceiptGroups(sources, timezone, [], 3, reviews);
const membership = (groups) =>
  groups
    .map((group) => group.observations.map((source) => source.id).sort())
    .sort((a, b) => a[0].localeCompare(b[0]));

test('reviewed December match retains refund, Uber Cash, export items and five-attempt totals across permutations', async () => {
  const { named, sources, prepare } = await scenario();
  const command = change('merge', [named.get('export-0').id, named.get('pizza-original').id]);
  const history = prepare([command]);
  const baseline = reconcile(sources, history);
  for (let i = 0; i < sources.length; i++)
    assert.deepEqual(
      reconcile([...sources.slice(i), ...sources.slice(0, i)].reverse(), history),
      baseline,
    );
  const orders = baseline.map((group) => projectReconciledGroup(group, randomUUID()));
  const metrics = summarizeOrderMetrics(orders);
  assert.equal(metrics.attempts, 5);
  assert.equal(metrics.deliveries, 4);
  assert.equal(metrics.currencies[0].netSpend, 157.02);
  const pizza = orders.find((order) =>
    order.resolution.reconciliation.reviewIds?.includes(command.id),
  );
  assert.equal(pizza.resolution.reconciliation.method, 'reviewed');
  assert.equal(pizza.resolution.reconciliation.observationIds.length, 3);
  assert.equal(pizza.resolution.orderOutcome.confirmedRefundAmount, 22.48);
  assert.equal(
    pizza.resolution.orderOutcome.events.find((event) => event.kind === 'refund').tender,
    'provider_wallet',
  );
  assert.equal(pizza.items[0].name, 'Medium');
  assert.equal(
    JSON.stringify(mapReceiptResponse(pizza)).includes(command.id),
    false,
    'private review metadata never enters public DTO',
  );
});

test('reviewing an email family still allows export enrichment; a new revision follows its reviewed original', async () => {
  const { named, sources, prepare } = await scenario();
  const original = named.get('pizza-original'),
    refund = named.get('pizza-refund');
  const history = prepare([change('merge', [original.id, refund.id])]);
  const beforeExport = reconcile([original, refund], history);
  assert.equal(beforeExport.length, 1);
  assert.deepEqual(membership(reconcile(sources, history)), membership(reconcile(sources)));
  const extra = structuredClone(refund);
  extra.id = randomUUID();
  extra.receipt.resolution.sourceMessageId = `gmail:${extra.id}`;
  extra.receipt.resolution.orderEvidence.revisionOf = refund.id;
  const group = reconcile([...sources, extra], history).find((group) =>
    group.observations.some((source) => source.id === original.id),
  );
  assert.equal(group.observations.length, 4);
  assert.equal(projectReconciledGroup(group, randomUUID()).resolution.orderOutcome.netAmount, 0);
});

test('keep-separate survives family inference, export fallback and repeated reconciliation; revocation restores inference', async () => {
  const { named, sources, prepare } = await scenario();
  const pair = [named.get('export-0').id, named.get('pizza-original').id];
  const command = change('keep_separate', pair);
  const history = prepare([command]);
  for (const input of [sources, [...sources].reverse()]) {
    const groups = reconcile(input, history);
    assert.equal(
      groups.some((group) =>
        pair.every((id) => group.observations.some((source) => source.id === id)),
      ),
      false,
    );
    assert.equal(groups.length, 6);
  }
  const revoked = prepare(
    [
      {
        id: randomUUID(),
        decision: 'revoke',
        supersedesId: command.id,
        reason: 'New supporting evidence',
        reviewer: 'fixture-reviewer',
      },
    ],
    history,
  );
  assert.equal(activeReceiptReviews(revoked).length, 0);
  assert.deepEqual(membership(reconcile(sources, revoked)), membership(reconcile(sources)));
  const familyPair = [named.get('pizza-original').id, named.get('pizza-refund').id];
  const familyHistory = prepare([change('keep_separate', familyPair)]);
  assert.equal(
    reconcile(sources, familyHistory).some((group) =>
      familyPair.every((id) => group.observations.some((source) => source.id === id)),
    ),
    false,
  );
});

test('conflicting reviewed IDs, currencies, or merge/separate commands stay unresolved and preserve every source', async () => {
  for (const kind of ['identity', 'currency', 'decision']) {
    const { named, sources, prepare } = await scenario();
    const x = named.get('export-0'),
      e = named.get('pizza-original');
    if (kind === 'identity') {
      x.receipt.externalId = 'order-a';
      e.receipt.externalId = 'order-b';
    }
    if (kind === 'currency') e.receipt.monetaryDetails.currencyCode = 'USD';
    const merge = change('merge', [x.id, e.id]);
    const history = prepare([
      merge,
      ...(kind === 'decision' ? [change('keep_separate', [x.id, e.id])] : []),
    ]);
    const groups = reconcile(sources, history);
    assert.equal(
      groups.some((group) =>
        [x.id, e.id].every((id) => group.observations.some((source) => source.id === id)),
      ),
      false,
    );
    assert.equal(groups.flatMap((group) => group.observations).length, sources.length);
    assert(
      groups.some(
        (group) => group.reason === 'review_conflict' && group.invalidReviewIds.includes(merge.id),
      ),
    );
  }
});

test('later conflicting interpretation does not silently override a review or force a purchase', async () => {
  const { named, sources, prepare } = await scenario();
  const x = named.get('export-0'),
    e = named.get('pizza-original');
  x.receipt.externalId = 'export-order';
  const command = change('merge', [x.id, e.id]);
  const history = prepare([command]);
  const later = structuredClone(e);
  later.id = randomUUID();
  later.receipt.externalId = 'different-order';
  const groups = reconcile([...sources, later], history);
  assert(groups.some((group) => group.invalidReviewIds?.includes(command.id)));
  assert.equal(
    groups.some((group) =>
      [x.id, e.id].every((id) => group.observations.some((source) => source.id === id)),
    ),
    false,
  );
});

test('review command IDs are idempotent, evidence-bound, account-scoped and strictly decoded', async () => {
  const { named, sources, context, prepare } = await scenario();
  const command = change('merge', [named.get('export-0').id, named.get('pizza-original').id]);
  const history = prepare([command]);
  assert.deepEqual(prepare([command], history), history);
  assert.throws(() => prepare([{ ...command, reason: 'Changed intent' }], history), {
    code: 'RECEIPT_REVIEW_IDEMPOTENCY_CONFLICT',
  });
  assert.throws(() => prepare([change('merge', [randomUUID(), command.observationIds[0]])]), {
    code: 'RECEIPT_REVIEW_SOURCE_UNAVAILABLE',
  });
  assert.throws(
    () => prepareReceiptReviews(history, [], sources, { ...context, importGeneration: 1 }),
    { code: 'RECEIPT_REVIEW_INVALID' },
  );
  assert.throws(
    () => prepareReceiptReviews([], [command], sources, { ...context, userId: randomUUID() }),
    { code: 'RECEIPT_REVIEW_SOURCE_UNAVAILABLE' },
  );
  assert.throws(() => decodeReceiptReviewChanges([{ ...command, force: true }]), {
    code: 'RECEIPT_REVIEW_INVALID',
  });
  assert.throws(
    () =>
      decodeReceiptReviewChanges([
        { ...command, observationIds: [command.observationIds[0], command.observationIds[0]] },
      ]),
    { code: 'RECEIPT_REVIEW_INVALID' },
  );
  const legacy = history.map(({ evidence, ...review }) => review);
  assert.equal(activeReceiptReviews(legacy).length, 0, 'pre-workflow audit rows are inert');
  const changedSources = structuredClone(sources);
  changedSources.find((source) => source.id === command.observationIds[0]).receipt.amountSpent++;
  assert(
    reconcile(changedSources, history).some((group) =>
      group.invalidReviewIds?.includes(command.id),
    ),
  );
});

test('rollback appends compensating reviews without deleting history or reviving a superseded ancestor', async () => {
  const { named, sources, context, prepare } = await scenario();
  const ids = [named.get('export-0').id, named.get('pizza-original').id];
  const original = prepare([change('keep_separate', ids)]);
  const merged = prepare([change('merge', ids, { supersedesId: original[0].id })], original);
  const restored = compensateReceiptReviews(original, merged, sources, {
    ...context,
    manifestId: randomUUID(),
    createId: randomUUID,
  });
  assert.equal(restored.length, 3);
  assert.equal(activeReceiptReviews(restored)[0].decision, 'keep_separate');
  assert.deepEqual(
    restored.filter((review) => merged.some((prior) => prior.id === review.id)),
    merged,
  );
  assert.deepEqual(
    membership(reconcile(sources, restored)),
    membership(reconcile(sources, original)),
  );
  const revoked = compensateReceiptReviews([], original, sources, {
    ...context,
    manifestId: randomUUID(),
    createId: randomUUID,
  });
  assert.equal(receiptReviewTips(revoked)[0].decision, 'revoke');
  assert.equal(activeReceiptReviews(revoked).length, 0);
  assert.throws(() => prepare([change('merge', ids, { supersedesId: original[0].id })], restored), {
    code: 'RECEIPT_REVIEW_SUPERSEDED',
  });
});

test('repair CLI accepts review drafts only during prepare and rejects ambiguous targets', () => {
  const user = randomUUID(),
    batch = randomUUID(),
    manifest = randomUUID();
  assert.equal(
    receiptRebuildOptions(['prepare', user, '--reviews', '/private/tmp/review.json']).reviewFile,
    '/private/tmp/review.json',
  );
  assert.deepEqual(receiptRebuildOptions(['prepare', user, 'job', batch]).stagedBatchIds, [batch]);
  assert.equal(receiptRebuildOptions(['publish', user, 'job', manifest]).manifestId, manifest);
  for (const args of [
    ['publish', user],
    ['prepare', '-'.repeat(36)],
    ['prepare', user, 'job', `${batch},${batch}`],
    ['publish', user, 'job', manifest, '--reviews', 'draft.json'],
    ['prepare', user, '--reviews'],
    ['prepare', user, '--reviews', 'a', '--reviews', 'b'],
    ['prepare', user, '--force'],
  ])
    assert.throws(() => receiptRebuildOptions(args));
});

test('keep-separate cannot override shared order identity or an explicit revision reference', async () => {
  for (const identity of ['order_id', 'revision_reference', 'document_copy']) {
    const { named, sources, prepare } = await scenario();
    const a = named.get('pizza-original'),
      b = named.get('pizza-refund');
    if (identity === 'order_id') a.receipt.externalId = b.receipt.externalId = 'shared-order';
    if (identity === 'revision_reference') b.receipt.resolution.orderEvidence.revisionOf = a.id;
    if (identity === 'document_copy')
      b.receipt.resolution.sourceMessageId = a.receipt.resolution.sourceMessageId;
    const command = change('keep_separate', [a.id, b.id]);
    assert(
      reconcile(sources, prepare([command])).some((group) =>
        group.invalidReviewIds?.includes(command.id),
      ),
    );
  }
});

test('a reviewed pair does not force the remaining equal-price same-restaurant pair', async () => {
  const { named, context } = await scenario();
  const x = structuredClone(named.get('export-2')),
    e = structuredClone(named.get('pizza-small'));
  assert(x && e);
  const x2 = structuredClone(x),
    e2 = structuredClone(e);
  x2.id = randomUUID();
  e2.id = randomUUID();
  x2.receipt.orderDate = new Date(x.receipt.orderDate.getTime() + 15 * 60000);
  x2.receipt.resolution.rows = [];
  e2.receipt.resolution.sourceMessageId = `gmail:${e2.id}`;
  const sources = [x, x2, e, e2];
  const command = change('merge', [x.id, e.id]);
  const history = prepareReceiptReviews([], [command], sources, context);
  const result = reconcile(sources, history);
  assert.equal(result.length, 3);
  assert.equal(result.filter((group) => group.method === 'reviewed').length, 1);
  assert.equal(
    result.find((group) => group.observations.some((source) => source.id === e2.id)).reason,
    'ambiguous',
  );
});

test('a new revision cannot smuggle conflicting identity or currency into the export half of a reviewed order', async () => {
  for (const conflict of ['identity', 'currency']) {
    const { named, sources, prepare } = await scenario();
    const original = named.get('pizza-original'),
      exported = named.get('export-0'),
      refund = named.get('pizza-refund');
    exported.receipt.externalId = 'reviewed-purchase';
    if (conflict === 'identity') refund.receipt.externalId = 'different-purchase';
    else {
      original.receipt.monetaryDetails.currencyCode = 'UNKNOWN';
      refund.receipt.monetaryDetails.currencyCode = 'USD';
    }
    refund.receipt.resolution.orderEvidence.revisionOf = original.id;
    const command = change('merge', [exported.id, original.id]);
    const result = reconcile(sources, prepare([command]));
    const reviewed = result.find((group) => group.reviewIds?.includes(command.id));
    assert.deepEqual(
      new Set(reviewed.observations.map((source) => source.id)),
      new Set([exported.id, original.id]),
    );
    assert(result.some((group) => group.observations.some((source) => source.id === refund.id)));
    assert.equal(result.flatMap((group) => group.observations).length, sources.length);
  }
});
