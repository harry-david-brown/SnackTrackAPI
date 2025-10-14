# Frontend Updates Required - Authentication Implementation

**Date:** October 12, 2025  
**Backend Status:** ✅ Complete and deployed to main  
**Backend Version:** 1.0.0  
**Frontend Status:** ⏳ Awaiting implementation

---

## 🌐 API Configuration

### API Base URL
```typescript
// Development
const API_URL = 'http://localhost:3000';

// Production (update when deployed)
const API_URL = 'https://api.snacktrack.app';  // or your production URL
```

### Environment Variables
```bash
# Frontend .env
EXPO_PUBLIC_API_URL=http://localhost:3000  # Development
# EXPO_PUBLIC_API_URL=https://api.snacktrack.app  # Production
```

### Rate Limiting
- **Upload limit:** 20 uploads per 15 minutes (per user)
- **Registration:** 1,000 per 5 minutes
- **General API:** 10,000 requests per 5 minutes
- Rate limits are per-user when authenticated, per-IP when not
- Frontend should handle 429 errors with retry guidance

### Health Check
- **Endpoint:** `GET /health` (no auth required)
- **Use for:** App startup validation, network connectivity check
- **Response:** `{ status: 'ok', uptime: 123, database: { status: 'connected' } }`

---

## 🟢 NEW FEATURE - ZIP File Upload Support

### ZIP File Upload - Now Supported!

**What Changed:**
- `POST /csv/import` now accepts both `.csv` and `.zip` files
- ZIP files are automatically extracted to find `user_orders-0.csv`
- No changes to request format - just upload ZIP instead of CSV

**Frontend Changes:**
- [ ] Update file picker to allow `.zip` MIME type: `application/zip`
- [ ] Update upload UI text: "Upload your Uber CSV or ZIP file"
- [ ] Update tutorial slides to mention ZIP support
- [ ] Handle ZIP-specific error messages

**Error Messages to Handle:**
```json
{
  "error": "Could not find Uber Eats CSV in ZIP file",
  "hint": "Make sure you uploaded the complete Uber data export ZIP file"
}

{
  "error": "ZIP file is corrupted or invalid"
}

{
  "error": "File size (52.3MB) exceeds maximum allowed size (50MB)"
}
```

**Response Format (Updated):**
```json
{
  "message": "ZIP file processed and receipts imported successfully",
  "importedCount": 202,
  "totalAmount": 1543.25,
  "fileType": "zip"  // or "csv"
}
```

**Backward Compatibility:**
- ✅ Direct CSV uploads still work exactly as before
- ✅ No frontend changes required (ZIP support is optional enhancement)
- ✅ Same response format for both file types

---

## 🔴 BREAKING CHANGES - Required for App to Function

### 1. User Registration - Password Field Required

**Old Endpoint:**
```typescript
POST /users/create
Request: { email: string }
Response: { userId: string, message: string }
```

**New Endpoint:**
```typescript
POST /auth/register
Request: { 
  email: string,
  password: string  // NEW - Required
}
Response: {
  userId: string,
  email: string,
  accessToken: string,      // NEW - Store in AsyncStorage
  refreshToken: string,      // NEW - Store in AsyncStorage
  user: {
    id: string,
    email: string,
    createdAt: string
  }
}
```

**Frontend Changes:**
- [ ] Update sign-up screen UI to include password input field
- [ ] Add password validation:
  - Minimum 8 characters
  - At least 1 uppercase letter
  - At least 1 number
- [ ] Show password visibility toggle
- [ ] Update API call from `/users/create` to `/auth/register`
- [ ] Store `accessToken` and `refreshToken` in AsyncStorage
- [ ] Handle registration errors (duplicate email, weak password)

---

### 2. User Login - New Endpoint Required

**New Endpoint:**
```typescript
POST /auth/login
Request: {
  email: string,
  password: string
}
Response: {
  userId: string,
  email: string,
  accessToken: string,
  refreshToken: string,
  user: {
    id: string,
    email: string,
    createdAt: string
  }
}
```

**Frontend Changes:**
- [ ] Create login screen (if doesn't exist)
- [ ] Add email and password input fields
- [ ] Update API call to `/auth/login`
- [ ] Store tokens in AsyncStorage on successful login
- [ ] Handle login errors (invalid credentials)
- [ ] Add "Forgot Password" UI (backend not implemented yet)

---

### 3. Authentication Headers - Required for ALL API Requests

**Old Behavior:** No authentication required

**New Behavior:** All user-specific endpoints require Authorization header

**Frontend Changes:**
- [ ] Update API client to add Authorization header to all requests
- [ ] Format: `Authorization: Bearer {accessToken}`
- [ ] Retrieve token from AsyncStorage before each request
- [ ] Handle 401 Unauthorized responses (token expired/invalid)
- [ ] Redirect to login screen on 401 errors

**Example API Client Update:**
```typescript
// Before
const response = await fetch(API_URL + '/users/123/totalSpent');

// After
const token = await AsyncStorage.getItem('@snacktrack_auth_token');
const response = await fetch(API_URL + '/users/123/totalSpent', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

---

### 4. Token Management - New Required Logic

**AsyncStorage Keys:**
```typescript
'@snacktrack_auth_token'       // Access token (15min expiry)
'@snacktrack_refresh_token'    // Refresh token (7 day expiry)
'@snacktrack_user_data'         // User object
'@snacktrack_user_id'           // User ID
```

**Frontend Changes:**
- [ ] Store tokens after registration/login
- [ ] Implement token refresh logic (before 15min expiry)
- [ ] Clear tokens on logout
- [ ] Handle token expiration gracefully

---

### 5. Token Refresh - Implement Automatic Refresh

**New Endpoint:**
```typescript
POST /auth/refresh
Request: { refreshToken: string }
Response: {
  accessToken: string,   // New access token
  refreshToken: string   // New refresh token
}
```

**Frontend Changes:**
- [ ] Implement token refresh before access token expires
- [ ] Recommended: Check token expiry on app launch
- [ ] Refresh if token expires within 5 minutes
- [ ] Update stored tokens after refresh
- [ ] Handle refresh failure (force logout)

**Recommended Implementation:**
```typescript
// Check token expiry before each API call
async function getValidToken() {
  const token = await AsyncStorage.getItem('@snacktrack_auth_token');
  const expiresAt = await AsyncStorage.getItem('@snacktrack_token_expires');
  
  if (Date.now() >= expiresAt - 5 * 60 * 1000) {
    // Token expires in < 5 minutes, refresh it
    return await refreshToken();
  }
  
  return token;
}
```

---

### 6. Logout - New Endpoint

**New Endpoint:**
```typescript
POST /auth/logout
Request: { refreshToken: string }
Response: {
  success: boolean,
  message: string
}
```

**Frontend Changes:**
- [ ] Call logout endpoint when user logs out
- [ ] Clear all AsyncStorage authentication data:
  - `@snacktrack_auth_token`
  - `@snacktrack_refresh_token`
  - `@snacktrack_user_data`
  - `@snacktrack_user_id`
- [ ] Clear analytics cache
- [ ] Navigate to login screen

---

### 7. Protected Endpoints - Now Require Authentication

All these endpoints now require Authorization header:

**User Endpoints:**
- `GET /users/:id/totalSpent`
- `POST /users/:id/update-receipts`
- `GET /users/:id/debug/emails`

**Analytics:**
- `GET /validation/user/:userId/summary`

**CSV Upload:**
- `POST /csv/import`

**Error Responses:**
- `401 Unauthorized` - No token or invalid token
- `403 Forbidden` - Valid token but accessing another user's data

**Frontend Changes:**
- [ ] Add Authorization header to all these requests
- [ ] Handle 401 errors (redirect to login)
- [ ] Handle 403 errors (show error message)

---

### 8. Error Handling Updates

**New Error Responses:**

**401 Unauthorized:**
```json
{
  "error": {
    "message": "Access token is required",
    "statusCode": 401,
    "timestamp": "2025-10-12T...",
    "path": "/users/123/totalSpent",
    "method": "GET"
  }
}
```

**403 Forbidden:**
```json
{
  "error": {
    "message": "You do not have permission to access this resource",
    "statusCode": 403,
    "timestamp": "2025-10-12T...",
    "path": "/users/456/totalSpent",
    "method": "GET"
  }
}
```

**Frontend Changes:**
- [ ] Add handling for 401 errors (force logout)
- [ ] Add handling for 403 errors (show error message)
- [ ] Update error parser to handle auth errors
- [ ] Show user-friendly messages:
  - 401: "Your session has expired. Please log in again."
  - 403: "You don't have permission to access this data."

---

## 🟡 UI/UX Updates - Not Breaking but Important

### 1. Registration Screen Updates

**Required UI Elements:**
```
- Email input field
- Password input field (with show/hide toggle)
- Password requirements text:
  * At least 8 characters
  * At least 1 uppercase letter
  * At least 1 number
- Register button
- "Already have an account? Log in" link
```

### 2. Login Screen (New or Updated)

**Required UI Elements:**
```
- Email input field
- Password input field (with show/hide toggle)
- Login button
- "Don't have an account? Sign up" link
- "Forgot password?" link (UI only, backend not ready)
```

### 3. Loading States

**Frontend Changes:**
- [ ] Add loading state for registration
- [ ] Add loading state for login
- [ ] Add loading state for token refresh
- [ ] Show "Logging out..." during logout

### 4. Validation Feedback

**Frontend Changes:**
- [ ] Show real-time password validation feedback
- [ ] Show error messages for invalid credentials
- [ ] Show error message for duplicate email registration
- [ ] Show success message on registration

---

## 📝 Updated API Flow

### First-Time User Journey:
```
1. User opens app
2. Sees login/register screen
3. User taps "Sign up"
4. Enters email + password
5. POST /auth/register
6. Receive tokens + user data
7. Store tokens in AsyncStorage
8. Navigate to dashboard
9. All subsequent API calls include Authorization header
```

### Returning User Journey:
```
1. User opens app
2. Check AsyncStorage for tokens
3. If tokens exist and valid → Go to dashboard
4. If tokens expired → Show login screen
5. User enters email + password
6. POST /auth/login
7. Receive new tokens
8. Store tokens in AsyncStorage
9. Navigate to dashboard
```

---

## 🔧 Migration Strategy

### Phase 1: Backward Compatibility (Temporary)
- Old `/users/create` endpoint still works (no password)
- But these users won't be able to log in later
- **Recommendation:** Don't use old endpoint

### Phase 2: Full Migration (Recommended)
- Update app to use `/auth/register` immediately
- All new users will have passwords
- Old users (without passwords) will need to reset/re-register

---

## 🧪 Testing Checklist

**Registration:**
- [ ] Can register with valid email and strong password
- [ ] Cannot register with duplicate email
- [ ] Cannot register with weak password (< 8 chars)
- [ ] Cannot register with no uppercase letter
- [ ] Cannot register with no number
- [ ] Tokens are stored correctly

**Login:**
- [ ] Can login with correct credentials
- [ ] Cannot login with wrong password
- [ ] Cannot login with non-existent email
- [ ] Tokens are stored correctly
- [ ] Old tokens are replaced

**Token Refresh:**
- [ ] Can refresh token with valid refresh token
- [ ] Cannot refresh with invalid token
- [ ] New tokens are stored correctly

**Protected Routes:**
- [ ] Can access own data with valid token
- [ ] Cannot access without token (401)
- [ ] Cannot access other users' data (403)
- [ ] Token automatically included in requests

**Logout:**
- [ ] Logout clears all tokens
- [ ] Logout navigates to login screen
- [ ] Cannot access protected routes after logout

---

## 📊 AsyncStorage Structure

**After Registration/Login:**
```typescript
{
  '@snacktrack_auth_token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  '@snacktrack_refresh_token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  '@snacktrack_user_id': 'f3e5c3e5-f4eb-46f3-9c8a-6f7a3552e0dd',
  '@snacktrack_user_data': '{"id":"...","email":"...","createdAt":"..."}',
  '@snacktrack_analytics_cache': '...',  // Existing
  '@snacktrack_last_sync': '...',         // Existing
  '@snacktrack_onboarding_completed': '...' // Existing
}
```

---

## 🚨 Important Notes

1. **Token Expiry:** Access tokens expire in 15 minutes. Implement refresh logic!
2. **Security:** Never log or display tokens in production
3. **User Experience:** Auto-refresh tokens in background to avoid interrupting user
4. **Error Handling:** Always handle 401 errors by redirecting to login
5. **Backward Compatibility:** Old `/users/create` is deprecated, update ASAP

---

## 📞 Questions for Backend Team?

If you have questions about:
- Token format or validation
- Error response formats
- Refresh token logic
- Migration strategy
- Testing

Contact: Backend team or refer to API documentation at `/docs`

---

## ✅ Implementation Checklist

### Phase 1: Core Authentication (Required for MVP)
- [ ] Add password field to registration UI
- [ ] Implement registration API call to `/auth/register`
- [ ] Implement login screen and API call
- [ ] Store tokens in AsyncStorage
- [ ] Add Authorization header to API client
- [ ] Handle 401 errors (redirect to login)
- [ ] Implement logout functionality

### Phase 2: Token Management (Required for Production)
- [ ] Implement token refresh logic
- [ ] Auto-refresh before expiry
- [ ] Handle refresh token failures
- [ ] Clear tokens on logout

### Phase 3: Error Handling & UX (Required for Polish)
- [ ] Handle all auth error cases
- [ ] Add loading states
- [ ] Add password validation feedback
- [ ] Add proper error messages
- [ ] Test all edge cases

---

---

## 📚 Quick Reference - All Endpoints

### Authentication Endpoints (No Auth Required)
```
POST /auth/register     - Create new user
POST /auth/login        - Login existing user  
POST /auth/refresh      - Refresh access token
POST /auth/logout       - Logout user
```

### User Endpoints (Auth Required)
```
GET /users/:id/totalSpent              - Get total spending
GET /validation/user/:userId/summary   - Get analytics summary
```

### Upload Endpoints (Auth Required)
```
POST /csv/import  - Upload CSV or ZIP file
```

### System Endpoints (No Auth)
```
GET /              - Basic alive check
GET /health        - Detailed health check
GET /docs          - Swagger API documentation
```

### Response Time Targets
- Registration/Login: < 1 second
- Analytics query: < 2 seconds
- CSV/ZIP import: < 30 seconds (or async)
- Health check: < 100ms

---

**Last Updated:** October 12, 2025  
**Backend Status:** ✅ Complete and deployed to main  
**Backend Version:** 1.0.0  
**Frontend Status:** ⏳ Ready for integration

