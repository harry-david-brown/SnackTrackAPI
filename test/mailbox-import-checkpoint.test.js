const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-thirty-two-characters';

const { GmailImportService } = require('../dist/services/import/GmailImportService');
const {
  checkpointProgress,
  restoreMailboxCheckpoint,
  saveMailboxCheckpoint,
  emptyMailboxCounters,
} = require('../dist/services/import/MailboxImportCheckpoint');
const {
  startReceiptImportOutcome,
  resolveReceiptImportOutcome,
} = require('../dist/services/import/ReceiptImportOutcome');

const emptyExtraction = {
  extractedReceipts: [],
  supportedReceipts: [],
  errors: [],
  nonReceiptCount: 0,
  nonFoodCount: 0,
  durationMs: 1,
};

test('mailbox progress follows the discovered message workload', () => {
  assert.equal(checkpointProgress(1, 20, 400), 19);
  assert.equal(checkpointProgress(10, 200, 400), 52);
  assert.equal(checkpointProgress(19, 380, 400), 85);
  assert.equal(checkpointProgress(20, 400, 400), 89);
});

test('accounted imports reject old progress even when the old parser found zero receipts', () => {
  for (const provider of ['gmail', 'microsoft']) {
    for (const done of [true, false]) {
      const checkpoint = {
        provider,
        version: 1,
        cursor: done ? null : 'page-2',
        done,
        counters: emptyMailboxCounters(),
      };
      assert.throws(
        () =>
          restoreMailboxCheckpoint(
            { accountingJobId: 'new-job', checkpoint, save: async () => {} },
            provider,
          ),
        (e) => e.code === 'IMPORT_CHECKPOINT_INVALID',
      );
    }
  }
});

test('accounted checkpoints bind policy and job identity; retries retain cumulative progress', async () => {
  for (const provider of ['gmail', 'microsoft']) {
    let checkpoint;
    const execution = {
      accountingJobId: 'job-one',
      checkpoint: {},
      save: async (value) => {
        checkpoint = value;
      },
    };
    const state = {
      ...restoreMailboxCheckpoint(execution, provider),
      cursor: 'page-2',
      counters: { ...emptyMailboxCounters(), pages: 1, matchedMessages: 4 },
    };
    await saveMailboxCheckpoint(execution, state, 8);
    assert.equal(checkpoint.receiptPolicyVersion, 3);
    assert.equal(checkpoint.accountingJobId, 'job-one');
    const restored = restoreMailboxCheckpoint({ ...execution, checkpoint }, provider);
    assert.equal(restored.counters.matchedMessages, 4);
    assert.equal(restored.cursor, 'page-2');
    for (const altered of [
      { ...execution, accountingJobId: 'job-two', checkpoint },
      { ...execution, accountingJobId: undefined, checkpoint },
      { ...execution, checkpoint: { ...checkpoint, receiptPolicyVersion: 2 } },
    ])
      assert.throws(
        () => restoreMailboxCheckpoint(altered, provider),
        (e) => e.code === 'IMPORT_CHECKPOINT_INVALID',
      );
  }
});

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
            yield {
              messages: [{ userId: 'user-1' }],
              matchedCount: 1,
              estimatedTotalCount: 2,
              nextCursor: null,
            };
            return;
          }
          yield {
            messages: [{ userId: 'user-1' }],
            matchedCount: 1,
            estimatedTotalCount: 2,
            nextCursor: 'page-2',
          };
          if (firstAttempt) {
            firstAttempt = false;
            throw new Error('temporary provider failure');
          }
        })(),
      };
    },
  };
  const lifecycle = {
    start: async () => 'sync-1',
    complete: async () => undefined,
    fail: async () => undefined,
    markReconnectRequired: async () => undefined,
  };
  const execution = () => ({
    accountingJobId: 'durable-job',
    checkpoint: persistedCheckpoint,
    save: async (checkpoint) => {
      persistedCheckpoint = checkpoint;
    },
  });
  const service = new GmailImportService(
    acquisition,
    { extract: async () => emptyExtraction },
    {
      persist: async (_user, _receipts, _lock, accountingJobId) => {
        assert.deepEqual(accountingJobId, { jobId: 'durable-job', scope: 'gmail' });
        return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0, totalReceiptsImported: 0 };
      },
      getOutcome: async () => resolveReceiptImportOutcome(startReceiptImportOutcome([]), []),
    },
    lifecycle,
  );
  const user = { id: 'user-1', gmailRefreshToken: 'refresh-token', timezone: 'UTC' };
  const lock = { userId: 'user-1', token: 'lock' };

  const failed = await service.importFromGmail(user, lock, 'manual', execution());
  assert.equal(failed.success, false);
  assert.equal(persistedCheckpoint.cursor, 'page-2');
  assert.equal(persistedCheckpoint.estimatedTotalMessages, 2);

  const resumed = await service.importFromGmail(user, lock, 'manual', execution());
  assert.equal(resumed.success, true);
  assert.equal(resumed.emailsExamined, 2);
  assert.equal(persistedCheckpoint.done, true);
  assert.deepEqual(seenCursors, [null, 'page-2']);
});
