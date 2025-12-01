# Gmail Integration Feature

## Overview

The Gmail Integration feature allows users to connect their Gmail accounts and automatically import Uber Eats receipts directly from their email. This provides an alternative to the CSV upload method and enables automatic receipt tracking.

## Features

- **OAuth 2.0 Authentication**: Secure Gmail connection using Google OAuth
- **Automatic Receipt Detection**: Intelligently identifies Uber Eats receipt emails
- **Receipt Parsing**: Extracts order details, amounts, restaurants, and dates
- **User-Specific Tokens**: Each user has their own Gmail connection
- **Replace or Append**: Choose to replace existing email-based receipts or add new ones

## Architecture

### Components

1. **User Model Extensions** (`src/models/User.ts`)
   - Added Gmail OAuth token storage fields
   - Tracks connection status

2. **Database Schema Updates** (`src/services/data/PostgresService.ts`)
   - New columns: `gmail_refresh_token`, `gmail_access_token`, `gmail_token_expiry`, `gmail_connected`

3. **UserRepository** (`src/services/data/UserRepository.ts`)
   - Methods to manage Gmail tokens
   - Connection status checks

4. **GmailImportService** (`src/services/import/GmailImportService.ts`)
   - Orchestrates the import process
   - Fetches emails, filters receipts, parses data
   - Imports receipts to database

5. **Gmail Routes** (`src/routes/gmail.ts`)
   - OAuth flow endpoints
   - Import trigger endpoint
   - Status and disconnection endpoints

6. **Updated GmailClient** (`src/services/email/GmailClient.ts`)
   - Now supports user-specific tokens
   - Falls back to mock data if no tokens available

## API Endpoints

> **Note:** This API is designed for React Native mobile apps. For complete mobile integration guide, see [MOBILE_INTEGRATION_GUIDE.md](./MOBILE_INTEGRATION_GUIDE.md)

### 1. Get OAuth URL (Mobile)

**GET** `/gmail/auth-url`

Returns the OAuth URL for mobile apps to open in a browser.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "state": "user-id-123"
}
```

---

### 2. Exchange Authorization Code (Mobile)

**POST** `/gmail/exchange-token`

Mobile apps send the authorization code here after OAuth callback.

**Headers:**
```
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "code": "authorization_code_from_google"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Gmail connected successfully",
  "connected": true
}
```

---

### 3. Disconnect Gmail Account

**POST** `/gmail/disconnect`

Removes Gmail OAuth tokens and disconnects the account.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "success": true,
  "message": "Gmail account disconnected successfully"
}
```

---

### 4. Check Connection Status

**GET** `/gmail/status`

Returns whether user has Gmail connected.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "connected": true,
  "email": "user@example.com"
}
```

---

### 5. Import Receipts from Gmail

**POST** `/gmail/import`

Fetches and imports Uber Eats receipts from connected Gmail account.

**Headers:**
```
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "replaceExisting": false
}
```

**Parameters:**
- `replaceExisting` (boolean, optional): If true, deletes existing email-based receipts before import. Default: false

**Response:**
```json
{
  "success": true,
  "totalEmailsFound": 150,
  "totalReceiptsProcessed": 145,
  "totalReceiptsImported": 145,
  "totalAmount": 2450.75,
  "errors": []
}
```

## Setup Instructions

### 1. Configure Gmail OAuth Credentials

You need to create a Google Cloud Project and enable the Gmail API:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the Gmail API
4. Create OAuth 2.0 credentials (Web application)
5. Add authorized redirect URIs:
   - Mobile: `snacktrack://oauth/callback` (or your custom scheme)
   - **Note:** For React Native, use a custom URL scheme for deep linking

📖 **Detailed setup instructions:** [docs/GMAIL_OAUTH_SETUP.md](./docs/GMAIL_OAUTH_SETUP.md)

### 2. Environment Variables

Add the following to your `.env` file:

```env
# Gmail OAuth Configuration
GMAIL_CLIENT_ID=your_client_id_here
GMAIL_CLIENT_SECRET=your_client_secret_here

# Mobile OAuth Redirect URI (for React Native deep linking)
MOBILE_REDIRECT_URI=snacktrack://oauth/callback
```

### 3. Database Migration

The database migration runs automatically on server start. It adds the following columns to the `users` table:

- `gmail_refresh_token` (TEXT)
- `gmail_access_token` (TEXT)
- `gmail_token_expiry` (TIMESTAMP)
- `gmail_connected` (BOOLEAN)

## Usage Flow

### For React Native Apps

1. **Register/Login** to SnackTrack API (get JWT token)
2. **Connect Gmail**:
   - Call `GET /gmail/auth-url` to get OAuth URL
   - Open OAuth URL in system browser or WebView
   - User authorizes on Google OAuth screen
   - App receives deep link callback (`snacktrack://oauth/callback?code=xxx`)
   - Call `POST /gmail/exchange-token` with authorization code
3. **Import Receipts**:
   - Call `POST /gmail/import`
   - Wait for import to complete
   - Receipts are now available via `/receipts` endpoint
4. **View Analytics**:
   - Access Wrapped Analytics or other features
   - Data includes both CSV and Gmail-imported receipts

### Example Mobile Integration

```typescript
// React Native Example
import { Linking } from 'react-native';

// 1. Get OAuth URL from API
const response = await fetch('https://api.snacktrack.com/gmail/auth-url', {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
const { authUrl, state } = await response.json();

// 2. Open OAuth URL in browser
await Linking.openURL(authUrl);

// 3. Listen for deep link callback
Linking.addEventListener('url', async (event) => {
  const url = new URL(event.url);
  const code = url.searchParams.get('code');
  
  if (code) {
    // 4. Exchange code for tokens
    await fetch('https://api.snacktrack.com/gmail/exchange-token', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ code })
    });
    
    // 5. Import receipts
    const importResult = await fetch('https://api.snacktrack.com/gmail/import', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ replaceExisting: false })
    });
    
    const data = await importResult.json();
    console.log(`Imported ${data.totalReceiptsImported} receipts`);
  }
});
```

📱 **Complete React Native guide:** [MOBILE_INTEGRATION_GUIDE.md](./MOBILE_INTEGRATION_GUIDE.md)

## Data Flow

```
User → /gmail/connect → Google OAuth → /gmail/callback → Store Tokens
                                                              ↓
User → /gmail/import → GmailImportService → GmailClient → Fetch Emails
                              ↓
                    EmailFilterService → Filter Receipts
                              ↓
                    ReceiptParserService → Parse Receipts
                              ↓
                    ReceiptService → Save to Database
                              ↓
                    Return Import Results
```

## Security Considerations

1. **Token Storage**: OAuth tokens are stored encrypted in the database
2. **User Isolation**: Each user can only access their own Gmail data
3. **Scope Limitation**: Only requests read-only Gmail access
4. **Token Refresh**: Refresh tokens are used to obtain new access tokens automatically
5. **HTTPS Required**: In production, all OAuth flows must use HTTPS

## Error Handling

The import service handles various error scenarios:

- **No Gmail Connection**: Returns error if user hasn't connected Gmail
- **Email Parsing Errors**: Logs individual email parsing failures, continues with remaining emails
- **Database Errors**: Returns error and doesn't commit partial imports
- **Token Expiry**: Automatically refreshes tokens using refresh token

## Testing

### Mock Data Mode

For development without Gmail credentials, the system automatically uses mock data:

```typescript
// In GmailClient.ts
if (config.shouldUseMockData()) {
  console.log('🧪 Using mock Uber emails for testing.');
  return this.getMockEmails(user);
}
```

### Manual Testing

1. Start the server: `npm run dev`
2. Create a test user: `POST /auth/register`
3. Connect Gmail: `GET /gmail/connect`
4. Import receipts: `POST /gmail/import`
5. View receipts: `GET /receipts?userId=<user_id>`

## Comparison: CSV vs Gmail Import

| Feature | CSV Upload | Gmail Import |
|---------|-----------|--------------|
| **Setup** | Download CSV from Uber | Connect Gmail once |
| **Data Source** | Uber data export | Email receipts |
| **Automation** | Manual upload | Automatic fetch |
| **Frequency** | On-demand | On-demand (can be scheduled) |
| **Data Coverage** | Complete order history | Email history only |
| **Real-time** | No | No (requires trigger) |
| **Privacy** | Upload to server | OAuth read-only access |

## Future Enhancements

- [ ] Automatic scheduled imports
- [ ] Support for other delivery services (DoorDash, Grubhub)
- [ ] Webhook-based real-time imports
- [ ] Email receipt forwarding support
- [ ] Multiple email account support
- [ ] Import history tracking
- [ ] Duplicate detection across sources

## Troubleshooting

### "Gmail account not connected" error

**Solution**: User needs to connect Gmail first via `/gmail/connect`

### "No refresh token received" error

**Solution**: 
- Make sure `prompt: 'consent'` is set in OAuth URL
- User may need to revoke previous authorization and re-authorize
- Check that `access_type: 'offline'` is set

### No emails found

**Solution**:
- Check that user has Uber Eats receipt emails
- Verify Gmail search query in `AppConfig.ts`
- Check email filters are working correctly

### Token expired errors

**Solution**: System should automatically refresh tokens. If not working, check:
- Refresh token is stored correctly
- Gmail OAuth credentials are valid
- User hasn't revoked access

## Support

For issues or questions about the Gmail Integration feature:

1. Check the logs for detailed error messages
2. Verify Gmail OAuth credentials are configured correctly
3. Test with mock data mode first
4. Check database migrations ran successfully

## License

This feature is part of SnackTrack API and follows the same license.

