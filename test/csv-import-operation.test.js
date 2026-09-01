const test = require('node:test');
const assert = require('node:assert/strict');

const { CsvImportUseCase } = require('../dist/services/import/CsvImportUseCase');

const createLocks = (events) => ({
  acquireLock: async () => ({ userId: 'user-id', ownerToken: 'owner' }),
  assertLockOwned: async () => events.push('assert-lock'),
  releaseLock: async () => events.push('release-lock'),
});

test('CSV import operation owns lifecycle, write, cache, and lock ordering', async () => {
  const events = [];
  const receipt = { id: 'receipt-id' };
  const csv = {
    validateCsvFormat: () => ({ valid: true, errors: [] }),
    detectCsvFormat: () => 'uber',
    parseCsvFile: async () => ({
      success: true,
      receipts: [receipt],
      totalReceipts: 1,
      totalAmount: 12.5,
      errors: [],
    }),
  };
  const receipts = {
    replaceProviderExport: async (_userId, _receipts, assertOwned) => {
      await assertOwned();
      events.push('write');
    },
  };
  const preferences = {
    setExportStatus: async (_userId, _provider, status) => {
      events.push(`status:${status}`);
      return true;
    },
  };
  const cache = { invalidateAllUserCaches: async () => events.push('cache') };

  const users = { findById: async () => ({ timezone: 'America/Toronto' }) };
  const result = await new CsvImportUseCase(
    csv,
    receipts,
    users,
    preferences,
    cache,
    createLocks(events),
  ).execute({ userId: 'user-id', csvBuffer: Buffer.from('csv'), fileType: 'csv' });

  assert.equal(result.provider, 'uber_eats');
  assert.deepEqual(events, [
    'status:import_processing',
    'assert-lock',
    'write',
    'status:completed',
    'cache',
    'release-lock',
  ]);
});

test('CSV import operation marks a started lifecycle failed and releases its lock', async () => {
  const events = [];
  const failureCodes = [];
  const csv = {
    validateCsvFormat: () => ({ valid: true, errors: [] }),
    detectCsvFormat: () => 'doordash',
    parseCsvFile: async () => ({
      success: false,
      receipts: [],
      totalReceipts: 0,
      totalAmount: 0,
      errors: [],
    }),
  };
  const preferences = {
    setExportStatus: async (_userId, _provider, status, failureCode) => {
      events.push(`status:${status}`);
      failureCodes.push(failureCode);
      return true;
    },
  };

  await assert.rejects(
    new CsvImportUseCase(
      csv,
      { replaceProviderExport: async () => undefined },
      { findById: async () => ({ timezone: 'UTC' }) },
      preferences,
      {},
      createLocks(events),
    ).execute({
      userId: 'user-id',
      csvBuffer: Buffer.from('csv'),
      fileType: 'zip',
    }),
    (error) => error.code === 'NO_VALID_EXPORT_ORDERS',
  );
  assert.deepEqual(events, ['status:import_processing', 'status:failed', 'release-lock']);
  assert.deepEqual(failureCodes, [undefined, 'NO_VALID_EXPORT_ORDERS']);
});

test('CSV import operation maps unexpected parser failures to a stable public code', async () => {
  const events = [];
  const failureCodes = [];
  const parserFailure = new Error('parser internals must remain private');
  const csv = {
    validateCsvFormat: () => ({ valid: true, errors: [] }),
    detectCsvFormat: () => 'uber',
    parseCsvFile: async () => {
      throw parserFailure;
    },
  };
  const preferences = {
    setExportStatus: async (_userId, _provider, status, failureCode) => {
      events.push(`status:${status}`);
      failureCodes.push(failureCode);
      return true;
    },
  };

  await assert.rejects(
    new CsvImportUseCase(
      csv,
      { replaceProviderExport: async () => undefined },
      { findById: async () => ({ timezone: 'UTC' }) },
      preferences,
      {},
      createLocks(events),
    ).execute({
      userId: 'user-id',
      csvBuffer: Buffer.from('csv'),
      fileType: 'zip',
    }),
    (error) =>
      error.code === 'EXPORT_IMPORT_FAILED' &&
      error.publicMessage === 'Export import failed. Please try again.' &&
      error.cause === parserFailure,
  );
  assert.deepEqual(events, ['status:import_processing', 'status:failed', 'release-lock']);
  assert.deepEqual(failureCodes, [undefined, 'EXPORT_IMPORT_FAILED']);
});
