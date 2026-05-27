# Gmail Integration

This document describes the current Gmail receipt import integration in the API.

For Google Cloud and env setup, see [docs/GMAIL_OAUTH_SETUP.md](./docs/GMAIL_OAUTH_SETUP.md).

## Overview

SnackTrack supports Gmail receipt import through a frontend-led Google OAuth flow.

- The frontend requests Gmail read access.
- The frontend sends the Google token to the API.
- The API validates the token, confirms the Gmail scope, stores connection state, and later imports receipts from Gmail.

## Current Endpoints

- `POST /gmail/exchange-token`
- `GET /gmail/status`
- `GET /gmail/import/status`
- `POST /gmail/import`
- `POST /gmail/disconnect`

There is no active `/gmail/connect`, `/gmail/callback`, or `/gmail/auth-url` endpoint in the current flow.

## Stored User Fields

The API stores Gmail connection state on the user record:

- `gmail_refresh_token`
- `gmail_access_token`
- `gmail_token_expiry`
- `gmail_connected`
- `gmail_email`
- `gmail_scopes`
- `gmail_connection_mode`

## Connection Modes

Two connection modes are supported:

- `offline`
  - a refresh token is available
  - the API can refresh access and import later without reconnect

- `temporary`
  - only an access token is available
  - the API can import only while that access token remains valid
  - once expired, the user must reconnect Gmail

## Scope Requirements

The API requires a Gmail read-capable scope during connection. The intended scope is:

- `https://www.googleapis.com/auth/gmail.readonly`

`POST /gmail/exchange-token` rejects tokens that do not include a supported Gmail read scope.

## Status Response

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

This allows the frontend to distinguish:

- fully usable Gmail connection
- temporary connection nearing expiry
- expired connection that needs reconnect

## Import Behavior

When `POST /gmail/import` runs:

1. the API checks that Gmail status is importable
2. if refresh token exists, it uses the refresh token
3. otherwise it uses the stored access token only if still valid
4. it searches Gmail for matching receipt emails
5. it extracts and stores receipt data

## Environment Vars

Backend Gmail env vars:

```bash
GMAIL_CLIENT_ID=your_web_oauth_client_id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your_web_oauth_client_secret
GMAIL_REDIRECT_URI=http://localhost:3000/auth/gmail/callback
```

The backend Gmail integration uses the **Web OAuth client** credentials.
