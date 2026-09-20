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
                  {
                    name: 'Authentication-Results',
                    value: 'mx.google.com; dmarc=pass header.from=uber.com',
                  },
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
  ))
    pages.push(page);

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
        get: async () => ({
          data: {
            id: 'message-1',
            sizeEstimate: 500,
            payload: {
              mimeType: 'text/html',
              headers: [
                { name: 'From', value: 'Attacker <receipt@example.test>' },
                {
                  name: 'Authentication-Results',
                  value: 'mx.google.com; dmarc=pass header.from=example.test',
                },
              ],
              body: { data: encoded('<p>Fake receipt</p>') },
            },
          },
        }),
      },
    },
  };
  const client = new GmailClient(undefined, undefined, gmail);

  const pages = [];
  for await (const page of client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { safety: { allowForwardedReceipts: false } },
  ))
    pages.push(page);

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
          return {
            data: {
              id: 'message-1',
              sizeEstimate: 500,
              payload: {
                mimeType: 'text/html',
                headers: [
                  { name: 'From', value: 'Uber Receipts <noreply@uber.com>' },
                  {
                    name: 'Authentication-Results',
                    value: 'mx.google.com; dmarc=pass header.from=uber.com',
                  },
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

  for await (const _page of client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { safety: { allowForwardedReceipts: false } },
  )) {
    /* consume */
  }

  assert.equal(listInputs[0].maxResults, 500);
  assert.match(listInputs[0].q, /subject:order/);
  assert.deepEqual(listOptions, [{ retry: false }]);
  assert.deepEqual(getOptions, [{ retry: false }]);
});

test('policy 2 forwarded-receipt searches retain the original subject filter', async () => {
  const listInputs = [];
  const gmail = {
    users: {
      messages: {
        list: async (input) => {
          listInputs.push(input);
          return { data: { messages: [] } };
        },
        get: async () => {
          throw new Error('No messages should be fetched');
        },
      },
    },
  };
  const client = new GmailClient(undefined, undefined, gmail);

  for await (const _page of client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { safety: { allowForwardedReceipts: true } },
  )) {
    /* consume */
  }

  assert.match(listInputs[0].q, /\(subject:Uber OR subject:DoorDash\)/);
  assert.match(listInputs[0].q, /subject:order/);
});

test('legacy provider cursors retain the original sender-only search', async () => {
  const listInputs = [];
  const gmail = {
    users: {
      messages: {
        list: async (input) => {
          listInputs.push(input);
          return { data: { messages: [] } };
        },
        get: async () => {
          throw new Error('No messages should be fetched');
        },
      },
    },
  };
  const client = new GmailClient(undefined, undefined, gmail);

  for await (const _page of client.getEmailPages(
    { id: 'user-1', email: 'user@example.test' },
    { cursor: 'legacy-provider-token', safety: { allowForwardedReceipts: false } },
  )) {
    /* consume */
  }

  assert.equal(listInputs[0].pageToken, 'legacy-provider-token');
  assert.doesNotMatch(listInputs[0].q, /subject:order/);
});

test('versioned Gmail searches retain their original scope across the order-event rollout', async () => {
  for (const version of [1, 2, 3]) {
    for (const forwarded of [true, false]) {
      const listInputs = [];
      const api = {
        users: {
          messages: {
            list: async (input) => {
              listInputs.push(input);
              return { data: { messages: [] } };
            },
            get: async () => {
              throw new Error('No message details expected');
            },
          },
        },
      };
      const cursor = `snacktrack:gmail-buffer:v${version}:${encoded(JSON.stringify({ pendingMessageIds: [], nextPageToken: 'provider-next-page' }))}`;
      const client = new GmailClient(undefined, undefined, api, undefined, 3);
      for await (const _page of client.getEmailPages(
        { id: 'test-user' },
        { cursor, safety: { allowForwardedReceipts: forwarded } },
      )) {
        /* consume */
      }
      assert.equal(listInputs[0].pageToken, 'provider-next-page');
      if (version === 1) assert.doesNotMatch(listInputs[0].q, /subject:order/);
      if (version === 2) {
        assert.match(listInputs[0].q, /subject:order/);
        assert.doesNotMatch(listInputs[0].q, /subject:refund|subject:receipt/);
      }
      if (version === 3) {
        assert.match(
          listInputs[0].q,
          /\(subject:order OR subject:receipt OR subject:refund OR subject:canceled OR subject:cancelled OR subject:cancellation OR subject:adjustment\)/,
        );
        assert.equal(listInputs[0].q.includes('(subject:Uber OR subject:DoorDash)'), forwarded);
      }
    }
  }
});

test('unsupported Gmail cursor versions and policy downgrade resumes fail before provider requests', async () => {
  const api = {
    users: {
      messages: {
        list: async () => {
          throw new Error('Invalid checkpoints must not reach Gmail');
        },
        get: async () => {
          throw new Error('Invalid checkpoints must not reach Gmail');
        },
      },
    },
  };
  for (const [policy, cursor] of [
    [3, 'snacktrack:gmail-buffer:v99:unknown'],
    [3, 'snacktrack:gmail-buffer:v3:not-json'],
    [
      2,
      `snacktrack:gmail-buffer:v3:${encoded(JSON.stringify({ pendingMessageIds: ['pending'], nextPageToken: null }))}`,
    ],
  ]) {
    const iterator = new GmailClient(undefined, undefined, api, undefined, policy)
      .getEmailPages({ id: 'test-user' }, { cursor })
      [Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), (error) => error.code === 'IMPORT_CHECKPOINT_INVALID');
  }
});

for (const policy of [2, 3])
  test(`policy ${policy}: Gmail import checkpoints 500-ID listings in 20-message processing batches`, async () => {
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
            return {
              data: {
                id: input.id,
                sizeEstimate: 500,
                payload: {
                  mimeType: 'text/html',
                  headers: [
                    { name: 'From', value: 'Uber Receipts <noreply@uber.com>' },
                    {
                      name: 'Authentication-Results',
                      value: 'mx.google.com; dmarc=pass header.from=uber.com',
                    },
                  ],
                  body: { data: encoded('<p>Receipt total: $24.00</p>') },
                },
              },
            };
          },
        },
      },
    };
    const client = new GmailClient(undefined, undefined, gmail, undefined, policy);

    const firstIterator = client
      .getEmailPages(
        { id: 'user-1', email: 'user@example.test' },
        { safety: { allowForwardedReceipts: false } },
      )
      [Symbol.asyncIterator]();
    const first = await firstIterator.next();
    await firstIterator.return();

    assert.equal(first.value.matchedCount, 20);
    assert.match(first.value.nextCursor, new RegExp(`^snacktrack:gmail-buffer:v${policy}:`));
    assert.equal(listInputs.length, 1);

    const resumedIterator = client
      .getEmailPages(
        { id: 'user-1', email: 'user@example.test' },
        { cursor: first.value.nextCursor, safety: { allowForwardedReceipts: false } },
      )
      [Symbol.asyncIterator]();
    const resumed = await resumedIterator.next();
    await resumedIterator.return();

    assert.equal(resumed.value.matchedCount, 1);
    assert.equal(listInputs.length, 1);
    assert.deepEqual(getCalls, listedIds);
  });

test('Gmail import exhausts every list page before fetching message bodies', async () => {
  const events = [];
  const gmail = {
    users: {
      messages: {
        list: async (input) => {
          events.push(`list:${input.pageToken ?? 'first'}`);
          return input.pageToken
            ? { data: { messages: [{ id: 'message-3' }] } }
            : {
                data: {
                  messages: [{ id: 'message-1' }, { id: 'message-2' }],
                  nextPageToken: 'second-page',
                  resultSizeEstimate: 3,
                },
              };
        },
        get: async (input) => {
          events.push(`get:${input.id}`);
          return {
            data: {
              id: input.id,
              sizeEstimate: 500,
              payload: {
                mimeType: 'text/html',
                headers: [
                  { name: 'From', value: 'Uber Receipts <noreply@uber.com>' },
                  {
                    name: 'Authentication-Results',
                    value: 'mx.google.com; dmarc=pass header.from=uber.com',
                  },
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
  ))
    pages.push(page);

  assert.deepEqual(events.slice(0, 2), ['list:first', 'list:second-page']);
  assert.deepEqual(events.slice(2).sort(), ['get:message-1', 'get:message-2', 'get:message-3']);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].matchedCount, 3);
  assert.equal(pages[0].estimatedTotalCount, 3);
  assert.equal(pages[0].nextCursor, null);
});
