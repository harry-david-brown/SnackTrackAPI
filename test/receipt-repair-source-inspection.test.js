const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ReceiptRepairSourceStore } = require('../dist/services/data/ReceiptRepairSourceStore');
const {
  receiptDocumentKey,
  evidenceFingerprint,
} = require('../dist/services/receipt/ReceiptEvidenceFingerprint');
const { decemberSourceObservations } = require('./helpers/order-events-fixture');
const { decodeReceiptObservation } = require('../dist/services/data/receiptObservationCodec');

async function sourceFixture() {
  const receipt = decodeReceiptObservation(
    (await decemberSourceObservations()).find((o) => o.receipt.dataSource === 'csv').receipt,
  );
  const account = receipt.userId;
  const batchId = randomUUID();
  const provenance = {
    sourceKind: 'provider_export',
    provider: 'uber_eats',
    sourceLabel: 'Retained December export',
    acquiredAt: '2026-09-01T00:00:00.000Z',
    successfulCompletion: true,
    rejectedRecords: 0,
  };
  const key = receiptDocumentKey(receipt);
  const row = {
    id: batchId,
    provenance,
    parser_version: 3,
    import_generation: 0,
    fingerprint: evidenceFingerprint({ provenance, documents: [[key, receipt]] }),
    expired: true,
  };
  const observation = { id: randomUUID(), document_key: key, payload: receipt };
  const tx = {
    query: async (sql, args) => {
      assert.match(sql.trim(), /^SELECT\b/);
      assert.doesNotMatch(sql, /FOR UPDATE|FOR SHARE/);
      assert.deepEqual(args, [account, batchId]);
      return { rows: sql.includes('FROM receipt_repair_source_batches') ? [row] : [observation] };
    },
  };
  return { tx, account, batchId, row, observation };
}

test('expired sources remain inspectable without weakening publication expiry', async () => {
  const f = await sourceFixture();
  const store = new ReceiptRepairSourceStore();
  const inspected = await store.inspect(f.tx, f.account, 0, [f.batchId]);
  assert.deepEqual(inspected.expiredBatchIds, [f.batchId]);
  assert.equal(inspected.batches[0].observations.length, 1);
  assert.equal(inspected.batches[0].provenance.sourceLabel, 'Retained December export');
  await assert.rejects(
    store.load(f.tx, f.account, 0, [f.batchId]),
    (e) => e.code === 'REPAIR_SOURCE_EXPIRED',
  );
  f.row.expired = false;
  const loaded = await store.load(f.tx, f.account, 0, [f.batchId]);
  assert.equal(
    loaded.fingerprint,
    inspected.fingerprint,
    'expiry is not part of immutable source content',
  );
  assert.deepEqual(loaded.expiredBatchIds, []);
});

test('inspection still verifies expired source integrity, generation, and parser version', async () => {
  const f = await sourceFixture();
  const store = new ReceiptRepairSourceStore();
  const inspect = () => store.inspect(f.tx, f.account, 0, [f.batchId]);
  f.row.fingerprint = 'altered';
  await assert.rejects(inspect, (e) => e.code === 'REPAIR_SOURCE_CHANGED');
  f.row.import_generation = 1;
  await assert.rejects(inspect, (e) => e.code === 'REPAIR_SOURCE_STALE');
  f.row.import_generation = 0;
  f.row.parser_version = 2;
  await assert.rejects(inspect, (e) => e.code === 'REPAIR_SOURCE_STALE');
  f.row.parser_version = 3;
  const missing = {
    query: async (sql, args) =>
      sql.includes('FROM receipt_repair_source_batches') ? f.tx.query(sql, args) : { rows: [] },
  };
  await assert.rejects(
    store.inspect(missing, f.account, 0, [f.batchId]),
    (e) => e.code === 'REPAIR_SOURCE_CHANGED',
  );
});
