# Reviewed receipt associations

This is an operator extension to the existing [prepare / inspect / publish / rollback workflow](receipt-accuracy-rollout.md). It changes **associations**, not source facts, money or fulfillment. Policy 3 remains gated; no real account has been repaired by this implementation. Use it only with the verified serving account and after coordinated policy-3 activation of compatible API/worker/app consumers. A policy-2 worker rejects review drafts rather than silently ignoring them.

## Prepare a draft

Inspect the account's stored/staged observations first. Use their immutable observation UUIDs, not receipt IDs, email message identifiers, screenshot labels or provisional legacy-source IDs from a preview. When a staged document already exists in storage, use the reused `proposedObservationIds` shown by the audit. Missing original evidence must be acquired separately with existing authorization; a review cannot invent it.

Create a private JSON file containing an array of decisions. For example, replacing these placeholders with actual reviewed UUIDs:

```json
[
  {
    "id": "NEW_REVIEW_UUID",
    "decision": "merge",
    "observationIds": ["EXPORT_OBSERVATION_UUID", "EMAIL_OBSERVATION_UUID"],
    "reason": "Verified that these documents describe the same purchase",
    "reviewer": "OPERATOR_IDENTIFIER"
  }
]
```

- `merge` associates all selected source units as one purchase. This can also bind an original email and its refund/update family before an export is available.
- `keep_separate` prohibits pairwise association of the selected source units. It does not certify missing prices, coverage completeness or a refund, and other unresolved candidates remain reviewable.
- `revoke` requires `supersedesId` instead of `observationIds`. It withdraws the current decision without deleting it or reviving an older ancestor.
- To replace a decision, include its current tip UUID as `supersedesId` in the replacement `merge` or `keep_separate` command. A superseded tip cannot be edited again; inspect the current chain first.

Every command needs a new UUID, nonempty reason and reviewer. An identical retry with the same UUID is a no-op; different instructions under that UUID are rejected. The file is limited to 512 KB, 100 decisions and 100 distinct observation IDs per decision. Unsupported fields are rejected. Keep private reasons and identifiers out of committed fixtures and public reports.

```sh
node dist/scripts/receipt-rebuild.js prepare ACCOUNT_UUID IDEMPOTENCY_KEY --reviews /absolute/path/reviews.json
```

To include explicitly selected staged evidence, add the existing comma-separated batch argument before `--reviews`:

```sh
node dist/scripts/receipt-rebuild.js prepare ACCOUNT_UUID IDEMPOTENCY_KEY BATCH_UUID --reviews /absolute/path/reviews.json
```

These commands enqueue the existing durable repair operation. The worker binds each new decision to this account, its import generation and the exact immutable source documents. Preparation stores the draft history only inside the immutable manifest; ordinary imports cannot see or apply an unpublished decision. Source, identity, currency or decision conflicts reject preparation without changing serving data.

## Inspect and publish

Read the saved manifest UUID from the operation result, then inspect it:

```sh
node dist/scripts/receipt-reconciliation-audit.js ACCOUNT_UUID --manifest MANIFEST_UUID --details
```

The report includes original/proposed order membership and money, review history, supersession, decision UUIDs on affected orders, and whether each review belongs to the original or proposed snapshot. These are frozen proposal facts, not a claim about a subsequently changed account. Legacy audit rows lacking evidence bindings remain inert. Reviewer names and notes are not added to the public receipt DTO.

Publish only the inspected manifest:

```sh
node dist/scripts/receipt-rebuild.js publish ACCOUNT_UUID NEW_IDEMPOTENCY_KEY MANIFEST_UUID
```

No new review file or source selections are accepted during publication or rollback. Publication rechecks generation, fingerprints, expiry and policy under the shared writer lock and user-row lock. It appends the decisions and writes associations, lineage and financial events in one transaction. Cache invalidation remains post-commit. Any intervening import or published review invalidates the draft; prepare a new one instead of applying old choices to new inputs.

## Subsequent evidence and rollback

Future imports use only published decisions. Reimports preserve reviewed membership and stable receipt references. Supported new revisions can enrich the reviewed purchase; a review does not freeze it to precisely two documents. A new revision must be compatible with the **entire** reviewed order, including its export, rather than just its email half. Two separately reviewed purchases cannot be joined by an inferred revision. An automatically matched or reviewed pair does not force the remaining ambiguous pair.

Reviews cannot override conflicting known provider IDs/currencies, split copies of the same source document, or separate an explicit shared order identity/revision reference. Later incompatible interpretations or unavailable evidence leave the affected review unresolved and retain its audit history. Financial calculation stays with the shared resolver: export details remain, email pricing/refunds are resolved from evidence, Uber Cash is payment rather than savings, and source amounts are never added together merely because they were merged.

Rollback uses the existing explicit command:

```sh
node dist/scripts/receipt-rebuild.js rollback ACCOUNT_UUID ANOTHER_IDEMPOTENCY_KEY MANIFEST_UUID
```

It restores the frozen prior projections and appends compensating decisions: restore the previous intent or revoke a newly introduced intent. Original, replacement and rollback records remain immutable. Repeating a successfully committed rollback does not append another reversal. A later import/review still makes an old rollback ineligible; rollback is not permission to overwrite intervening evidence. A subsequent reimport can update provenance to the compensating review UUID while preserving the restored source membership and receipt references.

Migration 031 adds nullable evidence bindings and a unique verified successor to the existing append-only review table; migrations 024–030 are unchanged. Review rows continue to follow the existing account clear/reset/deletion policy. This workflow does not add an admin UI, grant mailbox access, acquire missing email originals, activate policy 3 or perform a live-account repair.
