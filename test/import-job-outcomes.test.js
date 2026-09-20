const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-at-least-thirty-two-characters';
const { ImportJobProcessor } = require('../dist/services/import/ImportJobProcessor');
const { ImportLockService } = require('../dist/services/import/ImportLockService');
const { OngoingTrackingService } = require('../dist/services/import/OngoingTrackingService');
const {
  ReceiptImportPersistenceService,
} = require('../dist/services/import/ReceiptImportPersistenceService');
const { GmailImportService } = require('../dist/services/import/GmailImportService');
const { OutlookImportService } = require('../dist/services/import/OutlookImportService');
const { CsvImportUseCase } = require('../dist/services/import/CsvImportUseCase');
const { emptyMailboxCounters } = require('../dist/services/import/MailboxImportCheckpoint');
const {
  startReceiptImportOutcome,
  resolveReceiptImportOutcome,
} = require('../dist/services/import/ReceiptImportOutcome');

const outcome = {
  policyVersion: 3,
  newOrders: 1,
  updatedOrders: 0,
  unchangedOrders: 0,
  unresolvedOrders: 0,
  unlinkedAdjustments: 0,
  adjustedOrders: 1,
  cancellationsRecovered: 0,
  ordersProcessed: 1,
  sourceDocuments: 3,
  currencies: [
    {
      currencyCode: 'CAD',
      netAmount: 20,
      pricedOrders: 1,
      unpricedOrders: 0,
      possibleAdditionalAmount: 0,
      unpricedPossibleOrders: 0,
    },
  ],
};
const tentative = {
  success: true,
  newOrders: 2,
  updatedOrders: 7,
  unchangedOrders: 0,
  totalReceiptsImported: 9,
  totalAmount: 400,
};

for (const invalid of [false, true]) {
  test(`review repair checkpoint ${invalid ? 'rejects malformed drafts without retrying' : 'forwards the saved draft under the account writer lock'}`, async (t) => {
    const userId = randomUUID(),
      lock = { userId };
    t.mock.method(ImportLockService, 'acquireLockWithWait', async () => lock);
    t.mock.method(ImportLockService, 'assertLockOwned', async () => {});
    let released = false,
      forwarded,
      result,
      failure;
    t.mock.method(ImportLockService, 'releaseLock', async () => {
      released = true;
    });
    const review = {
      id: randomUUID(),
      decision: 'merge',
      observationIds: [randomUUID(), randomUUID()].sort(),
      reviewer: 'fixture',
      reason: 'Verified evidence',
    };
    const operation = {
      id: randomUUID(),
      userId,
      kind: 'receipt_rebuild',
      importGeneration: 4,
      trigger: 'scheduler',
      status: 'queued',
      checkpoint: { reviewChanges: invalid ? null : [review] },
    };
    const processor = new ImportJobProcessor(
      {
        findById: async () => operation,
        claimForRun: async () => operation,
        progress: async () => {},
        heartbeat: async () => {},
        succeed: async (_op, value) => {
          result = value;
        },
        fail: async (_op, code) => {
          failure = code;
        },
        retry: async () =>
          assert.fail('Invalid review instructions require a new draft, not a worker retry'),
      },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {
        executeWithLock: async (...args) => {
          forwarded = args;
          return { orders: 5, mode: 'prepare', manifestId: randomUUID() };
        },
      },
      { getImportOutcome: async () => assert.fail('Repair is not a newly imported source job') },
      3,
    );
    await processor.process({
      data: { jobId: operation.id },
      opts: { attempts: 3 },
      attemptsMade: 0,
    });
    if (invalid) {
      assert.equal(failure, 'RECEIPT_REVIEW_INVALID');
      assert.equal(forwarded, undefined);
    } else {
      assert.deepEqual(forwarded, [userId, 4, 'prepare', lock, undefined, undefined, [review]]);
      assert.equal(result.orders, 5);
    }
    assert.equal(released, true);
  });
}

for (const kind of [
  'gmail_historical',
  'outlook_historical',
  'manual_tracking',
  'scheduled_tracking',
  'gmail_push_tracking',
  'export_file',
]) {
  test(`${kind} publishes final canonical counts and forwards one durable accounting identity`, async (t) => {
    const lock = { userId: 'user' };
    t.mock.method(ImportLockService, 'acquireLockWithWait', async () => lock);
    t.mock.method(ImportLockService, 'assertLockOwned', async (received) =>
      assert.equal(received, lock),
    );
    let released = false;
    t.mock.method(ImportLockService, 'releaseLock', async () => {
      released = true;
    });
    const operation = {
      id: 'job',
      userId: 'user',
      kind,
      trigger: 'user',
      status: 'queued',
      checkpoint: {},
      objectKey: 'test',
      exportProvider: 'uber_eats',
      objectEtag: 'etag',
      submittedContentLength: 1,
      originalFilename: 'test.csv',
    };
    let result, accountingJobId;
    const jobs = {
      findById: async () => operation,
      claimForRun: async () => operation,
      progress: async () => {},
      heartbeat: async () => {},
      saveCheckpoint: async () => {},
      succeed: async (_operation, completed) => {
        result = completed;
      },
      fail: async (_operation, code) => assert.fail(`Unexpected worker failure: ${code}`),
    };
    const invoke = async (_user, _lock, execution) => {
      accountingJobId = execution.accountingJobId;
      return tentative;
    };
    const processor = new ImportJobProcessor(
      jobs,
      {
        downloadToTemporaryFile: async () => ({ path: '/test.csv', remove: async () => {} }),
        delete: async () => {},
      },
      { isZipFile: async () => false },
      {
        executeWithLock: async (command) => {
          accountingJobId = command.accountingJobId;
          return tentative;
        },
      },
      { executeWithLock: invoke },
      { executeWithLock: invoke },
      { executeWithLock: invoke },
      { checkOutlookUserWithLock: invoke },
      { delayGmailImportIfEnabled: async () => null },
      { executeWithLock: invoke },
      undefined,
      {
        getImportOutcome: async (userId, jobId, guard) => {
          assert.equal(userId, 'user');
          assert.equal(jobId, 'job');
          await guard();
          return outcome;
        },
      },
      3,
    );
    await processor.process({ data: { jobId: 'job' }, opts: { attempts: 1 }, attemptsMade: 0 });
    assert.equal(accountingJobId, 'job');
    assert.equal(result.newOrders, 1);
    assert.equal(result.updatedOrders, 0);
    assert.equal(result.totalReceiptsImported, 1);
    assert.equal(result.importedCount, 1);
    assert.equal(result.totalAmount, 20);
    assert.equal(result.currencyCode, 'CAD');
    assert.deepEqual(result.receiptOutcome, outcome);
    assert.equal(released, true);
  });
}

test('provider-scoped tracking checkpoints keep the shared accounting identity', async () => {
  const identities = [];
  const empty = {
    ...tentative,
    totalEmailsFound: 0,
    totalReceiptsProcessed: 0,
    emailsExamined: 0,
    supportedReceiptsFound: 0,
    exportCoveredReceipts: 0,
    eligibleReceipts: 0,
    deduplicatedReceipts: 0,
    errors: [],
    receipts: [],
    errorCode: null,
  };
  const track = async (_user, _lock, _trigger, execution) => {
    identities.push(execution.accountingJobId);
    await execution.save({ provider: 'test' }, 'done', 90);
    return empty;
  };
  const service = new OngoingTrackingService(
    {
      findByIdWithGmailTokens: async () => ({
        id: 'user',
        gmailConnected: true,
        gmailConnectionMode: 'offline',
        gmailRefreshToken: 'test-token',
      }),
    },
    {
      get: async () => ({ ongoingTrackingConsentState: 'granted' }),
      getTrackingBaseline: async () => ({ eligible: true }),
    },
    {},
    { importFromGmail: track },
    { assertLockOwned: async () => {} },
    { findMicrosoft: async () => ({ state: 'connected', connectionMode: 'offline' }) },
    { importFromOutlook: track },
    { getImportOutcome: async () => outcome },
  );
  const saved = [];
  const result = await service.checkUserWithLock(
    'user',
    { userId: 'user' },
    { accountingJobId: 'job', checkpoint: {}, save: async (state) => saved.push(state) },
  );
  assert.equal(result.newOrders, 1, 'overall tracking must not add provider outcomes');
  assert.deepEqual(identities, ['job', 'job']);
  assert.ok(saved.at(-1).gmail);
  assert.ok(saved.at(-1).microsoft);
});

test('the shared mailbox persistence boundary forwards accounting inside the guarded transaction', async () => {
  const calls = [];
  const lock = { userId: 'user' };
  const persistence = new ReceiptImportPersistenceService(
    {
      upsertEmailReceipts: async (_receipts, guard, id) => {
        await guard();
        calls.push(id);
        return { newOrders: 1, updatedOrders: 0, unchangedOrders: 0 };
      },
    },
    { invalidateAllUserCaches: async (userId) => calls.push(`cache:${userId}`) },
    {
      assertLockOwned: async (received) => {
        assert.equal(received, lock);
        calls.push('guard');
      },
    },
    { getImportOutcome: async () => outcome },
  );
  await persistence.persist('user', [{}], lock, { jobId: 'job', scope: 'gmail' });
  assert.deepEqual(calls, ['guard', { jobId: 'job', scope: 'gmail' }, 'cache:user']);
});

for (const provider of ['gmail', 'microsoft'])
  test(`${provider} sync history and result use the phase's final canonical outcome`, async () => {
    const accounting = { jobId: 'job', scope: provider };
    let completedCounts;
    const acquire = async () => ({
      exportCutoffs: {},
      pages: (async function* () {
        yield { messages: [], matchedCount: 1, nextCursor: 'second' };
        yield { messages: [], matchedCount: 1, nextCursor: null };
      })(),
    });
    const extraction = {
      extract: async () => ({ supportedReceipts: [], extractedReceipts: [], errors: [] }),
    };
    const persistence = {
      persist: async (_user, _receipts, _lock, context) => {
        assert.deepEqual(context, accounting);
        return tentative;
      },
      getOutcome: async (_user, _lock, context) => {
        assert.deepEqual(context, accounting);
        return outcome;
      },
    };
    const complete = async (_id, _user, _status, counts) => {
      completedCounts = counts;
    };
    const fail = async () => assert.fail('Unexpected import failure');
    const gmail = new GmailImportService({ acquire }, extraction, persistence, {
      start: async () => 'run',
      complete,
      fail,
    });
    const outlook = new OutlookImportService(
      { acquire },
      extraction,
      persistence,
      { startSyncRun: async () => 'run', completeSyncRun: complete, failSyncRun: fail },
      {},
      {},
    );
    const result = await (
      provider === 'gmail'
        ? gmail.importFromGmail.bind(gmail)
        : outlook.importFromOutlook.bind(outlook)
    )({ id: 'user', timezone: 'UTC' }, {}, 'manual', {
      accountingJobId: 'job',
      checkpoint: {},
      save: async () => {},
    });
    assert.equal(result.newOrders, 1);
    assert.equal(result.updatedOrders, 0);
    assert.equal(result.totalAmount, 20);
    assert.equal(completedCounts.newOrders, 1);
    assert.equal(completedCounts.updatedOrders, 0);
    assert.deepEqual(completedCounts.receiptOutcome, outcome);
  });

test('export completion metadata and result prefer canonical outcomes to raw export counts and totals', async () => {
  let metadata;
  const expected = { ...outcome, cancellationsRecovered: 1 };
  const service = new CsvImportUseCase(
    {
      validateCsvFormat: () => ({ valid: true }),
      detectCsvFormat: () => 'uber',
      parseCsvFile: async () => ({
        receipts: [{}],
        totalReceipts: 5,
        totalAmount: 999,
        errors: [],
      }),
    },
    {
      replaceProviderExport: async (_user, _receipts, guard, _batch, context) => {
        await guard();
        assert.deepEqual(context, { jobId: 'job', scope: 'export' });
        return tentative;
      },
    },
    { findById: async () => ({ timezone: 'UTC' }) },
    {
      setExportStatus: async (_user, _provider, status, _error, _ready, value) => {
        if (status === 'completed') metadata = value;
        return true;
      },
    },
    { invalidateAllUserCaches: async () => {} },
    { assertLockOwned: async () => {} },
    {
      getImportOutcome: async (_user, _job, guard, scope) => {
        await guard();
        assert.equal(scope, 'export');
        return expected;
      },
    },
  );
  const result = await service.executeWithLock(
    {
      userId: 'user',
      provider: 'uber_eats',
      csvBuffer: Buffer.from('test'),
      fileType: 'csv',
      accountingJobId: 'job',
    },
    {},
  );
  assert.equal(result.importedCount, 1);
  assert.equal(result.totalAmount, 20);
  assert.equal(metadata.importedCount, 1);
  assert.equal(metadata.totalAmount, 20);
  assert.equal(metadata.cancellationsRecovered, 1);
  assert.deepEqual(result.receiptOutcome, expected);
});

for (const provider of ['gmail', 'microsoft'])
  test(`${provider} refuses a completed accounted cursor whose ledger evidence is missing`, async () => {
    let failure;
    const persist = {
      getOutcome: async () => resolveReceiptImportOutcome(startReceiptImportOutcome([]), []),
    };
    const complete = async () => assert.fail('Missing accounting must not report success');
    const fail = async (_run, _user, code) => {
      failure = code;
    };
    const gmail = new GmailImportService({}, {}, persist, {
      start: async () => 'run',
      complete,
      fail,
    });
    const outlook = new OutlookImportService(
      {},
      {},
      persist,
      { startSyncRun: async () => 'run', completeSyncRun: complete, failSyncRun: fail },
      {},
      {},
    );
    const result = await (
      provider === 'gmail'
        ? gmail.importFromGmail.bind(gmail)
        : outlook.importFromOutlook.bind(outlook)
    )({ id: 'user' }, {}, 'manual', {
      accountingJobId: 'job',
      save: async () => {},
      checkpoint: {
        provider,
        version: 1,
        receiptPolicyVersion: 3,
        accountingJobId: 'job',
        cursor: null,
        done: true,
        counters: {
          ...emptyMailboxCounters(),
          deduplicatedReceipts: 1,
          totalReceiptsImported: 1,
          newOrders: 1,
        },
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'IMPORT_CHECKPOINT_INVALID');
    assert.equal(failure, 'IMPORT_CHECKPOINT_INVALID');
  });
