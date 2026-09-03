# OAuth, health, and app readiness

Read this reference for authorization URLs, callback state, requested scopes, token persistence, reconnection, health checks, or the app's return from the browser.

## Authorization contract

- Bind signed state to authenticated user identity, an allowlisted app redirect URI, and a narrow purpose such as receipt import, export-ready alerts, ongoing tracking, recovery, or connection management.
- Validate required mailbox scopes from the returned grant before persisting success.
- Persist access/refresh tokens, expiry, scopes, mailbox identity, provider, and connection mode before redirecting the browser to the app.
- Prefer durable/offline access only when the user chose a feature that needs it. A temporary access token may support a one-time action but cannot silently authorize background monitoring.

## Credential health

- Invalidate cached health immediately after connect, refresh, reconnect, or disconnect.
- Cache successful validation briefly to control provider traffic; allow explicit preflight to force validation before enabling ongoing access.
- Invalid/revoked grants transition the affected provider to reconnect-required and stop its background eligibility while preserving imported receipts and known non-secret identity where the product requires it.
- Provider timeout/outage is `unavailable`, not reconnect-required. Preserve credentials and offer retry.

## OAuth return race

The server callback commits the connection before issuing its success redirect. The app's import-preferences query may already be in flight from before authorization and can finish afterward with a stale `disconnected` projection.

After callback success:

1. refresh the authoritative provider/import-preferences projection;
2. tolerate null or disconnected pre-callback results with a short bounded retry;
3. accept success only when the returned provider connection is usable for the requested purpose;
4. stop immediately for an explicit callback error or durable reconnect-required result; and
5. update the canonical query cache so the modal, checklist, and dashboard converge on the same response.

Do not show “authorization failed” solely because the first post-callback read was stale. Do not hide a genuine provider denial by polling indefinitely.
