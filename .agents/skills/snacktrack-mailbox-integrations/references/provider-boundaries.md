# Mailbox provider boundaries

Read this reference when adding a provider, changing connection persistence/API shapes, decoding provider mail, or integrating message identity with receipt persistence.

## Boundary map

```text
provider OAuth + provider SDK payloads
  -> provider adapter and runtime decoder
  -> MailboxClient / MailboxMessage
  -> acquisition cursor and provider cutoffs
  -> shared extraction and receipt classification
  -> deduplication and canonical ReceiptWritePort
  -> sync/lifecycle projection and cache invalidation
```

Only the first layer should know Gmail API or Microsoft Graph response types. `MailboxMessage` contains the provider-neutral fields the extraction pipeline needs. Extend it only for a proven shared requirement; keep provider-only metadata private to the adapter.

## Adding Outlook or another provider

Before coding, inventory every Gmail-shaped boundary:

- credential columns and connection identity in `users`;
- OAuth state, connection purpose/mode, callback query names, and routes;
- health-cache keys and reconnect transitions;
- import preferences and capability projection;
- background eligibility SQL and scheduler selection;
- sync-run/audit provider identity;
- receipt source/message identity uniqueness;
- app transport names, query keys, controllers, route parameters, and copy.

Choose a provider-aware model for shared concepts rather than parallel booleans that can disagree. Use an additive migration and coordinated API/app contract change when released clients still read Gmail-specific fields.

## Message and receipt identity

- Provider message IDs are stable only within their provider/mailbox namespace. Persist provider plus message/account context before relying on uniqueness across Gmail and Graph.
- A repeated message may update a receipt. Preserve idempotent upsert semantics and accurately report new, updated, and unchanged counts.
- Keep DoorDash/Uber receipt classification independent of the mailbox provider. A DoorDash receipt delivered through Outlook is still a DoorDash receipt, not an Outlook receipt type.
- Preserve export cutoff and replacement rules: richer provider exports may replace matching history while newer mailbox receipts remain.

## Payload and telemetry safety

Runtime-decode list, message, headers/body, profile/account identity, OAuth grant, and provider-error payloads. Map them to stable internal values or typed provider errors. Debug capture remains disabled by default and records only redacted operational metadata.
