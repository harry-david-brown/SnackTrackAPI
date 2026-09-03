# Manual verification after the architecture refactor

These checks require credentials, external services, or a physical/simulator device. They are acceptance checks, not missing implementation work.

## Mobile session and account lifecycle

- Register, log in, refresh a session after the access token expires, log out, and relaunch on both iOS and Android.
- Force a temporary network failure during refresh and account deletion; confirm the signed-in session and local data remain intact.
- Complete receipt clearing and onboarding reset; confirm the session remains, affected receipts/import state disappear, and the fresh authenticated journey opens.
- Complete account deletion; confirm auth, user-bound device state, and server resources disappear only after success.

## Gmail and import lifecycle

- Connect Gmail with durable consent, cancel once at Google, reconnect, and verify callback navigation for historical import, tracking, and connection recovery.

## Outlook and Microsoft Graph

- Connect Outlook with delegated `Mail.Read`, cancel once at Microsoft, and verify callback recovery without changing the user's SnackTrack login identity.
- Import from a personal Outlook.com mailbox and, when enabled in Entra, an organizational Microsoft 365 mailbox. Confirm HTML receipt bodies enter the shared parser and duplicates already imported from Gmail remain unchanged.
- Revoke the Entra grant, confirm the next validation reports reconnect required, reconnect, then verify manual import and ongoing tracking resume.
- Disconnect Outlook and verify imported receipts remain. Run onboarding reset and verify Outlook credentials, import state, and sync history are removed while SnackTrack login remains active.
- Run a historical import, an immediate concurrent import, a manual tracking check, disconnect, and reconnect. Confirm busy, retry, and reconnect states match the canonical error codes.
- Upload representative Uber Eats and DoorDash CSV/ZIP exports and confirm source coverage, receipts, analytics, dashboard insights, and export handoff state refresh only after success.
- Exercise the provider-specific endpoints and the malicious/oversized ZIP, CSV, and mailbox cases listed in `docs/IMPORT_INPUT_SECURITY.md`; confirm rejected imports leave existing receipts unchanged.
- Revoke the Google grant externally and verify the next forced health check produces reconnect-required without deleting prior receipts.

## Deployed infrastructure

- Run migrations against a production-shaped staging backup and verify the schema checksum table, converted receipt-item JSON, and import lifecycle rows.
- With at least two API processes, contend on the same Redis-backed user lock and verify only one receipt writer commits; verify different users proceed independently.
- Exercise readiness and graceful shutdown while PostgreSQL or Redis is unavailable and confirm structured, redacted telemetry and one-time resource closure.
- Send password-reset and verification messages through the configured delivery provider and confirm expiry, attempt limits, and atomic code consumption.
