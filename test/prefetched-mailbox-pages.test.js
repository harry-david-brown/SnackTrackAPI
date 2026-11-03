const test = require('node:test');
const assert = require('node:assert/strict');
const { prefetchMailboxPages } = require('../dist/services/import/PrefetchedMailboxPages');

const page = (nextCursor) => ({ messages: [], matchedCount: 20, nextCursor });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('loads one batch ahead while the consumer processes, and drains it on early exit', async () => {
  const release = deferred();
  const started = deferred();
  let reads = 0;
  let closed = false;
  const source = (async function* () {
    try {
      reads++;
      yield page('second');
      reads++;
      started.resolve();
      await release.promise;
      yield page('third');
      reads++;
      yield page(null);
    } finally {
      closed = true;
    }
  })();
  const pages = prefetchMailboxPages(source, () => {});
  assert.equal((await pages.next()).value.nextCursor, 'second');
  await started.promise;
  assert.equal(reads, 2);
  const stopping = pages.return();
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  await stopping;
  assert.equal(closed, true);
  assert.equal(reads, 2);
});

test('a prefetched provider failure is delivered after the current page is consumed', async () => {
  const failure = new Error('provider unavailable');
  const failed = deferred();
  const pages = prefetchMailboxPages((async function* () {
    yield page('second');
    failed.resolve();
    throw failure;
  })(), () => {});
  assert.equal((await pages.next()).value.matchedCount, 20);
  await failed.promise;
  // Allow processing/checkpointing to finish even if the next read already failed.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(pages.next(), (error) => error === failure);
});

test('validation failure prevents prefetch and closes the source', async () => {
  let reads = 0;
  let closed = false;
  const pages = prefetchMailboxPages((async function* () {
    try {
      reads++;
      yield page('second');
      reads++;
      yield page(null);
    } finally {
      closed = true;
    }
  })(), () => { throw new Error('byte budget exceeded'); });
  await assert.rejects(pages.next(), /byte budget exceeded/);
  assert.equal(reads, 1);
  assert.equal(closed, true);
});

test('the final cursor closes the source without starting another read', async () => {
  let closed = false;
  const pages = prefetchMailboxPages((async function* () {
    try {
      yield page(null);
      assert.fail('must not read beyond final cursor');
    } finally {
      closed = true;
    }
  })(), () => {});
  assert.equal((await pages.next()).value.nextCursor, null);
  assert.equal((await pages.next()).done, true);
  assert.equal(closed, true);
});
