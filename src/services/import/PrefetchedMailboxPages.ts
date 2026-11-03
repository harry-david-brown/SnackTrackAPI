import type { MailboxMessagePage } from '../ports/MailboxPorts';

type PageResult =
  | { readonly ok: true; readonly result: IteratorResult<MailboxMessagePage> }
  | { readonly ok: false; readonly error: unknown };

/** Overlap one provider batch with processing, without advancing durable progress. */
export async function* prefetchMailboxPages(
  pages: AsyncIterable<MailboxMessagePage>,
  validate: (page: MailboxMessagePage) => void,
): AsyncGenerator<MailboxMessagePage> {
  const iterator = pages[Symbol.asyncIterator]();
  // Observe failures immediately, but deliver them only after the consumer has
  // finished committing/checkpointing the preceding batch.
  const read = async (): Promise<PageResult> => {
    try {
      return { ok: true, result: await iterator.next() };
    } catch (error) {
      return { ok: false, error };
    }
  };
  let pending = read();
  try {
    while (true) {
      const next = await pending;
      if (!next.ok) throw next.error;
      if (next.result.done) return;
      const page = next.result.value;
      validate(page);
      pending = page.nextCursor === null
        ? Promise.resolve({ ok: true, result: { done: true, value: undefined } })
        : read();
      yield page;
    }
  } finally {
    // A processing/checkpoint failure must not leave reads running after the
    // caller releases its import lock. At most one uncommitted batch is drained.
    await pending;
    await iterator.return?.();
  }
}
