const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HistoricalGmailImportService,
} = require('../dist/services/import/HistoricalGmailImportService');

const userId = '00000000-0000-4000-8000-000000000001';
const user = { id: userId, email: 'consumer@example.test' };
const lock = {
  userId,
  ownerToken: 'owner',
  backend: 'memory',
  acquiredAt: 1,
  expiresAt: 2,
};
const successResult = {
  success: true,
  totalEmailsFound: 1,
  totalReceiptsProcessed: 1,
  emailsExamined: 1,
  supportedReceiptsFound: 1,
  exportCoveredReceipts: 0,
  eligibleReceipts: 1,
  deduplicatedReceipts: 0,
  totalReceiptsImported: 1,
  totalAmount: 20,
  errors: [],
  receipts: [],
  newOrders: 1,
  updatedOrders: 0,
  unchangedOrders: 0,
  errorCode: null,
};

const makeService = ({ status, gmailImport, locks, events = [] } = {}) => {
  const ports = {
    status: status ?? {
      getConnection: async () => ({
        user,
        health: { status: 'valid', validatedAt: null },
        status: { canImport: true, needsReconnect: false },
      }),
    },
    gmailImport: gmailImport ?? { importFromGmail: async () => successResult },
    locks: locks ?? {
      acquireLock: async () => {
        events.push('acquire');
        return lock;
      },
      releaseLock: async () => {
        events.push('release');
        return true;
      },
    },
    logger: { info: (message) => events.push(message) },
  };
  return new HistoricalGmailImportService(
    ports.status,
    ports.gmailImport,
    ports.locks,
    ports.logger,
  );
};

test('historical Gmail import validates the connection while holding its writer lock', async () => {
  let acquired = false;
  const service = makeService({
    status: {
      getConnection: async () => ({
        user,
        health: { status: 'unavailable', validatedAt: null },
        status: { canImport: false, needsReconnect: false },
      }),
    },
    locks: {
      acquireLock: async () => {
        acquired = true;
        return lock;
      },
      releaseLock: async () => true,
    },
  });

  await assert.rejects(
    service.execute(userId),
    (error) => error.code === 'GMAIL_VALIDATION_UNAVAILABLE',
  );
  assert.equal(acquired, true);
});

test('historical Gmail import reports the shared busy code when the lock is held', async () => {
  const service = makeService({
    locks: { acquireLock: async () => null, releaseLock: async () => true },
  });
  await assert.rejects(service.execute(userId), (error) => error.code === 'IMPORT_IN_PROGRESS');
});

test('historical Gmail import executes under the lock and releases after success', async () => {
  const events = [];
  const service = makeService({
    events,
    gmailImport: {
      importFromGmail: async (receivedUser, receivedLock) => {
        events.push('import');
        assert.equal(receivedUser, user);
        assert.equal(receivedLock, lock);
        return successResult;
      },
    },
  });

  assert.equal(await service.execute(userId), successResult);
  assert.deepEqual(events, [
    'acquire',
    'Gmail import started',
    'import',
    'Gmail import finished',
    'release',
  ]);
});

test('historical Gmail import maps provider failure and still releases its lock', async () => {
  const events = [];
  const service = makeService({
    events,
    gmailImport: {
      importFromGmail: async () => ({
        ...successResult,
        success: false,
        errorCode: 'PROVIDER_FAILURE',
      }),
    },
  });

  await assert.rejects(
    service.execute(userId),
    (error) =>
      error.code === 'GMAIL_IMPORT_FAILED' && error.details.providerCode === 'PROVIDER_FAILURE',
  );
  assert.equal(events.at(-1), 'release');
});

test('historical Gmail import releases its lock when orchestration throws unexpectedly', async () => {
  const events = [];
  const service = makeService({
    events,
    gmailImport: {
      importFromGmail: async () => {
        throw new Error('boom');
      },
    },
  });
  await assert.rejects(service.execute(userId), /boom/);
  assert.equal(events.at(-1), 'release');
});
