const test = require('node:test');
const assert = require('node:assert/strict');
const { ImportLifecycleRepository } = require('../dist/services/data/ImportLifecycleRepository');
const { OngoingTrackingService } = require('../dist/services/import/OngoingTrackingService');
const { ImportJobProcessor } = require('../dist/services/import/ImportJobProcessor');

test('offer acknowledgment is account scoped, idempotent, and does not grant consent', async () => {
  const statements = [];
  const repo = new ImportLifecycleRepository({ query: async (sql, params) => { statements.push({ sql, params }); return { rows: [] }; } });
  await repo.markAutomaticUpdatesOfferSeen('user-1');
  await repo.markAutomaticUpdatesOfferSeen('user-1');
  const writes = statements.filter(item => item.sql.includes('UPDATE'));
  assert.equal(writes.length, 2);
  for (const write of writes) {
    assert.match(write.sql, /COALESCE\(automatic_updates_offer_seen_at, NOW\(\)\)/);
    assert.match(write.sql, /WHERE user_id = \$1/);
    assert.doesNotMatch(write.sql, /consent_state\s*=/);
    assert.deepEqual(write.params, ['user-1']);
  }
});
const result = (success, errorCode = null) => ({ success, errorCode, totalEmailsFound: 1, totalReceiptsProcessed: 1,
  emailsExamined: 1, supportedReceiptsFound: 1, exportCoveredReceipts: 0, eligibleReceipts: 1,
  deduplicatedReceipts: 0, totalReceiptsImported: success ? 1 : 0, totalAmount: 0, errors: [], receipts: [],
  newOrders: success ? 1 : 0, updatedOrders: 0, unchangedOrders: 0 });

test('mixed mailbox checks preserve successful work and identify the failed inbox', async () => {
  const reconnect = [];
  const service = new OngoingTrackingService(
    { findByIdWithGmailTokens: async () => ({ id: 'user-1', gmailConnected: true, gmailConnectionMode: 'offline', gmailRefreshToken: 'stored', gmailEmail: 'gmail@example.com' }) },
    { get: async () => ({ ongoingTrackingConsentState: 'granted' }), getTrackingBaseline: async () => ({ eligible: true, source: 'gmail' }) },
    { markTrackingReconnectRequired: async id => reconnect.push(id), markTrackingError: async () => assert.fail('wrong recovery') },
    { importFromGmail: async () => result(true) },
    { assertLockOwned: async () => {} },
    { findMicrosoft: async () => ({ state: 'connected', connectionMode: 'offline', email: 'outlook@example.com' }) },
    { importFromOutlook: async () => result(false, 'OUTLOOK_RECONNECT_REQUIRED') },
  );
  const combined = await service.checkUserWithLock('user-1', {});
  assert.equal(combined.success, false);
  assert.equal(combined.newOrders, 1);
  assert.deepEqual(combined.mailboxOutcomes.map(({ mailbox, success }) => ({ mailbox, success })), [
    { mailbox: 'gmail', success: true }, { mailbox: 'outlook', success: false },
  ]);
  assert.equal(combined.mailboxOutcomes[1].email, 'outlook@example.com');
  assert.deepEqual(reconnect, ['user-1']);
  // Retrying/failing still carries the partial result; it is not relabeled a successful operation.
  const processor = Object.create(ImportJobProcessor.prototype);
  assert.throws(() => processor.requireTrackingSuccess(combined), error => {
    assert.equal(error.code, 'OUTLOOK_RECONNECT_REQUIRED');
    assert.equal(error.details.partialResult.newOrders, 1);
    assert.equal(error.details.partialResult.mailboxOutcomes.length, 2);
    assert.equal(error.details.partialResult.receipts, undefined);
    return true;
  });
});
