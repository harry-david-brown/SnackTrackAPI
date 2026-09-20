const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MailboxContentGuard } = require('../dist/services/mailbox/MailboxContentGuard');
const {
  extractLinkedProviderOrderId,
} = require('../dist/services/receipt/ReceiptProviderOrderIdentity');
const { GmailClient } = require('../dist/services/email/GmailClient');
const {
  MicrosoftGraphMailboxClient,
} = require('../dist/services/mailbox/MicrosoftGraphMailboxClient');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

test('mailbox sanitization retains only unambiguous supported order references, never tracking or access parameters', () => {
  for (const [provider, host] of [
    ['uber_eats', 'www.ubereats.com'],
    ['doordash', 'www.doordash.com'],
  ]) {
    const guard = new MailboxContentGuard(3);
    const preflight = guard.preflight({
      provider: 'gmail',
      from: `receipts@${host}`,
      allowForwardedReceipts: false,
    });
    const html = `<p>Total CA$22.48</p><a href="https://${host}/orders/${firstId}?access_token=private-token&amp;tracking=private-tracking">Visit your order</a><img src="https://tracker.example/pixel"><script><a href="https://${host}/orders/${secondId}">Hidden</a></script>`;
    const safe = guard.acceptBody(html, preflight);
    assert.equal(safe.accepted, true);
    assert.equal(extractLinkedProviderOrderId(safe.body, provider), firstId);
    assert.doesNotMatch(
      safe.body,
      /private-token|private-tracking|access_token|tracker\.example|<script|<img/,
    );
    assert.equal(
      extractLinkedProviderOrderId(guard.acceptBody(safe.body, preflight).body, provider),
      firstId,
    );
    const conflicting = guard.acceptBody(
      `${html}<a href="https://${host}/orders/${secondId}">Another order</a>`,
      preflight,
    );
    assert.equal(extractLinkedProviderOrderId(conflicting.body, provider), undefined);
    assert.equal(
      extractLinkedProviderOrderId(
        `<a href="https://${host}/orders/${firstId}?order_uuid=${secondId}">Conflicting reference</a>`,
        provider,
      ),
      undefined,
    );
    assert.equal(
      extractLinkedProviderOrderId(
        `<a data-href="https://${host}/orders/${firstId}" title='href="https://${host}/orders/${firstId}"'>Not a link</a>`,
        provider,
      ),
      undefined,
    );
    assert.equal(
      extractLinkedProviderOrderId(
        `<a href=https://${host}/orders/${firstId}>Unquoted link</a>`,
        provider,
      ),
      firstId,
    );
    const unrelated = guard.acceptBody(
      `<a href="https://${host}.evil.example/orders/${firstId}">Lookalike</a><a href="https://${host}/tracking/${firstId}">Tracking</a>`,
      preflight,
    );
    assert.equal(extractLinkedProviderOrderId(unrelated.body, provider), undefined);
    assert.doesNotMatch(unrelated.body, /href=/);
    assert.equal(guard.acceptBody(html, { accepted: false, authentication: 'fail' }).body, '');
    assert.equal(
      extractLinkedProviderOrderId(
        new MailboxContentGuard(2).acceptBody(html, preflight).body,
        provider,
      ),
      undefined,
    );
  }
});

const messages = [
  {
    id: 'original-one',
    orderId: firstId,
    subject: 'Your receipt',
    text: "<p>Total CA$22.48</p><p>December 10, 2023</p><p>Here's your receipt from Pizza Pizza (1717 Bank St.).</p><p>Delivered by Courier</p>",
  },
  {
    id: 'original-two',
    orderId: secondId,
    subject: 'Your receipt',
    text: "<p>Total CA$22.48</p><p>December 10, 2023</p><p>Here's your receipt from Pizza Pizza (1717 Bank St.).</p><p>Delivered by Courier</p>",
  },
  {
    id: 'refund',
    orderId: firstId,
    subject: 'Your refund',
    text: '<p>January 10, 2024</p><p>We refunded CA$22.48 to your Uber Cash for your order.</p><p>Refund ID: refund-one</p>',
  },
];
const body = (m) =>
  `<p>Uber Eats</p>${m.text}<a href="https://www.ubereats.com/orders/${m.orderId}?auth=not-retained">View order</a>`;
const response = (value) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => value,
});

for (const provider of ['gmail', 'microsoft'])
  test(`${provider}: real safety-to-extraction boundary links a later refund to the correct repeated purchase`, async () => {
    const listing = [];
    let pages;
    if (provider === 'gmail') {
      const api = {
        users: {
          messages: {
            list: async (input) => {
              listing.push(input);
              return { data: { messages: messages.map((m) => ({ id: m.id })) } };
            },
            get: async ({ id }) => {
              const m = messages.find((candidate) => candidate.id === id);
              return {
                data: {
                  id,
                  sizeEstimate: 1000,
                  internalDate: String(Date.parse('2024-01-10T17:00:00Z')),
                  payload: {
                    mimeType: 'text/html',
                    headers: [
                      { name: 'From', value: 'receipts@uber.com' },
                      { name: 'Subject', value: m.subject },
                    ],
                    body: { data: Buffer.from(body(m)).toString('base64url') },
                  },
                },
              };
            },
          },
        },
      };
      pages = new GmailClient(undefined, undefined, api, undefined, 3).getEmailPages(
        { id: 'test-user', email: 'test@example.com' },
        { after: new Date('2024-01-09T00:00Z'), safety: { allowForwardedReceipts: false } },
      );
    } else {
      const fetcher = async (url) => {
        const request = new URL(url);
        if (request.searchParams.has('$search')) {
          listing.push(request);
          return response({
            value: messages.map((m) => ({
              id: m.id,
              from: { emailAddress: { address: 'receipts@uber.com' } },
              subject: m.subject,
              receivedDateTime: '2024-01-10T17:00:00Z',
            })),
          });
        }
        const m = messages.find((candidate) => request.pathname.endsWith(`/${candidate.id}`));
        return response({ id: m.id, body: { content: body(m) } });
      };
      pages = new MicrosoftGraphMailboxClient(
        { acquire: async () => 'test-token' },
        fetcher,
        undefined,
        () => new Date('2024-01-11T00:00Z'),
        async () => {},
        3,
      ).getEmailPages(
        { userId: 'test-user' },
        { after: new Date('2024-01-09T00:00Z'), safety: { allowForwardedReceipts: false } },
      );
    }
    const acquired = [];
    for await (const page of pages) acquired.push(...page.messages);
    assert.equal(acquired.length, 3);
    const batch = await new ReceiptEmailBatchExtractor(
      new ReceiptExtractor({}, 3),
      { capture: async () => {} },
      10,
      Date.now,
      3,
    ).extract(acquired, 'America/Toronto', { userId: 'test-user', trigger: 'background' });
    assert.deepEqual(batch.errors, []);
    assert.equal(batch.supportedReceipts.length, 3);
    assert.deepEqual(
      batch.supportedReceipts.map((r) => r.externalId).sort(),
      [firstId, firstId, secondId].sort(),
    );
    const groups = reconcileReceiptGroups(
      batch.supportedReceipts.map((receipt, i) => ({ id: `source-${i}`, receipt })),
      'America/Toronto',
      [],
      3,
    );
    const records = groups.map((group, i) => projectReconciledGroup(group, `order-${i}`));
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => r.resolution.orderOutcome.netAmount).sort((a, b) => a - b),
      [0, 22.48],
    );
    assert.ok(records.every((r) => r.orderDate.toISOString().slice(0, 10) === '2023-12-10'));
    assert.equal(summarizeOrderMetrics(records).confirmedRefunds, 1);
    assert.equal(summarizeOrderMetrics(records).attempts, 2);
    if (provider === 'gmail') {
      assert.match(listing[0].q, /subject:receipt/);
      assert.match(listing[0].q, /subject:refund/);
      assert.match(listing[0].q, /after:1704758400/);
    } else {
      assert.match(listing[0].searchParams.get('$search'), /received>=2024-01-09/);
      assert.doesNotMatch(listing[0].searchParams.get('$search'), /subject:order/);
    }
  });
