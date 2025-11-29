# API vs React Native UI - Responsibilities

## 🎯 Quick Answer

**Your Express API should handle:**
- All data storage and business logic
- OAuth token management
- Gmail API calls
- Receipt parsing
- Security and validation

**Your React Native app should handle:**
- User interface and navigation
- Initiating API calls
- Displaying data and results
- User interactions
- OAuth flow UI (browser/WebView)

---

## 📊 Detailed Breakdown

### ✅ API Responsibilities (Backend)

#### 1. **Data & Storage**
- ✅ Store user data in PostgreSQL
- ✅ Store Gmail OAuth tokens (encrypted in database)
- ✅ Store receipts from all sources (CSV + Email)
- ✅ Manage database migrations
- ✅ Handle data relationships and integrity

#### 2. **Business Logic**
- ✅ Parse Uber Eats receipt emails
- ✅ Extract amounts, dates, restaurants, items
- ✅ Filter emails (identify which are receipts)
- ✅ Calculate analytics and summaries
- ✅ Deduplicate receipts (if needed)

#### 3. **External APIs**
- ✅ Make Gmail API calls
- ✅ Refresh OAuth tokens automatically
- ✅ Handle Gmail API rate limits
- ✅ Parse email content (HTML/text)

#### 4. **Security**
- ✅ Validate JWT tokens
- ✅ Ensure users only access their own data
- ✅ Rate limiting
- ✅ Input validation and sanitization
- ✅ Secure OAuth token storage

#### 5. **API Endpoints Provided**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/register` | POST | Register new user |
| `/auth/login` | POST | Login user |
| `/gmail/auth-url` | GET | Get OAuth URL (mobile) |
| `/gmail/connect` | GET | Redirect to OAuth (web) |
| `/gmail/exchange-token` | POST | Exchange OAuth code (mobile) |
| `/gmail/callback` | GET | Handle OAuth callback (web) |
| `/gmail/status` | GET | Check connection status |
| `/gmail/import` | POST | Trigger receipt import |
| `/gmail/disconnect` | POST | Disconnect Gmail |
| `/receipts` | GET | Get all receipts |
| `/users/:id/summary` | GET | Get analytics |
| `/csv/import` | POST | Upload CSV/ZIP |

---

### 📱 React Native Responsibilities (Frontend)

#### 1. **User Interface**
```typescript
// Your React Native app handles:
- Login/Registration screens
- Settings screen with "Connect Gmail" button
- Connection status display ("✅ Connected" / "❌ Not Connected")
- Import button and progress indicators
- Receipt list view
- Analytics/dashboard screens
- Error messages and success notifications
```

#### 2. **OAuth Flow** (Mobile-Specific)

**Option A: Deep Linking (Recommended)**
```typescript
// 1. Get OAuth URL from API
const response = await fetch('https://api.snacktrack.com/gmail/auth-url', {
  headers: { 'Authorization': `Bearer ${userToken}` }
});
const { authUrl } = await response.json();

// 2. Open system browser
await Linking.openURL(authUrl);

// 3. Listen for deep link callback
Linking.addEventListener('url', (event) => {
  const code = extractCode(event.url); // Extract from snacktrack://oauth/callback?code=xxx
  
  // 4. Send code to API
  await fetch('https://api.snacktrack.com/gmail/exchange-token', {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code })
  });
});
```

**Option B: WebView (Alternative)**
```typescript
// Open OAuth in WebView, intercept callback URL
<WebView
  source={{ uri: authUrl }}
  onNavigationStateChange={(navState) => {
    if (navState.url.includes('callback')) {
      const code = extractCode(navState.url);
      // Send to API
    }
  }}
/>
```

#### 3. **API Calls**
```typescript
// Your React Native app calls these endpoints:

// Check if Gmail is connected
const checkStatus = async () => {
  const res = await fetch('/gmail/status', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const { connected } = await res.json();
  setIsConnected(connected);
};

// Import receipts
const importReceipts = async () => {
  setLoading(true);
  const res = await fetch('/gmail/import', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ replaceExisting: false })
  });
  const result = await res.json();
  setLoading(false);
  
  // Show result to user
  Alert.alert('Success', `Imported ${result.totalReceiptsImported} receipts`);
};

// Get receipts
const getReceipts = async () => {
  const res = await fetch(`/receipts?userId=${userId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const { receipts } = await res.json();
  setReceipts(receipts);
};
```

#### 4. **State Management**
```typescript
// Your React Native app manages:
- User authentication state (access token)
- Gmail connection status
- Loading states
- Error states
- Receipt data (fetched from API)
- Analytics data (fetched from API)
```

#### 5. **User Feedback**
```typescript
// Your React Native app displays:
- Loading spinners during API calls
- Success messages ("Gmail connected!")
- Error messages ("Connection failed. Try again.")
- Import progress ("Importing receipts...")
- Import results ("Imported 45 receipts, $1,234.56")
```

---

## 🔄 Complete User Flow Example

### Gmail Connection Flow

**React Native:**
```typescript
1. User taps "Connect Gmail" button
2. App calls GET /gmail/auth-url
3. App receives OAuth URL
4. App opens URL in browser
5. User authorizes on Google
6. Browser redirects to snacktrack://oauth/callback?code=xxx
7. App receives deep link
8. App extracts code
9. App calls POST /gmail/exchange-token with code
10. App receives success response
11. App shows "✅ Gmail Connected!" message
12. App enables "Import Receipts" button
```

**API:**
```typescript
1. Receives GET /gmail/auth-url
2. Generates OAuth URL with Google
3. Returns URL to app
4. [User authorizes on Google...]
5. Receives POST /gmail/exchange-token with code
6. Exchanges code with Google for tokens
7. Stores tokens in database (user_id, refresh_token, access_token)
8. Returns success response
```

### Receipt Import Flow

**React Native:**
```typescript
1. User taps "Import Receipts" button
2. App shows loading spinner
3. App calls POST /gmail/import
4. App waits for response (may take 10-30 seconds)
5. App receives import results
6. App hides loading spinner
7. App shows "Imported 45 receipts ($1,234.56)" alert
8. App refreshes receipt list
```

**API:**
```typescript
1. Receives POST /gmail/import
2. Gets user's Gmail tokens from database
3. Calls Gmail API to fetch emails
4. Filters emails to find Uber Eats receipts
5. Parses each receipt email:
   - Extract amount: $25.99
   - Extract restaurant: "McDonald's"
   - Extract date: "2024-03-15"
   - Extract items: ["Big Mac", "Fries"]
6. Saves receipts to database
7. Invalidates cache
8. Returns results (totalReceiptsImported, totalAmount, etc.)
```

---

## 🚫 What NOT to Do

### ❌ Don't Put in React Native:
- ❌ Gmail API credentials (client secret)
- ❌ Database queries
- ❌ Receipt parsing logic
- ❌ OAuth token storage
- ❌ Business logic calculations

### ❌ Don't Put in API:
- ❌ UI components (buttons, screens, navigation)
- ❌ User interaction logic
- ❌ Deep link handling
- ❌ Platform-specific code (iOS/Android)
- ❌ UI state management (loading spinners, etc.)

---

## 📱 Example React Native Component

```typescript
// GmailSettingsScreen.tsx
import React, { useState, useEffect } from 'react';
import { View, Text, Button, Alert, ActivityIndicator } from 'react-native';
import { useAuth } from './hooks/useAuth'; // Your auth hook

const API_URL = 'https://your-api.com';

export const GmailSettingsScreen = () => {
  const { accessToken } = useAuth();
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/gmail/status`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await res.json();
      setConnected(data.connected);
    } catch (error) {
      console.error('Failed to check status:', error);
    }
  };

  const connectGmail = async () => {
    try {
      setLoading(true);
      
      // 1. Get OAuth URL from API
      const res = await fetch(`${API_URL}/gmail/auth-url`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const { authUrl } = await res.json();
      
      // 2. Open in browser (implement deep link handling separately)
      await Linking.openURL(authUrl);
      
    } catch (error) {
      Alert.alert('Error', 'Failed to connect Gmail');
    } finally {
      setLoading(false);
    }
  };

  const importReceipts = async () => {
    try {
      setLoading(true);
      
      const res = await fetch(`${API_URL}/gmail/import`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ replaceExisting: false })
      });
      
      const data = await res.json();
      
      Alert.alert(
        'Import Complete',
        `Imported ${data.totalReceiptsImported} receipts\n` +
        `Total: $${data.totalAmount.toFixed(2)}`
      );
      
    } catch (error) {
      Alert.alert('Error', 'Failed to import receipts');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ padding: 20 }}>
      <Text style={{ fontSize: 24, marginBottom: 20 }}>Gmail Integration</Text>
      
      <View style={{ marginBottom: 20 }}>
        <Text>Status: {connected ? '✅ Connected' : '❌ Not Connected'}</Text>
      </View>
      
      {loading && <ActivityIndicator size="large" />}
      
      {!connected ? (
        <Button title="Connect Gmail" onPress={connectGmail} disabled={loading} />
      ) : (
        <>
          <Button title="Import Receipts" onPress={importReceipts} disabled={loading} />
          <View style={{ height: 10 }} />
          <Button title="Disconnect" onPress={disconnectGmail} color="red" disabled={loading} />
        </>
      )}
    </View>
  );
};
```

---

## 🎯 Summary

| Concern | API | React Native |
|---------|-----|--------------|
| **OAuth Tokens** | Store & manage | Initiate flow only |
| **Gmail API** | Make calls | Never touches |
| **Receipt Parsing** | Parse & validate | Display results |
| **Database** | All CRUD operations | Read via API only |
| **Security** | Enforce | Send JWT token |
| **UI/UX** | None | Everything |
| **Business Logic** | All calculations | None |
| **User Feedback** | None | Loading, errors, success |

---

## 📚 Documentation

- **Mobile Integration:** [MOBILE_INTEGRATION_GUIDE.md](./MOBILE_INTEGRATION_GUIDE.md)
- **API Reference:** [GMAIL_INTEGRATION.md](./GMAIL_INTEGRATION.md)
- **Setup Guide:** [docs/GMAIL_OAUTH_SETUP.md](./docs/GMAIL_OAUTH_SETUP.md)

The API is a **stateless backend** that handles data and logic.  
React Native is a **presentation layer** that handles UI and user interactions.

Keep them separated, communicate via HTTP/REST, and you'll have a clean, maintainable architecture! 🚀

