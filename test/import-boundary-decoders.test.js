const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeUberCsvRow,
  decodeDoorDashCsvRow,
} = require('../dist/services/import/CsvImportService');
const { decodeExtractionResult } = require('../dist/services/extraction/ExtractionResultDecoder');
const { Currency, ServiceType } = require('../dist/services/extraction/types');
const {
  decodeGmailMessage,
  decodeGmailMessageList,
  decodeGmailProfile,
  decodeGoogleOAuthTokens,
  decodeGoogleUserInfoEmail,
} = require('../dist/services/email/GmailProviderDecoder');

test('CSV boundary decoders normalize missing optional strings and reject non-string values', () => {
  const uber = decodeUberCsvRow({
    Restaurant_Name: 'Test Kitchen',
    Request_Time_Local: '2026-08-01T18:00:00',
    Order_Status: 'completed',
  });
  assert.equal(uber.Restaurant_Name, 'Test Kitchen');
  assert.equal(uber.Customizations, '');
  assert.equal(uber.Currency, '');

  const doorDash = decodeDoorDashCsvRow({
    STORE_NAME: 'Dash Kitchen',
    CREATED_AT: '2026-08-01T18:00:00Z',
    SUBTOTAL: '20.00',
  });
  assert.equal(doorDash.STORE_NAME, 'Dash Kitchen');
  assert.equal(doorDash.DELIVERY_ADDRESS, '');

  assert.throws(() => decodeUberCsvRow({ Restaurant_Name: 42 }), /must be a string/);
  assert.throws(() => decodeDoorDashCsvRow(['not', 'a', 'record']), /must be an object/);
});

const extraction = (overrides = {}) => ({
  classification: {
    isReceipt: true,
    confidence: 0.9,
    reason: 'trusted sender and receipt content',
    matchedKeywords: ['receipt'],
    tableWordHits: 4,
  },
  data: {
    orderId: 'order-1',
    service: ServiceType.UBER_EATS,
    merchant: 'Test Kitchen',
    orderDate: 'Aug 1, 2026',
    orderTime: '6:00 PM',
    parsedDate: new Date('2026-08-01T22:00:00.000Z'),
    currency: Currency.CAD,
    total: 20,
    subtotal: 16,
    tax: 2,
    tip: 2,
    deliveryFee: 0,
    serviceFee: 0,
    savings: 0,
    deliveryAddress: null,
    paymentMethod: null,
    subject: 'Your receipt',
    from: 'noreply@example.test',
    extractionConfidence: 0.95,
    warnings: [],
  },
  rawText: 'receipt body',
  coreText: 'receipt body',
  ...overrides,
});

test('parsed receipt boundary accepts the complete schema and rejects malformed nested values', () => {
  const decoded = decodeExtractionResult(extraction());
  assert.equal(decoded.data.currency, Currency.CAD);
  assert.equal(decoded.data.parsedDate.toISOString(), '2026-08-01T22:00:00.000Z');

  assert.throws(
    () =>
      decodeExtractionResult(
        extraction({
          data: { ...extraction().data, currency: 'DOGE' },
        }),
      ),
    /data\.currency/,
  );
  assert.throws(
    () =>
      decodeExtractionResult(
        extraction({ classification: { ...extraction().classification, confidence: 2 } }),
      ),
    /classification\.confidence/,
  );
  assert.throws(
    () => decodeExtractionResult(extraction({ data: { ...extraction().data, warnings: [7] } })),
    /data\.warnings\.0/,
  );
});

test('Gmail provider boundary decodes message, profile, and OAuth payloads once', () => {
  assert.deepEqual(
    decodeGmailMessageList({
      data: { messages: [{ id: 'message-1' }], nextPageToken: 'next-page', resultSizeEstimate: 42 },
    }),
    { messageIds: ['message-1'], nextPageToken: 'next-page', resultSizeEstimate: 42 },
  );
  const message = decodeGmailMessage({
    data: {
      id: 'message-1',
      internalDate: '1785621600000',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'Subject', value: 'Your receipt' }],
        parts: [{ mimeType: 'text/html', body: { data: 'PGh0bWw+' } }],
      },
    },
  });
  assert.equal(message.payload.parts[0].bodyData, 'PGh0bWw+');
  assert.equal(
    decodeGmailProfile({ data: { emailAddress: 'person@example.com' } }).emailAddress,
    'person@example.com',
  );
  assert.equal(
    decodeGoogleUserInfoEmail({ data: { email: 'person@example.com' } }),
    'person@example.com',
  );
  assert.deepEqual(
    decodeGoogleOAuthTokens(
      {
        tokens: {
          access_token: 'access',
          refresh_token: 'refresh',
          expiry_date: 1_800_000_000_000,
          scope: 'openid email gmail.readonly',
        },
      },
      () => 0,
    ).scopes,
    ['openid', 'email', 'gmail.readonly'],
  );
});

test('Gmail provider boundary rejects malformed nested SDK responses', () => {
  for (const operation of [
    () => decodeGmailMessageList({ data: { messages: [{ id: 42 }] } }),
    () => decodeGmailMessage({ data: { payload: { headers: 'invalid' } } }),
    () => decodeGmailProfile({ data: { emailAddress: 'not-an-email' } }),
    () => decodeGoogleOAuthTokens({ tokens: { access_token: 42 } }),
    () => decodeGoogleUserInfoEmail({ data: {} }),
  ]) {
    assert.throws(operation, (error) => error.code === 'GMAIL_PROVIDER_PAYLOAD_INVALID');
  }
});
