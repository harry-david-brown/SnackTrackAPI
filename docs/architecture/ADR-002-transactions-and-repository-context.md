# ADR 002: Transactions and repository context

**Status:** Accepted

An application use case defines the atomic business boundary. `DatabaseTransactionRunner` opens,
commits, rolls back, and releases a transaction; its callback receives only `DatabaseQueryExecutor`.
Transaction-aware repositories accept that narrow executor or own one cohesive transactional writer,
never a hidden pool reached through another service.

Repository adapters own SQL and row decoding. Database rows enter as unknown fields and are converted
to domain records only after JSON, state, identifier, numeric, and timestamp validation. Migrations
own schema mutation and are immutable after application.

External calls and cache effects do not run inside relational transactions. A use case records the
commit boundary explicitly and performs classified effects afterward.
