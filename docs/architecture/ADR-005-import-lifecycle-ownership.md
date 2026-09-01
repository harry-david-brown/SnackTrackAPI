# ADR 005: Import lifecycle ownership

**Status:** Accepted

`user_import_preferences` owns Gmail baseline, tracking consent, and tracking activity.
`user_export_provider_preferences` is the sole authority for each Uber Eats or DoorDash export
lifecycle. `gmail_sync_runs` records individual mailbox executions; import events provide the audit
trail; receipt queries provide source coverage truth.

Application services issue lifecycle commands and query services assemble public projections.
Routes and the frontend do not infer a second state machine. The app's import-preferences query is the
single server-state owner for connection health, lifecycle, consent, source coverage, and reconnect
requirements.

Migration 003 expanded and backfilled provider-specific state. Migration 005 removed the obsolete
aggregate export columns after every caller moved, completing the coordinated contract migration.
