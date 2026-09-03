const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { config } = require('../dist/config/AppConfig');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { ServiceType, Currency } = require('../dist/services/extraction/types');
const { MailboxMessage } = require('../dist/services/ports/MailboxPorts');
const { GmailImportService } = require('../dist/services/import/GmailImportService');
const {
  GmailImportAcquisitionService,
} = require('../dist/services/import/GmailImportAcquisitionService');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const {
  ReceiptImportPersistenceService,
} = require('../dist/services/import/ReceiptImportPersistenceService');
const { ImportLockService } = require('../dist/services/import/ImportLockService');
const { ReceiptType, DataSource } = require('../dist/models/Receipt');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'doordash', name), 'utf8');

const trustedSender = 'DoorDash Order <no-reply@doordash.com>';
const recipient = 'consumer@example.test';

const extract = (body, overrides = {}) =>
  new ReceiptExtractor().extract({
    userId: 'test-user',
    from: trustedSender,
    to: recipient,
    body,
    subject: 'Order Confirmation for Customer from Example Burrito Kitchen',
    providerMessageId: 'fixture-message-us-001',
    receivedAt: new Date('2026-06-12T02:01:21.000Z'),
    ...overrides,
  });

test('classifies and extracts the sanitized DoorDash HTML receipt', () => {
  const result = extract(fixture('receipt-us.html'));

  assert.equal(result.classification.isReceipt, true);
  assert.equal(result.classification.confidence, 0.99);
  assert.equal(result.data.service, ServiceType.DOORDASH);
  assert.equal(result.data.merchant, 'Example Burrito Kitchen');
  assert.equal(result.data.total, 41.62);
  assert.equal(result.data.subtotal, 32.05);
  assert.equal(result.data.tax, 2.76);
  assert.equal(result.data.tip, 2);
  assert.equal(result.data.deliveryFee, 0);
  assert.equal(result.data.serviceFee, 4.81);
  assert.equal(result.data.savings, null);
  assert.equal(result.data.currency, Currency.USD);
  assert.equal(result.data.parsedDate.toISOString(), '2026-06-12T02:01:21.000Z');
  assert.match(result.data.orderId, /^doordash:gmail:/);
});

test('extracts bare-dollar Canadian DoorDash plain text and discounts', () => {
  const result = extract(fixture('receipt-cad.txt'), {
    subject: 'Order Confirmation for Customer from Example Chicken Kitchen',
    providerMessageId: 'fixture-message-cad-001',
  });

  assert.equal(result.classification.isReceipt, true);
  assert.equal(result.data.service, ServiceType.DOORDASH);
  assert.equal(result.data.merchant, 'Example Chicken Kitchen');
  assert.equal(result.data.total, 22.44);
  assert.equal(result.data.subtotal, 28.47);
  assert.equal(result.data.tax, 2.35);
  assert.equal(result.data.tip, 2);
  assert.equal(result.data.deliveryFee, 0);
  assert.equal(result.data.serviceFee, 1.71);
  assert.equal(result.data.savings, 12.09);
  assert.equal(result.data.currency, Currency.CAD);
});

test('does not identify generic or spoofed delivery mail as DoorDash', () => {
  const result = extract(fixture('receipt-us.html'), {
    from: 'Delivery Updates <notices@example.test>',
    subject: 'Order Confirmation for Customer from Example Burrito Kitchen',
  });

  assert.notEqual(result.data?.service, ServiceType.DOORDASH);
});

test('DoorDash receipts with malformed totals fail safely', () => {
  const body = fixture('receipt-us.html').replaceAll('US$41.62', 'US$not-a-number');
  const result = extract(body);

  assert.equal(result.classification.isReceipt, true);
  assert.equal(result.data.service, ServiceType.DOORDASH);
  assert.equal(result.data.total, null);
  assert.ok(result.data.warnings.some((warning) => warning.includes('valid total charged')));
});

test('an explicit DoorDash order identifier remains stable across updated emails', () => {
  const withOrderId = fixture('receipt-us.html').replace(
    '<h2>Your receipt</h2>',
    '<h2>Your receipt</h2><p>Order ID: ORDER-REFERENCE-001</p>',
  );
  const first = extract(withOrderId, { providerMessageId: 'first-gmail-message' });
  const updated = extract(withOrderId.replaceAll('US$41.62', 'US$43.62'), {
    providerMessageId: 'second-gmail-message',
  });

  assert.match(first.data.orderId, /^doordash:/);
  assert.equal(updated.data.orderId, first.data.orderId);
});

test('Gmail discovery includes DoorDash sender criteria', () => {
  assert.match(config.getGmailSearchQuery(), /from:doordash\.com/);
});

const createImportDependencies = (email) => {
  const persisted = [];
  let upsertCalls = 0;
  const gmailClient = {
    async getEmails() {
      return [email];
    },
    async *getEmailPages() {
      yield { messages: [email], matchedCount: 1, nextCursor: null };
    },
  };
  const receipts = {
    async getLatestCsvReceiptDates() {
      return {};
    },
    async upsertEmailReceipts(values, assertWriteAllowed) {
      upsertCalls++;
      await assertWriteAllowed();
      persisted.push(...values);
      return { newOrders: values.length, updatedOrders: 0, unchangedOrders: 0 };
    },
    async getEmailReceiptStats() {
      return { count: 0, total: 0 };
    },
  };
  const lifecycle = {
    async start() {
      return 'sync-run';
    },
    async complete() {},
    async fail() {},
    async markReconnectRequired() {},
  };
  const importPreferences = {
    async get() {
      return { lastSuccessfulCheckAt: null, gmailBaselineCompletedAt: null };
    },
  };
  const cache = { async invalidateAllUserCaches() {} };
  const debugCapture = { async capture() {} };

  return {
    service: new GmailImportService(
      new GmailImportAcquisitionService(gmailClient, receipts, importPreferences),
      new ReceiptEmailBatchExtractor(new ReceiptExtractor(), debugCapture),
      new ReceiptImportPersistenceService(receipts, cache, {
        assertLockOwned: async () => undefined,
      }),
      lifecycle,
    ),
    persisted,
    getUpsertCalls: () => upsertCalls,
  };
};

test('a parsed DoorDash email crosses the Gmail import boundary as a DoorDash receipt', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const email = new MailboxMessage(
    userId,
    trustedSender,
    recipient,
    fixture('receipt-us.html'),
    'Order Confirmation for Customer from Example Burrito Kitchen',
    'fixture-message-integration-001',
    new Date('2026-06-12T02:01:21.000Z'),
  );
  const dependencies = createImportDependencies(email);
  const lock = await ImportLockService.acquireLock(userId);
  assert.ok(lock);

  try {
    const result = await dependencies.service.importFromGmail(
      {
        id: userId,
        email: recipient,
        gmailRefreshToken: 'test-refresh-token',
        timezone: 'America/Toronto',
      },
      lock,
    );

    assert.equal(result.success, true);
    assert.equal(result.totalReceiptsImported, 1);
    assert.equal(dependencies.persisted.length, 1);
    assert.equal(dependencies.persisted[0].receiptType, ReceiptType.DOORDASH);
    assert.equal(dependencies.persisted[0].dataSource, DataSource.EMAIL);
    assert.equal(dependencies.persisted[0].amountSpent, 41.62);
    assert.match(dependencies.persisted[0].externalId, /^doordash:gmail:/);
  } finally {
    await ImportLockService.releaseLock(lock);
  }
});

test('the Gmail import boundary does not persist a DoorDash receipt without a usable total', async () => {
  const userId = '00000000-0000-4000-8000-000000000002';
  const body = fixture('receipt-us.html').replaceAll('US$41.62', 'US$not-a-number');
  const email = new MailboxMessage(
    userId,
    trustedSender,
    recipient,
    body,
    'Order Confirmation for Customer from Example Burrito Kitchen',
    'fixture-message-no-total-001',
    new Date('2026-06-12T02:01:21.000Z'),
  );
  const dependencies = createImportDependencies(email);
  const lock = await ImportLockService.acquireLock(userId);
  assert.ok(lock);

  try {
    const result = await dependencies.service.importFromGmail(
      {
        id: userId,
        email: recipient,
        gmailRefreshToken: 'test-refresh-token',
        timezone: 'America/Toronto',
      },
      lock,
    );

    assert.equal(result.success, true);
    assert.equal(result.totalReceiptsImported, 0);
    assert.equal(dependencies.getUpsertCalls(), 0);
    assert.equal(dependencies.persisted.length, 0);
  } finally {
    await ImportLockService.releaseLock(lock);
  }
});
