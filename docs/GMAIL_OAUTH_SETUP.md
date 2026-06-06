# Gmail OAuth Setup

This document describes the current Gmail OAuth setup for SnackTrack.

## Current Flow

1. The frontend requests a backend-generated Google auth URL from `POST /gmail/auth-url`.
2. The backend signs OAuth state and returns a Google OAuth URL.
3. The user authenticates with Google.
4. Google redirects to the backend `GET /gmail/callback` route.
5. The backend exchanges the authorization code for tokens, validates Gmail scope access, and stores:
   - `gmail_access_token`
   - optional `gmail_refresh_token`
   - `gmail_token_expiry`
   - `gmail_scopes`
   - `gmail_connection_mode`
6. The backend redirects back to the app callback route.
7. The frontend continues to the upload screen and auto-starts import when appropriate.

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
GMAIL_REDIRECT_URI=http://localhost:3000/gmail/callback
```

Notes:

- `GMAIL_CLIENT_ID` must be the **Web OAuth client ID**.
- `GMAIL_CLIENT_SECRET` must be the matching secret for that same Web OAuth client.
- `GMAIL_REDIRECT_URI` must exactly match the redirect URI configured on that Google OAuth client.
- These env vars are required. The API no longer falls back to placeholder values or localhost-derived callback guesses.

## Frontend Env Vars

The frontend needs its own Google client IDs:

```bash
EXPO_PUBLIC_GMAIL_WEB_CLIENT_ID=your_web_oauth_client_id.apps.googleusercontent.com
EXPO_PUBLIC_GMAIL_IOS_CLIENT_ID=your_ios_client_id.apps.googleusercontent.com
EXPO_PUBLIC_GMAIL_ANDROID_CLIENT_ID=your_android_client_id.apps.googleusercontent.com
```

## Active API Endpoints

- `POST /gmail/auth-url`
- `GET /gmail/callback`
- `GET /gmail/status`
- `GET /gmail/import/status`
- `POST /gmail/import`
- `POST /gmail/disconnect`

## Status Model

`GET /gmail/status` returns:

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

- If Google returns a refresh token, the API stores an `offline` Gmail connection.
- If Google returns only an access token, the API stores a `temporary` Gmail connection.
- If the access token expires and there is no refresh token, the user must reconnect Gmail.
- The API rejects Gmail connections that do not include a supported Gmail read-capable scope.
- The API no longer accepts a separate frontend token exchange step through `/gmail/exchange-token`.
