# Acquiring retained export evidence for a reviewed repair

This operator workflow acquires **evidence**, not serving orders. It does not fetch a mailbox, enqueue an ordinary import, publish a repair, reset an account or enable policy 3. Verify the serving database and exact account UUID before use. The source file must already be retained and authorized for this account.

## Preview first

Build the API, then run from the API directory using the serving environment's configuration:

```sh
node dist/scripts/receipt-repair-export.js USER_UUID uber_eats "/absolute/path/to/retained.zip"
```

Use `doordash` for DoorDash. CSV and ZIP files are detected by content, not the filename extension. Normal upload size limits and the existing safe archive extraction rules apply. Symlinks, non-regular files, provider mismatches, corrupt/unsafe archives and files that change during copying are rejected. Private temporary snapshots are removed after parsing; the original file is unchanged.

Preview performs account-scoped reads only and does not initialize Redis or write a source batch. Its JSON output includes:

- Account UUID, import generation and parsing timezone; no login or mailbox credentials.
- Parser policy, acquisition timestamp and a review fingerprint binding account context, retained-file identity, parsed observations and rejection/completion information.
- SHA-256 and size of the retained file, without its private path.
- Distinct source-document count, rejected-record count, observed date range and export-only canonical metrics by currency.

These are **export-only** results, not the proposed reconciled account totals. Earliest/latest observed orders do not establish complete coverage. Export zero balances remain probable refunds only when the established order policy supports that inference; no email-confirmed refund is manufactured. DoorDash item subtotals do not become final charges. Empty exports can be inspected but cannot be staged without usable observations.

## Stage the reviewed preview

Copy the exact `acquiredAt`, `generation` and `fingerprint` from the preview:

```sh
node dist/scripts/receipt-repair-export.js USER_UUID uber_eats "/absolute/path/to/retained.zip" \
  --stage --acquired-at ACQUIRED_AT \
  --expected-generation GENERATION --expected-fingerprint PREVIEW_FINGERPRINT
```

`ACQUIRED_AT` must be the UTC ISO string returned by preview, including milliseconds. The file is snapshotted and parsed again. A changed file, parsed interpretation, timezone or generation requires a fresh preview. Identical retries with the same preview context reuse the immutable batch. The response returns the staged `batchId`; its storage fingerprint is distinct from the acquisition preview fingerprint.

Staging requires the existing **shared Redis receipt-writer lock**. A process-local fallback is not safe for an independent operator process and is rejected. An unavailable/busy lock does not write evidence. Inside the staging transaction, the account generation and parsing timezone are checked again under the account row lock; loss of the writer lease rolls back insertion. No canonical receipts, serving source coverage, import lifecycle or order events are changed by staging.

The immutable provenance retains the artifact fingerprint/size, acquisition time, parser fallback timezone, accepted source observations and rejection/completion limitations. It does not retain a second raw ZIP, signed URL or mailbox credential. Source rows follow the existing redaction/retention policy. Staged batches expire for publication after seven days and follow account clear/reset/deletion cleanup.

## Inspect the whole-account proposal

The staged export can now participate with stored evidence and any separately authorized staged email sources:

```sh
node dist/scripts/receipt-reconciliation-audit.js USER_UUID --policy 3 \
  --staged-batches BATCH_UUID --details
```

Review associations, remaining exceptions, original/source values, currency-separated totals, cancellation/refund outcomes and source limitations. This preview does not publish and its provisional IDs are not a repair manifest.

After coordinated policy-3 activation, the existing worker preparation workflow accepts the reviewed batch IDs:

```sh
node dist/scripts/receipt-rebuild.js prepare USER_UUID IDEMPOTENCY_KEY BATCH_UUID
node dist/scripts/receipt-reconciliation-audit.js USER_UUID --manifest MANIFEST_UUID --details
```

Use the explicit saved manifest for publication/rollback as documented in [the rollout workflow](receipt-accuracy-rollout.md). A policy-3 source batch cannot be prepared/published by the still-serving policy-2 worker. The acquisition command does not bypass that gate. No startup backfill or unreviewed multi-account repair is provided.

Retained-email re-extraction/acquisition remains separate work; this command does not broaden mailbox access or resolve unavailable originals. Explicit reviewed associations can be included in the subsequent preparation job using the [review-decision workflow](receipt-review-repair.md). They never take effect merely because export evidence was staged.
