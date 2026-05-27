# Gmail OAuth Setup

This is the current Gmail setup for SnackTrack.

## Current Flow

1. The frontend requests Google OAuth with `https://www.googleapis.com/auth/gmail.readonly`.
2. Google returns an access token, and sometimes a refresh token.
3. The frontend sends that token to `POST /gmail/exchange-token`.
4. The API verifies the token, checks that a Gmail read scope was granted, and stores:
   - `gmail_access_token`
   - optional `gmail_refresh_token`
   - `gmail_token_expiry`
   - `gmail_scopes`
   - `gmail_connection_mode`
5. `POST /gmail/import` uses:
   - refresh token when available
   - otherwise a still-valid access token

The API does not generate Gmail OAuth URLs anymore. There is no active `/gmail/connect`, `/gmail/callback`, or `/gmail/auth-url` flow.

## Google Cloud Setup

### 1. Enable Gmail API

In Google Cloud Console:

1. Open your project.
2. Go to `APIs & Services -> Library`.
3. Enable `Gmail API`.

### 2. Configure OAuth Consent Screen

In Google Cloud Console:

1. Go to `Google Auth Platform -> Branding / Audience / Data Access`.
2. Configure the app details.
3. Add the Gmail scope:
   - `https://www.googleapis.com/auth/gmail.readonly`
4. If the app is still in testing, add your test users.

### 3. Create OAuth Clients

Create these client IDs:

- Web application client
- iOS client
- Android client

The backend Gmail integration uses the **Web application** client credentials.

## Required Backend Env Vars

```bash
GMAIL_CLIENT_ID=your_web_oauth_client_id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your_web_oauth_client_secret
GMAIL_REDIRECT_URI=http://localhost:3000/auth/gmail/callback
```

Notes:

- `GMAIL_CLIENT_ID` must be the **Web OAuth client ID**.
- `GMAIL_CLIENT_SECRET` must be the matching secret for that same Web OAuth client.
- `GMAIL_REDIRECT_URI` is still part of backend OAuth client construction and should stay set consistently, even though the current frontend-led flow does not rely on backend redirect endpoints.

## Frontend Env Vars

The frontend needs its own Google client IDs:

```bash
EXPO_PUBLIC_GMAIL_WEB_CLIENT_ID=your_web_oauth_client_id.apps.googleusercontent.com
EXPO_PUBLIC_GMAIL_IOS_CLIENT_ID=your_ios_client_id.apps.googleusercontent.com
EXPO_PUBLIC_GMAIL_ANDROID_CLIENT_ID=your_android_client_id.apps.googleusercontent.com
```

## Active API Endpoints

- `POST /gmail/exchange-token`
- `GET /gmail/status`
- `GET /gmail/import/status`
- `POST /gmail/import`
- `POST /gmail/disconnect`

## Status Model

`GET /gmail/status` returns richer state than the old boolean-only response:

- `connected`
- `canImport`
- `needsReconnect`
- `email`
- `connectionMode`
- `scopes`
- `hasRequiredScope`
- `expiresAt`
- `statusMessage`

## Behavior Notes

- If Google only returns an access token, the API stores a `temporary` Gmail connection.
- If a refresh token is available, the API stores an `offline` Gmail connection.
- If the access token expires and there is no refresh token, the user must reconnect Gmail.
- The API rejects Gmail connections that do not include a Gmail read-capable scope.
