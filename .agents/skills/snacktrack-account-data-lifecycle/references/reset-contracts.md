# Reset contracts

Classify the request before changing code.

| Operation | Preserve | Delete/reset |
| --- | --- | --- |
| Disconnect Gmail | Account, receipts, export history | Gmail credentials; revoke Gmail-dependent background consent/runtime |
| Clear receipts | Account and provider connection only if product explicitly says so | All receipt rows and receipt-derived analytics; reconcile import/export completion |
| Fresh-account/onboarding reset | Login identity, authentication/session, profile essentials such as verified email and timezone | All receipts, analytics, provider credentials, import/export lifecycle, monitoring/tracking consent and runtime, sync history, import audit/funnel events, export-ready/device handoff state, upsell history, and affected caches |
| Delete account/privacy deletion | Nothing unless retention law/policy requires it | User and all dependent data, sessions/tokens, provider access, device caches where addressable |

## Required discovery

For the selected operation, inventory:

- `users` provider credential and connection columns;
- `receipts` across every `data_source`;
- `user_import_preferences` and consent timestamps;
- `gmail_sync_runs` and `user_import_preference_events`;
- server analytics/summary caches;
- app query keys for analytics, wrapped, receipts, import preferences, and Gmail status;
- AsyncStorage/SecureStore keys for analytics, onboarding, export handoff, ready notifications, upsell state, and other feature-specific progress;
- timers, schedulers, external batch endpoints, and in-flight uploads/imports;
- any additional tables found by foreign keys or `user_id` searches.

Do not delete authentication tokens or the `users` row during a fresh-account reset. Do not preserve provider refresh/access tokens, consent, or imported rows merely because they live outside the onboarding UI.

## Fresh-state postconditions

- Receipt count is zero for every source.
- Summary totals are zero and dashboard insights are empty when freshly recomputed.
- Wrapped/summary readiness is false.
- Gmail is disconnected with no access/refresh token, provider email, scopes, or durable connection mode.
- Monitoring and ongoing tracking are not offered/inactive, with no eligible scheduler row.
- Gmail import is `never_started`; export is `not_started`.
- Sync and import-event history is empty when “brand new account” semantics require it.
- App caches cannot render pre-reset data.
- Login remains valid and the user lands in the initial import/onboarding experience.
