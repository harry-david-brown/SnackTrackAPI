const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { parseReceiptRepairSourceOptions } = require('../dist/scripts/receiptRepairSourceOptions');
const {
  ReceiptRepairSourceAcquisition,
} = require('../dist/services/receipt/ReceiptRepairSourceAcquisition');
const { RetainedExportReader } = require('../dist/services/import/RetainedExportReader');
const {
  ReceiptRepairAccountRepository,
} = require('../dist/services/data/ReceiptRepairAccountRepository');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { ZipExtractor } = require('../dist/services/import/ZipExtractor');
const {
  CSV_EXPORT_LIMIT_BYTES,
  ZIP_EXPORT_LIMIT_BYTES,
} = require('../dist/services/import/ExportFileLimits');
const fixture = require('./fixtures/receipt-accuracy/doordash-source');
const december = require('./fixtures/receipt-accuracy/december-10-2023');
const storedZip = require('./helpers/retainedExportZip');
const userId = randomUUID();
const acquiredAt = '2026-09-13T12:00:00.000Z';
const command = { sourceKind:'provider_export', userId, provider: 'doordash', path: '/private/retained.csv', acquiredAt };

async function setup() {
  const parsed = await new CsvImportService().parseDoorDashCsv(
    Buffer.from(fixture.csv()),
    userId,
    'America/Toronto',
    3,
  );
  const acquired = {
    artifact: { sha256: 'a'.repeat(64), sizeBytes: 123 },
    receipts: parsed.receipts,
    rejectedRecords: 0,
    successfulCompletion: true,
  };
  const calls = [];
  const lock = { userId, backend: 'redis', ownerToken: 'test-lock' };
  let context = { generation: 2, timezone: 'America/Toronto' };
  const sources = {
    stageRepairSources: async (id, generation, receipts, provenance, guard) => {
      calls.push('stage');
      await guard();
      assert.equal(id, userId);
      assert.equal(generation, 2);
      assert.deepEqual(receipts, acquired.receipts);
      assert.deepEqual(provenance.artifact, acquired.artifact);
      assert.equal(provenance.parsingTimezone, 'America/Toronto');
      assert.equal(provenance.declaredCoverage, undefined);
      return {
        batchId: randomUUID(),
        observations: receipts.length,
        fingerprint: 'saved-fingerprint',
      };
    },
  };
  const locks = {
    acquireLock: async () => {
      calls.push('lock');
      return lock;
    },
    assertLockOwned: async (value) => {
      calls.push('guard');
      assert.equal(value, lock);
    },
    releaseLock: async (value) => {
      calls.push('release');
      assert.equal(value, lock);
      return true;
    },
  };
  const service = new ReceiptRepairSourceAcquisition(
    {
      getContext: async () => {
        calls.push('account');
        return context;
      },
    },
    {
      read: async () => {
        calls.push('read');
        return acquired;
      },
    },
    sources,
    locks,
  );
  return {
    service,
    acquired,
    calls,
    locks,
    lock,
    sources,
    setContext: (value) => {
      context = value;
    },
  };
}

test('retained export CLI defaults to preview and staging requires the exact preview context', () => {
  const args = [userId, 'doordash', '/retained.csv'];
  assert.deepEqual(parseReceiptRepairSourceOptions(args, 'provider_export', new Date(acquiredAt)), {
    ...command,
    path: '/retained.csv',
  });
  const stage = [
    ...args,
    '--stage',
    '--acquired-at',
    acquiredAt,
    '--expected-generation',
    '2',
    '--expected-fingerprint',
    'a'.repeat(64),
  ];
  assert.deepEqual(parseReceiptRepairSourceOptions(stage, 'provider_export').stage, {
    expectedGeneration: 2,
    expectedFingerprint: 'a'.repeat(64),
  });
  for (const invalid of [
    [...args, '--stage'],
    [...args, '--unknown'],
    [...args, '--stage', '--stage'],
    [...args, '--expected-generation', '2'],
    [...args, '--acquired-at', '2026-02-30T12:00:00.000Z'],
    [...stage, '--expected-generation', '3'],
    [...args, '--stage', '--expected-generation', '-1'],
    [userId, 'unknown', '/retained.csv'],
    ['wrong-account', 'doordash', '/retained.csv'],
  ])
    assert.throws(() => parseReceiptRepairSourceOptions(invalid, 'provider_export'));
});

test('account acquisition context decodes PostgreSQL bigint generations without exposing identity fields', async () => {
  let row = { import_generation: '2', timezone: 'America/Toronto' };
  const accounts = new ReceiptRepairAccountRepository({
    query: async (sql, params) => {
      assert.equal(sql, 'SELECT import_generation,timezone FROM users WHERE id=$1');
      assert.deepEqual(params, [userId]);
      return { rows: row ? [row] : [] };
    },
  });
  assert.deepEqual(await accounts.getContext(userId), {
    generation: 2,
    timezone: 'America/Toronto',
  });
  for (const invalid of [
    { import_generation: 'not a count', timezone: 'America/Toronto' },
    { import_generation: '9007199254740992', timezone: 'America/Toronto' },
    { import_generation: '2', timezone: 'invalid-zone' },
  ]) {
    row = invalid;
    await assert.rejects(accounts.getContext(userId));
  }
  row = null;
  assert.equal(await accounts.getContext(userId), null);
});

test('preview performs no writes or locks and reports unknown DoorDash charge separately from subtotal', async () => {
  const f = await setup();
  const report = await f.service.execute(command);
  assert.deepEqual(f.calls, ['account', 'read']);
  assert.equal(report.mode, 'preview');
  assert.equal(report.sourceDocuments, 1);
  assert.equal(report.orderMetrics.attempts, 1);
  assert.equal(report.orderMetrics.currencies[0].netSpend, 0);
  assert.equal(report.orderMetrics.currencies[0].unknownPriceOrders, 1);
  assert.equal(report.observedCoverage.quality, 'observed');
  assert.equal(JSON.stringify(report).includes(command.path), false);
  assert.equal((await f.service.execute(command)).fingerprint, report.fingerprint);
});

test('reviewed staging retains provenance under the shared lock and releases it', async () => {
  const f = await setup();
  const preview = await f.service.execute(command);
  f.calls.length = 0;
  const result = await f.service.execute({
    ...command,
    stage: { expectedGeneration: preview.generation, expectedFingerprint: preview.fingerprint },
  });
  assert.equal(result.mode, 'staged');
  assert.equal(result.staged.observations, 1);
  assert.deepEqual(f.calls, ['account', 'read', 'lock', 'stage', 'guard', 'release']);
});

test('changed bytes, parsed facts, account timezone and generation reject stale acquisition previews', async () => {
  for (const mutate of [
    (f) => {
      f.acquired.artifact.sha256 = 'b'.repeat(64);
    },
    (f) => {
      f.acquired.receipts[0].items[0].price += 1;
    },
    (f) => {
      f.setContext({ generation: 2, timezone: 'America/Chicago' });
    },
    (f) => {
      f.setContext({ generation: 3, timezone: 'America/Toronto' });
    },
  ]) {
    const f = await setup();
    const preview = await f.service.execute(command);
    mutate(f);
    f.calls.length = 0;
    await assert.rejects(
      f.service.execute({
        ...command,
        stage: { expectedGeneration: 2, expectedFingerprint: preview.fingerprint },
      }),
      (e) => ['REPAIR_PREVIEW_CHANGED', 'REPAIR_GENERATION_STALE'].includes(e.code),
    );
    assert.equal(f.calls.includes('lock'), false);
    assert.equal(f.calls.includes('stage'), false);
  }
});

test('missing accounts cannot read files and empty exports cannot be staged', async () => {
  const f = await setup();
  f.setContext(null);
  await assert.rejects(f.service.execute(command), (e) => e.code === 'NOT_FOUND');
  assert.deepEqual(f.calls, ['account']);
  f.setContext({ generation: 2, timezone: 'America/Toronto' });
  f.acquired.receipts = [];
  const preview = await f.service.execute(command);
  assert.equal(preview.observedCoverage, null);
  await assert.rejects(
    f.service.execute({
      ...command,
      stage: { expectedGeneration: 2, expectedFingerprint: preview.fingerprint },
    }),
    (e) => e.code === 'NO_VALID_EXPORT_ORDERS',
  );
  assert.equal(f.calls.includes('lock'), false);
});

test('staging rejects local/wrong-account locks and releases leases after guard/storage failure', async () => {
  for (const failure of ['memory', 'account', 'guard', 'storage', 'busy']) {
    const f = await setup();
    const preview = await f.service.execute(command);
    if (failure === 'memory') f.lock.backend = 'memory';
    if (failure === 'account') f.lock.userId = randomUUID();
    if (failure === 'guard')
      f.locks.assertLockOwned = async () => {
        throw Error('lock lost');
      };
    if (failure === 'storage')
      f.sources.stageRepairSources = async () => {
        throw Error('generation changed at commit');
      };
    if (failure === 'busy') f.locks.acquireLock = async () => null;
    f.calls.length = 0;
    await assert.rejects(
      f.service.execute({
        ...command,
        stage: { expectedGeneration: 2, expectedFingerprint: preview.fingerprint },
      }),
    );
    assert.equal(f.calls.includes('release'), failure !== 'busy');
    if (['memory', 'account', 'busy'].includes(failure))
      assert.equal(f.calls.includes('stage'), false);
  }
});

test('retained CSV reader hashes and parses the same private snapshot and cleans it up', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'repair-reader-test-'));
  const path = join(directory, 'retained.csv');
  const content = Buffer.from(fixture.csv());
  let snapshot;
  const csv = new CsvImportService();
  try {
    await fs.writeFile(path, content);
    const reader = new RetainedExportReader(
      {
        validateCsvPathForProvider: async (selected, provider) => {
          snapshot = selected;
          assert.notEqual(selected, path);
          assert.equal((await fs.stat(selected)).mode & 0o777, 0o600);
          assert.equal((await fs.stat(dirname(selected))).mode & 0o777, 0o700);
          return csv.validateCsvPathForProvider(selected, provider);
        },
        parseCsvPathForProvider: csv.parseCsvPathForProvider.bind(csv),
      },
      new ZipExtractor(),
    );
    const result = await reader.read({sourceKind: 'provider_export',
      path,
      userId,
      provider: 'doordash',
      timezone: 'America/Toronto',
    });
    assert.deepEqual(result.artifact, {
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
    });
    assert.equal(result.receipts[0].resolution.orderEvidence.parserVersion, 3);
    assert.equal(result.successfulCompletion, true);
    assert.deepEqual(await fs.readFile(path), content);
    await assert.rejects(fs.access(snapshot), (e) => e.code === 'ENOENT');
    await assert.rejects(
      reader.read({sourceKind: 'provider_export', path, userId, provider: 'uber_eats', timezone: 'America/Toronto' }),
      (e) => e.code === 'INVALID_CSV_FORMAT',
    );
    await assert.rejects(fs.access(snapshot), (e) => e.code === 'ENOENT');
    const link = join(directory, 'link.csv');
    await fs.symlink(path, link);
    await assert.rejects(
      reader.read({sourceKind: 'provider_export', path: link, userId, provider: 'doordash', timezone: 'America/Toronto' }),
    );
    await assert.rejects(
      reader.read({sourceKind: 'provider_export', path: directory, userId, provider: 'doordash', timezone: 'America/Toronto' }),
      (e) => e.code === 'INVALID_RETAINED_EXPORT',
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Uber ZIP shards retain every order even when a shard has no final newline', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'repair-shards-test-'));
  const path = join(directory, 'retained.zip');
  const lines = december.csv.split('\n').filter(Boolean);
  const entries = [
    ['export/Eats/user_orders-1.csv', [lines[0], ...lines.slice(4)].join('\n')],
    ['export/Eats/user_orders-0.csv', lines.slice(0, 4).join('\n')],
  ];
  try {
    const archive = storedZip(entries);
    await fs.writeFile(path, archive);
    const reader = new RetainedExportReader(new CsvImportService(), new ZipExtractor());
    const result = await reader.read({sourceKind: 'provider_export',
      path,
      userId,
      provider: 'uber_eats',
      timezone: 'America/Toronto',
    });
    assert.equal(result.successfulCompletion, true);
    assert.equal(result.rejectedRecords, 0);
    assert.equal(result.receipts.length, 5);
    assert.equal(
      result.receipts.filter((r) => r.resolution.orderEvidence.fulfillment === 'canceled').length,
      1,
    );
    assert.equal(result.artifact.sha256, createHash('sha256').update(archive).digest('hex'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('corrupt, ambiguous and unsafe ZIPs fail without leaving source snapshots', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'repair-zip-test-'));
  const path = join(directory, 'retained.zip');
  const zip = new ZipExtractor();
  let snapshot;
  const reader = new RetainedExportReader(new CsvImportService(), {
    isZipFile: async (selected) => {
      snapshot = selected;
      return zip.isZipFile(selected);
    },
    extractProviderCSVToFile: zip.extractProviderCSVToFile.bind(zip),
  });
  try {
    const corrupt = storedZip([['consumer_order_details.csv', fixture.csv()]]);
    corrupt[30 + Buffer.byteLength('consumer_order_details.csv') + 20] ^= 1;
    for (const contents of [
      corrupt,
      storedZip([
        ['a/consumer_order_details.csv', fixture.csv()],
        ['b/consumer_order_details.csv', fixture.csv()],
      ]),
      storedZip([['../consumer_order_details.csv', fixture.csv()]]),
    ]) {
      await fs.writeFile(path, contents);
      await assert.rejects(
        reader.read({sourceKind: 'provider_export', path, userId, provider: 'doordash', timezone: 'America/Toronto' }),
      );
      await assert.rejects(fs.access(snapshot), (e) => e.code === 'ENOENT');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('empty and unsupported-status exports report actual rejected source counts', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'repair-empty-test-'));
  const path = join(directory, 'retained.csv');
  try {
    const reader = new RetainedExportReader(new CsvImportService(), new ZipExtractor());
    await fs.writeFile(path, december.csv.split('\n')[0] + '\n');
    const empty = await reader.read({sourceKind: 'provider_export',
      path,
      userId,
      provider: 'uber_eats',
      timezone: 'America/Toronto',
    });
    assert.equal(empty.receipts.length, 0);
    assert.equal(empty.rejectedRecords, 0);
    assert.equal(empty.successfulCompletion, false);
    await fs.writeFile(
      path,
      december.csv.replaceAll('completed', 'unsupported').replaceAll('canceled', 'unsupported'),
    );
    const unknown = await reader.read({sourceKind: 'provider_export',
      path,
      userId,
      provider: 'uber_eats',
      timezone: 'America/Toronto',
    });
    assert.equal(unknown.receipts.length, 0);
    assert.equal(unknown.rejectedRecords, 5);
    assert.equal(unknown.successfulCompletion, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retained file acquisition enforces the same CSV/archive limits as ordinary uploads', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'repair-limits-test-'));
  const path = join(directory, 'retained.csv');
  try {
    const reader = new RetainedExportReader(new CsvImportService(), new ZipExtractor());
    for (const [size, code] of [
      [0, 'INVALID_RETAINED_EXPORT'],
      [ZIP_EXPORT_LIMIT_BYTES + 1, 'INVALID_RETAINED_EXPORT'],
      [CSV_EXPORT_LIMIT_BYTES + 1, 'PAYLOAD_TOO_LARGE'],
    ]) {
      await fs.writeFile(path, '');
      await fs.truncate(path, size);
      await assert.rejects(
        reader.read({sourceKind: 'provider_export', path, userId, provider: 'doordash', timezone: 'America/Toronto' }),
        (e) => e.code === code,
      );
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
