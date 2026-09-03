const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-thirty-two-characters';

const { GmailImportService } = require('../dist/services/import/GmailImportService');

const emptyExtraction = {
  extractedReceipts: [], supportedReceipts: [], errors: [],
  nonReceiptCount: 0, nonFoodCount: 0, durationMs: 1,
};

test('Gmail import resumes at the first uncommitted provider page', async () => {
  let persistedCheckpoint = {};
  const seenCursors = [];
  let firstAttempt = true;
  const acquisition = {
    acquire: async (_user, _trigger, cursor) => {
      seenCursors.push(cursor ?? null);
      return {
        exportCutoffs: {},
        pages: (async function* () {
          if (cursor === 'page-2') {
            yield { messages: [{ userId: 'user-1' }], matchedCount: 1, nextCursor: null };
            return;
          }
          yield { messages: [{ userId: 'user-1' }], matchedCount: 1, nextCursor: 'page-2' };
          if (firstAttempt) {
            firstAttempt = false;
            throw new Error('temporary provider failure');
          }
        })(),
      };
    },
  };
  const lifecycle = {
    start: async () => 'sync-1', complete: async () => undefined,
    fail: async () => undefined, markReconnectRequired: async () => undefined,
  };
  const execution = () => ({
    checkpoint: persistedCheckpoint,
    save: async (checkpoint) => { persistedCheckpoint = checkpoint; },
  });
  const service = new GmailImportService(
    acquisition,
    { extract: async () => emptyExtraction },
    { persist: async () => ({ newOrders: 0, updatedOrders: 0, unchangedOrders: 0, totalReceiptsImported: 0 }) },
    lifecycle,
  );
  const user = { id: 'user-1', gmailRefreshToken: 'refresh-token', timezone: 'UTC' };
  const lock = { userId: 'user-1', token: 'lock' };

  const failed = await service.importFromGmail(user, lock, 'manual', execution());
  assert.equal(failed.success, false);
  assert.equal(persistedCheckpoint.cursor, 'page-2');

  const resumed = await service.importFromGmail(user, lock, 'manual', execution());
  assert.equal(resumed.success, true);
  assert.equal(resumed.emailsExamined, 2);
  assert.equal(persistedCheckpoint.done, true);
  assert.deepEqual(seenCursors, [null, 'page-2']);
});
