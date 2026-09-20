const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { GmailImportService } = require('../dist/services/import/GmailImportService');
const { OutlookImportService } = require('../dist/services/import/OutlookImportService');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { CsvImportUseCase } = require('../dist/services/import/CsvImportUseCase');
const {
  ReceiptImportPersistenceService,
} = require('../dist/services/import/ReceiptImportPersistenceService');
const { receiptImportAccounting } = require('../dist/services/import/ReceiptImportExecution');
const { emptyMailboxCounters } = require('../dist/services/import/MailboxImportCheckpoint');
const {
  resolveReceiptImportOutcome,
  startReceiptImportOutcome,
} = require('../dist/services/import/ReceiptImportOutcome');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const unused = new Proxy(
  {},
  { get: (_target, property) => () => assert.fail(`Unexpected side effect: ${String(property)}`) },
);

for (const provider of ['gmail', 'microsoft'])
  test(`${provider}: policy 3 requires durable context before acquisition or lifecycle writes`, async () => {
    const service =
      provider === 'gmail'
        ? new GmailImportService(unused, unused, unused, unused, undefined, 3)
        : new OutlookImportService(unused, unused, unused, unused, unused, unused, undefined, 3);
    const run =
      provider === 'gmail'
        ? service.importFromGmail.bind(service)
        : service.importFromOutlook.bind(service);
    for (const trigger of ['manual', 'background']) {
      await assert.rejects(
        run({ id: 'user' }, {}, trigger),
        (e) => e.code === 'IMPORT_DURABLE_CONTEXT_REQUIRED',
      );
      await assert.rejects(
        run({ id: 'user' }, {}, trigger, {
          accountingJobId: 'job',
          save: unused.save,
          checkpoint: {
            provider,
            version: 1,
            cursor: null,
            done: true,
            counters: emptyMailboxCounters(),
          },
        }),
        (e) => e.code === 'IMPORT_CHECKPOINT_INVALID',
      );
    }
  });

test('persistence refuses accounting bypass, including empty pages, before writes or cache invalidation', async () => {
  const persistence = new ReceiptImportPersistenceService(unused, unused, unused, unused, 3);
  for (const receipts of [[], [{}]])
    await assert.rejects(
      persistence.persist('user', receipts, {}),
      (e) => e.code === 'IMPORT_DURABLE_CONTEXT_REQUIRED',
    );
  assert.equal(receiptImportAccounting(2, undefined, 'gmail'), undefined);
  assert.deepEqual(receiptImportAccounting(3, 'job', 'microsoft'), {
    jobId: 'job',
    scope: 'microsoft',
  });
  assert.throws(
    () => receiptImportAccounting(3, '', 'export'),
    (e) => e.code === 'IMPORT_CHECKPOINT_INVALID',
  );
});

test('policy-3 direct/staged exports require one accounting identity before parsing or lifecycle writes', async () => {
  const service = new CsvImportUseCase(unused, unused, unused, unused, unused, unused, unused, 3);
  const command = {
    userId: 'user',
    provider: 'uber_eats',
    fileType: 'csv',
    csvBuffer: Buffer.from(fixture.csv),
  };
  await assert.rejects(
    service.executeWithLock(command, {}),
    (e) => e.code === 'IMPORT_DURABLE_CONTEXT_REQUIRED',
  );
  await assert.rejects(
    service.executeWithLock({ ...command, jobId: 'one', accountingJobId: 'two' }, {}),
    (e) => e.code === 'IMPORT_CHECKPOINT_INVALID',
  );
});

test('unsupported direct policy-3 execution releases its acquired lock without touching receipts', async () => {
  const events = [];
  const service = new CsvImportUseCase(
    unused,
    unused,
    unused,
    unused,
    unused,
    {
      acquireLock: async () => {
        events.push('acquire');
        return { userId: 'user' };
      },
      releaseLock: async () => {
        events.push('release');
      },
    },
    unused,
    3,
  );
  await assert.rejects(
    service.execute({
      userId: 'user',
      provider: 'uber_eats',
      fileType: 'csv',
      csvBuffer: Buffer.from(fixture.csv),
    }),
    (e) => e.code === 'IMPORT_DURABLE_CONTEXT_REQUIRED',
  );
  assert.deepEqual(events, ['acquire', 'release']);
});

for (const streamed of [false, true])
  test(`real December export parser follows the use case policy (streamed: ${streamed})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'receipt-policy-test-'));
    try {
      const path = join(directory, 'orders.csv');
      await writeFile(path, fixture.csv);
      let staged, persisted;
      const capture = async (_user, receipts, guard, _batch, accounting) => {
        await guard();
        assert.deepEqual(accounting, { jobId: 'job', scope: 'export' });
        persisted = receipts;
        return { newOrders: 5, updatedOrders: 0, unchangedOrders: 0 };
      };
      const service = new CsvImportUseCase(
        new CsvImportService(),
        {
          replaceProviderExport: capture,
          stageProviderExport: async (_job, receipts) => {
            staged = receipts;
          },
          replaceStagedProviderExport: async (_job, user, guard, batch, accounting) =>
            capture(user, staged, guard, batch, accounting),
        },
        { findById: async () => ({ timezone: 'America/Toronto' }) },
        { setExportStatus: async () => true },
        { invalidateAllUserCaches: async () => {} },
        { assertLockOwned: async () => {} },
        {
          getImportOutcome: async () => ({
            ...resolveReceiptImportOutcome(startReceiptImportOutcome([]), []),
            sourceDocuments: 5,
          }),
        },
        3,
      );
      await service.executeWithLock(
        {
          userId: 'user',
          provider: 'uber_eats',
          fileType: 'csv',
          accountingJobId: 'job',
          ...(streamed ? { jobId: 'job', csvPath: path } : { csvBuffer: Buffer.from(fixture.csv) }),
        },
        { userId: 'user' },
      );
      assert.equal(
        persisted.length,
        5,
        'the full import path must retain the canceled pizza attempt',
      );
      assert.ok(persisted.every((receipt) => receipt.resolution.orderEvidence.parserVersion === 3));
      assert.equal(
        persisted.filter((receipt) => receipt.resolution.orderEvidence.fulfillment === 'canceled')
          .length,
        1,
      );
      assert.equal(
        persisted.find((receipt) => receipt.resolution.orderEvidence.fulfillment === 'canceled')
          .amountSpent,
        43.26,
      );
      assert.equal(
        persisted.find((receipt) => receipt.amountSpent === 0).resolution.orderEvidence.totalState,
        'known',
      );
      assert.equal(
        (await new CsvImportService().parseCsvPath(path, 'user', 'America/Toronto', 3)).receipts
          .length,
        5,
      );
      assert.equal(
        (
          await new CsvImportService().parseCsvFile(
            Buffer.from(fixture.csv),
            'user',
            'America/Toronto',
            2,
          )
        ).receipts.length,
        4,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
