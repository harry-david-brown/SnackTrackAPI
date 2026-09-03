# Import input security and operations

## Purpose

SnackTrack treats delivery exports and mailbox messages as untrusted input. This document records the implemented controls, their production behavior, and the local-development workflow. The controls are intentionally enforced in the API and worker even when the mobile client performs an earlier convenience check.

## Provider-specific export contract

The generic export endpoint has been removed. Clients must create an intent through exactly one provider route:

- `POST /imports/exports/uber-eats/upload-intent`
- `POST /imports/exports/doordash/upload-intent`

The chosen provider is persisted on the durable import job. It cannot be changed by submission, retry, or worker execution. Reusing an idempotency key with a different provider, filename, content type, or byte length is rejected.

The accepted filename and media-type combinations are:

| File | Maximum uploaded bytes | Accepted media types |
| --- | ---: | --- |
| CSV | 10 MiB | `text/csv`, `application/csv`, `application/octet-stream` |
| ZIP | 50 MiB | `application/zip`, `application/x-zip-compressed`, `application/octet-stream` |

The mobile app checks the extension and measures the copied file using the device filesystem. Picker-supplied size metadata is not trusted. Client checks improve the user experience only; they are not a security boundary.

## Stored-object integrity

The signed PUT fixes the declared content type and content length. On submission, the API reads object-store metadata and atomically records the observed byte length, content type, and ETag while moving the job to dispatchable state.

The worker downloads using `If-Match` with the submitted ETag. It counts bytes while streaming and rejects an object that:

- changed after submission;
- exceeds the format limit;
- expands beyond the submitted byte length;
- ends before the submitted byte length; or
- has content that does not match its CSV/ZIP filename.

This means a spoofed client filename or size field cannot increase the worker's accepted byte budget. Temporary directories are private, files are created without overwrite permission, and only SnackTrack-generated directories are recursively removed. Workers sweep generated temporary directories older than 24 hours on startup. The scheduler removes terminal-job objects from storage after a one-hour safety window and retries cleanup on a later run if storage is unavailable.

Configure an object-storage lifecycle rule as a final backstop to expire all objects under `imports/` after a short retention period (recommended: seven days). The application cleanup remains necessary for prompt deletion; the bucket rule covers interrupted deployments and database/storage drift.

## ZIP rules

Before extraction, the worker scans the entire central directory. It rejects:

- more than 1,000 entries;
- unsafe, absolute, traversing, encoded-traversal, backslash, NUL, or overlong paths;
- symlinks and other special file types;
- encrypted entries;
- a declared total expansion above 250 MiB;
- a selected output above 25 MiB;
- suspicious compression above 100:1; and
- corrupt archives, declared/actual size mismatches, or CRC mismatches.

Only the expected provider data is extracted. DoorDash requires exactly one `consumer_order_details.csv`; profile data is not accepted as order history. Uber Eats accepts uniquely numbered `user_orders-N.csv` shards under an `Eats` directory, sorts them by shard number, and requires matching headers. No unrelated entry is decompressed.

## CSV rules

CSV bytes remain streamed from disk. Parsing uses strict column counts, a 1 MiB maximum row, a 64 KiB header sample, no duplicate headers, at most 64 columns, 100,000 rows, 25,000 orders, and 500 items per order. Provider selection must match the exact required header set.

Text, quantity, money, and date fields have explicit bounds. NUL/binary input, non-finite or negative amounts, extreme quantities, implausible dates, and oversized values are rejected or excluded. If malformed rows exceed 1,000 rows or 10 percent of the input, the entire import fails. Receipt replacement remains staged and atomic, so a rejected file does not damage an account's existing history.

## Mailbox message rules

Mailbox acquisition uses two stages:

1. Fetch a small metadata record and decide whether the message is eligible.
2. Fetch and decode the full body only for eligible messages.

Both Gmail and Outlook use pages of 20 and at most five concurrent detail requests. A single provider response is limited to 2 MiB and a decoded message body to 1 MiB. Address, subject, authentication-header, MIME depth, MIME part count, header count, and encoded-part sizes are bounded. Attachments are ignored. Imported HTML has active/embed/resource elements and remote/data/blob/cid source attributes removed before receipt extraction.

Manual imports stop after 500 MiB of decoded body data; background checks stop after 100 MiB. Existing message, page, time, and result-count budgets still apply. Rejected-message and decoded-byte totals are persisted on sync runs. Provider-wide authorization, throttling, and availability failures abort the page so the durable job can retry; message-local missing, oversized, or malformed records may be skipped.

## Sender and DMARC policy

By default, a receipt must have a visible sender domain equal to, or below, `uber.com`, `ubereats.com`, or `doordash.com`. SnackTrack reads `Authentication-Results` only when it was added by the mailbox provider (`mx.google.com` or Microsoft's protection service). An explicit aligned `dmarc=fail` is rejected. Missing, unrecognized, or inconclusive authentication results are not rejected, which avoids turning transient provider/header differences into lost legitimate receipts.

This check performs no DNS lookup and no cryptographic work. It parses already-returned headers, so its incremental cost is negligible compared with a mailbox API request. It is intentionally not a strict DMARC-pass requirement: forwarding and mailing infrastructure can make otherwise legitimate messages unavailable or inconclusive.

An operator or owner can enable **Forwarded receipt policy** for one account in the admin user detail screen. Enabling it bypasses only the sender-domain and explicit-DMARC-failure rejection. All byte, MIME, body, page, concurrency, sanitization, and import budgets remain enforced. A 10–500 character reason is required, changes are transactional, and every change creates an admin audit event. Keep the exception temporary and revoke it after the user's forwarded history is imported.

## Local development

From `SnackTrackApp`:

```sh
npm run backend:start
npm run dev
```

The backend command starts PostgreSQL, Redis, MinIO, migrations, the API, and a worker. Redis absorbs import bursts and the worker drains them at configured concurrency. MinIO exercises the same signed-upload, HEAD, ETag, conditional-download, cleanup, and streaming paths used with production S3-compatible storage. Push completion is logged locally.

Use `npm run backend:logs` to observe API and worker decisions. `npm run backend:stop` preserves local data. `npm run backend:reset` intentionally deletes the local PostgreSQL, Redis, and MinIO volumes for a clean environment.

With `USE_MOCK_DATA=true`, Gmail fixtures pass through the same 20-message page size, sender/body limits, sanitization, and forwarding policy as production. Keep fixture messages synthetic and do not commit real receipts or export archives.

Recommended manual cases before release:

- valid Uber CSV and multi-shard ZIP;
- valid DoorDash CSV and ZIP;
- provider/file mismatch;
- declared-small but actually-large upload;
- ZIP traversal, symlink, encryption, duplicate target, bad CRC, high ratio, and oversized expansion;
- CSV duplicate headers, oversized row, excessive invalid rows, non-finite amounts, and extreme dates;
- trusted sender with DMARC pass, explicit fail, and unavailable results;
- forwarded receipt before and after the audited account exception;
- oversized Gmail and Outlook messages; and
- worker restart during download, extraction, parsing, and mailbox pagination.

## Production deployment

Run the API, worker, and scheduler as separate Railway services from the same image. The API should not process imports. Start with export worker concurrency `1` and mailbox concurrency `2`, then scale workers horizontally based on queue delay, database headroom, mailbox quotas, memory, and temporary-disk usage. Keep the sum of database pools across all replicas below the Railway PostgreSQL connection limit.

Alert on queue age/depth, repeated object cleanup failures, temporary-disk pressure, import failure codes, rejected-message spikes, decoded-byte budget failures, mailbox throttling, and database saturation. Redis provides buffering, not infinite capacity: retain the waiting-job admission cap and the no-eviction policy.

