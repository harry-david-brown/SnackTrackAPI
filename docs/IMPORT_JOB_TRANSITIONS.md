# Durable import transition contract

`ImportJobTransitions.ts` defines command source states. `ImportJobRepository`
uses those constants inside its atomic UPDATE predicates. It does not first read
and then authorize a write in application memory.

| Command | Transition | Additional guard / effects | Repeated or late command |
| --- | --- | --- | --- |
| Create | absent → awaiting_upload or pending_dispatch | User serialization, active-job/idempotency checks; dispatch outbox for executable work | Existing idempotent operation or conflict |
| Submit upload | awaiting_upload → pending_dispatch | Matching user; unexpired intent; dispatch outbox and upload_submitted event in transaction | UPLOAD_NOT_SUBMITTABLE; client inspects existing operation |
| Queue | pending_dispatch/retrying → queued | queued event with UPDATE | No-op outside sources |
| Claim | pending_dispatch/queued/running/retrying → running | Current user generation, attempt increment, heartbeat and attempt_started event; worker owns writer lock | Running is deliberately reclaimable; stale generation supersedes unclaimed work |
| Progress/checkpoint/heartbeat | running → running | Monotonic progress; checkpoint/heartbeat update | No-op outside running |
| Retry | running → retrying | Clear heartbeat; attempt_failed_retrying event | IMPORT_RETRY_STATE_CONFLICT |
| Infrastructure delay | running → retrying | Refund execution attempt; infrastructure_wait event | No-op outside running |
| Finish | running → succeeded/failed | Current generation; completion event and notification outbox in same transaction; provider-ready checks retain consent/request guards | Running stale generation becomes superseded; terminal operations are not revived |
| Supersede | active → superseded | Reset owns transaction/lock and advances user generation | Terminal states unchanged |
| Expire upload | awaiting_upload → expired | Database expiry deadline; expired event | No-op after submission |
| Cancel pending | pending_dispatch/queued/retrying → cancelled | Lock selected rows; finish dispatch outbox; audit and cancellation events in transaction | Running and terminal jobs excluded |
| Recover stale | queued/running/retrying → pending_dispatch | Stale heartbeat/queue timestamp; event and dispatch outbox reactivation in transaction | Fresh and terminal jobs excluded |

Publication is a separate outbox lifecycle: claim with SKIP LOCKED and a retry
lease, publish, then acknowledge. Failed publication retains the event and
schedules another attempt. A Redis outage does not erase accepted database work.

No schema, wire statuses, error codes, lock boundaries, or scheduling semantics
were changed by this consolidation. Cross-service writers such as account reset
retain their own atomic SQL and transaction ownership; this table is their audit
reference, not permission to bypass those guards.
