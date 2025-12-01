# React Native + Gmail OAuth Integration Guide

## 🎯 Architecture Overview

```
React Native App (UI)          SnackTrack API (Backend)
     │                                  │
     │  1. GET /gmail/auth-url         │
     ├────────────────────────────────>│
     │  2. Returns OAuth URL            │
     │<────────────────────────────────┤
     │                                  │
     │  3. Opens system browser         │
     │     with OAuth URL               │
     │                                  │
     │  4. User authorizes on Google    │
     │                                  │
     │  5. Google redirects with code   │
     │     (deep link to app)           │
     │                                  │
     │  6. POST /gmail/exchange-token   │
     │     { code: "..." }              │
     ├────────────────────────────────>│
     │  7. API exchanges code for       │
     │     tokens and stores them       │
     │<────────────────────────────────┤
     │                                  │
```

---

## 🔧 API Changes Needed

### Add New Mobile-Friendly Endpoint

Create **`GET /gmail/auth-url`** to return OAuth URL (instead of redirecting):

```typescript
// In src/routes/gmail.ts

/**
 * GET /gmail/auth-url
 * Returns OAuth URL for mobile apps (no redirect)
 */
router.get('/auth-url', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  
  if (!userId) {
    throw new ValidationError('User ID not found');
  }

  const oAuth2Client = getOAuth2Client();
  
  // For mobile apps, use custom scheme for redirect
  const mobileRedirectUri = process.env.MOBILE_REDIRECT_URI || 'snacktrack://oauth/callback';
  
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state: userId, // Pass userId to identify user after callback
    redirect_uri: mobileRedirectUri // Mobile deep link
  });

  res.json({
    authUrl,
    state: userId
  });
}));
```

### Add Token Exchange Endpoint

Create **`POST /gmail/exchange-token`** for mobile to send authorization code:

```typescript
/**
 * POST /gmail/exchange-token
 * Exchange authorization code for tokens (mobile flow)
 */
router.post('/exchange-token', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.body;
  const userId = req.user?.userId;

  if (!code || !userId) {
    throw new ValidationError('Missing authorization code or user ID');
  }

  try {
    const oAuth2Client = getOAuth2Client();
    
    // Override redirect URI to match mobile deep link
    const mobileRedirectUri = process.env.MOBILE_REDIRECT_URI || 'snacktrack://oauth/callback';
    oAuth2Client.redirectUri = mobileRedirectUri;
    
    // Exchange code for tokens
    const { tokens } = await oAuth2Client.getToken(code);
    
    if (!tokens.refresh_token) {
      throw new Error('No refresh token received');
    }

    // Store tokens in database
    const userRepository = container.userRepository;
    const expiryDate = tokens.expiry_date 
      ? new Date(tokens.expiry_date) 
      : new Date(Date.now() + 3600 * 1000);
    
    await userRepository.updateGmailTokens(
      userId,
      tokens.refresh_token,
      tokens.access_token || '',
      expiryDate
    );

    console.log(`✅ Gmail connected for user: ${userId}`);

    res.json({
      success: true,
      message: 'Gmail connected successfully',
      connected: true
    });
  } catch (error) {
    console.error('Token exchange error:', error);
    throw new ValidationError('Failed to connect Gmail. Please try again.');
  }
}));
```

---

## 📱 React Native Implementation

### 1. Install Dependencies

```bash
npm install react-native-app-auth
# or
expo install expo-auth-session expo-web-browser
```

### 2. Configure Deep Linking

**For bare React Native:**

```javascript
// app.json
{
  "scheme": "snacktrack"
}
```

**For Expo:**

```javascript
// app.json
{
  "expo": {
    "scheme": "snacktrack"
  }
}
```

### 3. Gmail Connection Component

```typescript
import React, { useState } from 'react';
import { View, Button, Text, Linking, Alert } from 'react-native';
import * as WebBrowser from 'expo-web-browser'; // For Expo
// or import { Linking } from 'react-native'; // For bare RN

const API_URL = 'https://your-api.com'; // Your API URL

export const GmailConnectionScreen = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accessToken, setAccessToken] = useState(''); // Get from your auth state

  // Check connection status on mount
  useEffect(() => {
    checkConnectionStatus();
    
    // Listen for deep link (authorization callback)
    const subscription = Linking.addEventListener('url', handleDeepLink);
    
    return () => subscription.remove();
  }, []);

  const checkConnectionStatus = async () => {
    try {
      const response = await fetch(`${API_URL}/gmail/status`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      const data = await response.json();
      setIsConnected(data.connected);
    } catch (error) {
      console.error('Failed to check Gmail status:', error);
    }
  };

  const connectGmail = async () => {
    try {
      setLoading(true);
      
      // 1. Get OAuth URL from API
      const response = await fetch(`${API_URL}/gmail/auth-url`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      
      const { authUrl, state } = await response.json();
      
      // 2. Open OAuth URL in system browser
      // For Expo:
      await WebBrowser.openBrowserAsync(authUrl);
      
      // For bare React Native:
      // await Linking.openURL(authUrl);
      
      // Note: The callback will be handled by handleDeepLink
      
    } catch (error) {
      console.error('Failed to initiate Gmail connection:', error);
      Alert.alert('Error', 'Failed to connect Gmail');
    } finally {
      setLoading(false);
    }
  };

  const handleDeepLink = async ({ url }) => {
    // URL format: snacktrack://oauth/callback?code=xxx&state=xxx
    
    const params = new URL(url).searchParams;
    const code = params.get('code');
    const state = params.get('state');
    
    if (!code) {
      Alert.alert('Error', 'Authorization failed');
      return;
    }
    
    try {
      // 3. Send authorization code to API
      const response = await fetch(`${API_URL}/gmail/exchange-token`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code })
      });
      
      const data = await response.json();
      
      if (data.success) {
        setIsConnected(true);
        Alert.alert('Success', 'Gmail connected successfully!');
      } else {
        Alert.alert('Error', 'Failed to connect Gmail');
      }
    } catch (error) {
      console.error('Token exchange error:', error);
      Alert.alert('Error', 'Failed to connect Gmail');
    }
  };

  const importReceipts = async () => {
    try {
      setLoading(true);
      
      const response = await fetch(`${API_URL}/gmail/import`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          replaceExisting: false
        })
      });
      
      const data = await response.json();
      
      Alert.alert(
        'Import Complete',
        `Imported ${data.totalReceiptsImported} receipts ($${data.totalAmount.toFixed(2)})`
      );
      
    } catch (error) {
      console.error('Import failed:', error);
      Alert.alert('Error', 'Failed to import receipts');
    } finally {
      setLoading(false);
    }
  };

  const disconnectGmail = async () => {
    try {
      setLoading(true);
      
      const response = await fetch(`${API_URL}/gmail/disconnect`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      
      const data = await response.json();
      
      if (data.success) {
        setIsConnected(false);
        Alert.alert('Success', 'Gmail disconnected');
      }
    } catch (error) {
      console.error('Disconnect failed:', error);
      Alert.alert('Error', 'Failed to disconnect Gmail');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ padding: 20 }}>
      <Text style={{ fontSize: 20, marginBottom: 20 }}>
        Gmail Integration
      </Text>
      
      <Text style={{ marginBottom: 10 }}>
        Status: {isConnected ? '✅ Connected' : '❌ Not Connected'}
      </Text>
      
      {!isConnected ? (
        <Button
          title="Connect Gmail"
          onPress={connectGmail}
          disabled={loading}
        />
      ) : (
        <>
          <Button
            title="Import Receipts"
            onPress={importReceipts}
            disabled={loading}
          />
          <Button
            title="Disconnect Gmail"
            onPress={disconnectGmail}
            disabled={loading}
            color="red"
          />
        </>
      )}
    </View>
  );
};
```

---

## 🔐 Environment Configuration

### API (.env)

```bash
# Existing web OAuth (keep for backward compatibility)
GMAIL_CLIENT_ID=your_client_id
GMAIL_CLIENT_SECRET=your_client_secret
GMAIL_REDIRECT_URI=http://localhost:3000/gmail/callback

# NEW: Mobile OAuth
MOBILE_REDIRECT_URI=snacktrack://oauth/callback
```

### Google Cloud Console

Add mobile redirect URI to authorized redirect URIs:
- `snacktrack://oauth/callback`

---

## 📊 Separation of Concerns

### ✅ API Handles:
- OAuth token storage and management
- Gmail API calls
- Receipt parsing and storage
- Security and data validation
- Business logic

### ✅ React Native Handles:
- User interface and navigation
- OAuth flow initiation
- Deep link handling
- Loading states and error messages
- User interactions (buttons, forms)
- Local state management

---

## 🎯 Complete User Flow

1. **User opens Settings → Connect Gmail**
   - UI shows "Connect Gmail" button
   - UI calls `GET /gmail/status` to check if already connected

2. **User taps "Connect Gmail"**
   - UI calls `GET /gmail/auth-url` (gets OAuth URL)
   - UI opens system browser with OAuth URL
   - User authorizes on Google
   - Google redirects to `snacktrack://oauth/callback?code=xxx`

3. **App receives deep link**
   - UI extracts authorization code
   - UI calls `POST /gmail/exchange-token` with code
   - API stores tokens in database
   - UI shows success message

4. **User taps "Import Receipts"**
   - UI calls `POST /gmail/import`
   - API fetches emails, parses receipts, stores in DB
   - API returns import results
   - UI shows "Imported 45 receipts ($1,234.56)"

5. **User views receipts**
   - UI calls `GET /receipts?userId=xxx`
   - API returns all receipts (CSV + email sources)
   - UI displays receipt list

---

## 🔄 Alternative: In-App Browser (Simpler but Less Secure)

If deep linking is too complex, you can use WebView:

```typescript
import { WebView } from 'react-native-webview';

const [showWebView, setShowWebView] = useState(false);
const [authUrl, setAuthUrl] = useState('');

const connectGmail = async () => {
  // Get OAuth URL from API
  const response = await fetch(`${API_URL}/gmail/auth-url`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const { authUrl } = await response.json();
  
  setAuthUrl(authUrl);
  setShowWebView(true);
};

// In render:
{showWebView && (
  <WebView
    source={{ uri: authUrl }}
    onNavigationStateChange={(navState) => {
      // Intercept the callback URL
      if (navState.url.includes('oauth/callback')) {
        const params = new URL(navState.url).searchParams;
        const code = params.get('code');
        
        // Send code to API
        exchangeToken(code);
        setShowWebView(false);
      }
    }}
  />
)}
```

---

## 🧪 Testing

### Test Connection Flow

```bash
# 1. Get auth URL
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/gmail/auth-url

# 2. Open URL in browser, authorize

# 3. Exchange code
curl -X POST http://localhost:3000/gmail/exchange-token \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code": "authorization_code_from_google"}'
```

---

## 📝 Summary

**What API handles:**
- ✅ All OAuth token management
- ✅ All Gmail API calls
- ✅ All receipt parsing and storage
- ✅ All security and validation

**What React Native handles:**
- ✅ User interface
- ✅ OAuth flow initiation
- ✅ Deep link handling
- ✅ Displaying results
- ✅ User feedback

**New API endpoints needed for mobile:**
- `GET /gmail/auth-url` - Returns OAuth URL (no redirect)
- `POST /gmail/exchange-token` - Exchange authorization code

This keeps your API stateless and your mobile app in control of the UI/UX!

