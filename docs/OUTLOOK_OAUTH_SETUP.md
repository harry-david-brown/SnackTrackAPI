# Outlook receipt import setup

SnackTrack connects Outlook and Microsoft 365 mailboxes with Microsoft Graph delegated OAuth. This mailbox consent is separate from the account used to sign in to SnackTrack.

## Entra app registration

1. Create an app registration in Microsoft Entra ID.
2. Choose the supported account types appropriate for the deployment. SnackTrack uses the `common` authority by default so both organizational and personal Microsoft accounts can authorize when the registration permits them.
3. Add a **Web** redirect URI that exactly matches `MICROSOFT_MAIL_REDIRECT_URI`, for example `https://api.example.com/outlook/callback`.
4. Add the Microsoft Graph **delegated** permission `Mail.Read`. Do not use application mail permissions; receipt access is always tied to the signed-in user's explicit consent.
5. Create a client secret for the API and store it only in the server environment.

## API environment

Set these values on the API:

```text
MICROSOFT_MAIL_CLIENT_ID=<Entra application client ID>
MICROSOFT_MAIL_CLIENT_SECRET=<Entra client secret>
MICROSOFT_MAIL_REDIRECT_URI=<public API /outlook/callback URL>
MAILBOX_TOKEN_ENCRYPTION_KEY=<at least 32 random characters>
```

The API requests authorization-code flow with PKCE, `offline_access`, and delegated `Mail.Read`. MSAL's serialized token cache is encrypted with AES-256-GCM before PostgreSQL persistence. Changing `MAILBOX_TOKEN_ENCRYPTION_KEY` invalidates existing Outlook connections unless token caches are migrated first.

## Runtime behavior

- Graph returns message bodies as HTML; the provider adapter converts them to the shared mailbox-message contract used by the existing receipt parser.
- Historical scans use bounded yearly windows back to 2009, exact Graph pagination links, and immutable message IDs.
- Background checks start from the latest successful check or established import/export baseline with the same overlap policy as Gmail.
- Graph throttling honors `Retry-After`; expired or revoked consent becomes a reconnect-required state.
- Disconnecting Outlook removes its encrypted credentials but preserves imported receipts. Account reset and account deletion remove Outlook credentials, sync history, and import state.

## Deployment check

Authorize both a Microsoft personal mailbox and an organizational Microsoft 365 mailbox if both account types are enabled. Verify connection, import, ongoing tracking, reconnect after revocation, disconnect, and account reset before production rollout.
