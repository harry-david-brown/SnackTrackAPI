const test = require('node:test');
const assert = require('node:assert/strict');
const { GmailClient } = require('../dist/services/email/GmailClient');
const {
  GmailQuotaPacer,
  GMAIL_MESSAGE_GET_QUERY_UNITS,
  GMAIL_MESSAGE_LIST_QUERY_UNITS,
} = require('../dist/services/email/GmailQuotaPacer');

const encoded = (value) => Buffer.from(value).toString('base64url');

test('Gmail import fetches each matched message once in full format', async () => {
  const getCalls = [];
  const gmail = {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'user@example.test' } }),
      messages: {
        list: async () => ({ data: { messages: [{ id: 'message-1' }] } }),
        get: async (input) => {
          getCalls.push(input);
          return {
            data: {
              id: input.id,
              internalDate: '1788739200000',
              sizeEstimate: 1_024,
              payload: {
                mimeType: 'text/html',
                headers: [
                  { name: 'From', value: 'Uber Receipts <noreply@uber.com>' },
                  { name: 'To', value: 'user@example.test' },
                  { name: 'Subject', value: 'Your Uber Eats order' },
                  { name: 'Date', value: 'Sun, 6 Sep 2026 12:00:00 +0000' },
                  { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=uber.com' },
                ],
                body: { data: encoded('<p>Receipt total: $24.00</p>') },
              },
            },
          };
        },
      },
    },
  };
  const client = new GmailClient(undefined, undefined, gmail);

  const pages = [];
  for await (const page of client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { safety: { allowForwardedReceipts: false } },
  )) pages.push(page);

  assert.equal(getCalls.length, 1);
  assert.deepEqual(getCalls[0], { userId: 'me', id: 'message-1', format: 'full' });
  assert.equal(pages[0].messages.length, 1);
  assert.equal(pages[0].messages[0].from, 'Uber Receipts <noreply@uber.com>');
  assert.match(pages[0].messages[0].body, /Receipt total/);
});

test('single full response still runs sender and authentication checks before yielding a message', async () => {
  const gmail = {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'user@example.test' } }),
      messages: {
        list: async () => ({ data: { messages: [{ id: 'message-1' }] } }),
        get: async () => ({ data: {
          id: 'message-1', sizeEstimate: 500,
          payload: {
            mimeType: 'text/html',
            headers: [
              { name: 'From', value: 'Attacker <receipt@example.test>' },
              { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=example.test' },
            ],
            body: { data: encoded('<p>Fake receipt</p>') },
          },
        } }),
      },
    },
  };
  const client = new GmailClient(undefined, undefined, gmail);

  const pages = [];
  for await (const page of client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { safety: { allowForwardedReceipts: false } },
  )) pages.push(page);

  assert.equal(pages[0].messages.length, 0);
  assert.equal(pages[0].rejectedCount, 1);
});

test('Gmail quota pacing spaces requests according to their query cost', async () => {
  let now = 0;
  const waits = [];
  const pacer = new GmailQuotaPacer(
    4_800,
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );

  await pacer.waitFor(GMAIL_MESSAGE_LIST_QUERY_UNITS);
  await pacer.waitFor(GMAIL_MESSAGE_GET_QUERY_UNITS);
  await pacer.waitFor(GMAIL_MESSAGE_GET_QUERY_UNITS);

  assert.deepEqual(waits, [63, 250]);
});

test('Gmail import disables transport retries and uses the configured quota budget', async () => {
  const listInputs = [];
  const listOptions = [];
  const getOptions = [];
  const gmail = {
    users: {
      messages: {
        list: async (_input, options) => {
          listInputs.push(_input);
          listOptions.push(options);
          return { data: { messages: [{ id: 'message-1' }] } };
        },
        get: async (_input, options) => {
          getOptions.push(options);
          return { data: {
            id: 'message-1', sizeEstimate: 500,
            payload: {
              mimeType: 'text/html',
              headers: [
                { name: 'From', value: 'Uber Receipts <noreply@uber.com>' },
                { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=uber.com' },
              ],
              body: { data: encoded('<p>Receipt total: $24.00</p>') },
            },
          } };
        },
      },
    },
  };
  const client = new GmailClient(undefined, undefined, gmail);

  for await (const _page of client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { safety: { allowForwardedReceipts: false } },
  )) { /* consume */ }

  assert.equal(listInputs[0].maxResults, 500);
  assert.deepEqual(listOptions, [{ retry: false }]);
  assert.deepEqual(getOptions, [{ retry: false }]);
});

test('Gmail import checkpoints 500-ID listings in 20-message processing batches', async () => {
  const listedIds = Array.from({ length: 21 }, (_, index) => `message-${index + 1}`);
  const listInputs = [];
  const getCalls = [];
  const gmail = {
    users: {
      messages: {
        list: async (input) => {
          listInputs.push(input);
          return { data: { messages: listedIds.map((id) => ({ id })) } };
        },
        get: async (input) => {
          getCalls.push(input.id);
          return { data: {
            id: input.id, sizeEstimate: 500,
            payload: {
              mimeType: 'text/html',
              headers: [
                { name: 'From', value: 'Uber Receipts <noreply@uber.com>' },
                { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=uber.com' },
              ],
              body: { data: encoded('<p>Receipt total: $24.00</p>') },
            },
          } };
        },
      },
    },
  };
  const client = new GmailClient(undefined, undefined, gmail);

  const firstIterator = client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { safety: { allowForwardedReceipts: false } },
  )[Symbol.asyncIterator]();
  const first = await firstIterator.next();
  await firstIterator.return();

  assert.equal(first.value.matchedCount, 20);
  assert.match(first.value.nextCursor, /^snacktrack:gmail-buffer:v1:/);
  assert.equal(listInputs.length, 1);

  const resumedIterator = client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { cursor: first.value.nextCursor, safety: { allowForwardedReceipts: false } },
  )[Symbol.asyncIterator]();
  const resumed = await resumedIterator.next();
  await resumedIterator.return();

  assert.equal(resumed.value.matchedCount, 1);
  assert.equal(listInputs.length, 1);
  assert.deepEqual(getCalls, listedIds);
});
