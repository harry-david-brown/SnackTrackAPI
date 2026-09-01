# ADR 004: Account reset, clear, and deletion semantics

**Status:** Accepted

Receipt clear, onboarding reset, and account deletion are different contracts:

- Receipt clear preserves identity, provider connection, and consent while removing receipt-derived
  history and baselines.
- Onboarding reset preserves authentication identity and preferences intended for a fresh signed-in
  journey, while clearing imported data, provider credentials, and import activity.
- Account deletion removes the root user and every owned relational record, plus email-keyed records
  not covered by foreign keys.

Each operation acquires the shared writer lock and commits its relational changes atomically. Client
state changes only after server confirmation. Post-commit cleanup cannot make a committed account
deletion appear rolled back. The authoritative table-by-table contract is
`docs/ACCOUNT_DATA_LIFECYCLE.md`.
