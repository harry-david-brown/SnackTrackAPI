# Frontend Integration Notes - Mobile App Updates

**Date:** October 14, 2025  
**Frontend Version:** Latest (commit b82f890)  
**Backend API:** Snack Track API v1.0

---

## 📱 Frontend Changes Summary

The React Native mobile app has been updated with full JWT authentication support and several performance/UX improvements.

### ✅ What's New in the Frontend

1. **JWT Authentication** - Password-based login/register with secure token management
2. **Automatic Token Refresh** - Tokens refresh every 15 minutes in background
3. **ZIP File Upload** - Accepts both CSV and ZIP files (relies on backend auto-extraction)
4. **Authorization Headers** - Automatically added to all protected API calls
5. **Session Management** - Persistent login with AsyncStorage
6. **Error Handling** - Silent error handling, user-friendly messages only
7. **Performance** - Optimized to prevent duplicate API calls

---

## 🔐 Authentication Flow (Frontend → Backend)

### User Registration
```
Frontend Action:
POST /auth/register
{
  "email": "user@example.com",
  "password": "Password123"
}

Expected Backend Response (201):
{
  "userId": "uuid",
  "email": "user@example.com",
  "accessToken": "jwt...",
  "refreshToken": "jwt...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "createdAt": "2025-10-14T..."
  }
}

Frontend Action After Success:
- Stores tokens in AsyncStorage
- Stores user data
- Navigates to dashboard
- Fetches initial analytics
```

### User Login
```
Frontend Action:
POST /auth/login
{
  "email": "user@example.com",
  "password": "Password123"
}

Expected Backend Response (200):
{
  "userId": "uuid",
  "email": "user@example.com",
  "accessToken": "jwt...",
  "refreshToken": "jwt...",
  "user": {...}
}

Frontend Action After Success:
- Stores tokens in AsyncStorage
- Fetches user's totalSpent
- Navigates to dashboard
```

### Token Refresh
```
Frontend Action (automatic, every 15 min):
POST /auth/refresh
{
  "refreshToken": "jwt..."
}

Expected Backend Response (200):
{
  "accessToken": "new-jwt...",
  "refreshToken": "new-jwt..."
}

Frontend Action After Success:
- Updates tokens in AsyncStorage
- Retries original failed request with new token
- User sees no interruption
```

### Logout
```
Frontend Action:
POST /auth/logout
{
  "refreshToken": "jwt..."
}

Expected Backend Response (200):
{
  "success": true,
  "message": "Logged out successfully"
}

Frontend Action After Success:
- Clears all tokens from AsyncStorage
- Clears user data
- Navigates to login screen

Note: Frontend will logout even if backend call fails
```

---

## 📋 API Endpoints the Frontend Calls

### Public Endpoints (No Auth Required)
- `GET /health` - Health check
- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `POST /auth/refresh` - Token refresh

### Protected Endpoints (Require Authorization Header)
All requests include: `Authorization: Bearer {accessToken}`

- `GET /users/:userId/totalSpent` - Get user's total spending
- `GET /validation/user/:userId/summary` - Get user analytics
- `POST /csv/import` - Upload CSV/ZIP file
- `POST /auth/logout` - Logout (invalidate tokens)

---

## 🔄 How Frontend Handles 401/403 Errors

### 401 Unauthorized (Token Expired)
```
1. API request fails with 401
2. Frontend intercepts the error
3. Checks if request was to public endpoint:
   - If public (login/register): Show error to user
   - If protected: Attempt token refresh
4. If refresh succeeds:
   - Retry original request with new token
   - User sees no error
5. If refresh fails:
   - Clear all tokens
   - Redirect to login screen
   - Show: "Your session has expired. Please login again."
```

### 403 Forbidden
```
1. API request fails with 403
2. Frontend logs error (dev mode only)
3. Shows user-friendly error message
4. Does NOT attempt token refresh
```

---

## 📦 File Upload Format

### CSV Upload
```
Frontend sends:
POST /csv/import
Content-Type: multipart/form-data

FormData:
- csvFile: File (*.csv)
- userId: string (UUID)

Expected Backend Response (200):
{
  "message": "CSV imported successfully",
  "importedCount": 123,
  "totalAmount": 1234.56,
  "fileType": "csv"
}
```

### ZIP Upload (NEW)
```
Frontend sends:
POST /csv/import
Content-Type: multipart/form-data

FormData:
- csvFile: File (*.zip) ← Note: field name is still "csvFile"
- userId: string (UUID)

Expected Backend Response (200):
{
  "message": "ZIP file processed and receipts imported successfully",
  "importedCount": 123,
  "totalAmount": 1234.56,
  "fileType": "zip"
}

Backend Requirements:
- Accept .zip files
- Auto-extract CSV from ZIP
- Parse and import the CSV
- Return same response format as CSV upload
```

---

## ⚠️ Error Response Format

The frontend expects errors in this format:

### Error Response Structure
```json
{
  "error": "Error message here",
  "statusCode": 400,
  "timestamp": "2025-10-14T...",
  "path": "/auth/register",
  "method": "POST"
}
```

### Common Error Messages the Frontend Handles

**Registration Errors:**
- `"User with this email already exists"` → Shows: "An account with this email already exists. Please login instead."
- Any error with `"password"` → Shows: "Password must be at least 8 characters with 1 uppercase letter and 1 number."

**Login Errors:**
- Any error with `"Invalid"` or `"credentials"` → Shows: "Invalid email or password. Please try again."
- 401 status → Shows: "Invalid email or password. Please try again."

**Upload Errors:**
- File too large → Shows: "File is too large. Maximum size is 10MB."
- Invalid format → Shows: "Invalid file format. Please select a CSV or ZIP file."

**Network Errors:**
- Timeout (10 seconds) → Shows: "Connection timed out. Please check your internet."
- No connection → Shows cached data if available

---

## 🔑 Password Validation (Frontend)

The frontend validates passwords before sending to backend:

**Requirements:**
- Minimum 8 characters
- At least 1 uppercase letter (A-Z)
- At least 1 number (0-9)

**Frontend blocks invalid passwords** - backend should still validate as a security measure.

---

## 🕐 Token Timing

**Frontend Expectations:**
- Access tokens expire in **15 minutes** (backend sets this)
- Refresh tokens valid for **7 days** (backend sets this)
- Frontend checks expiry **60 seconds before** token expires
- Automatic refresh triggered at **14 minutes**

**What Frontend Does:**
1. Decodes JWT `exp` claim to get exact expiry time
2. Checks expiry before every API call
3. If token expires in < 60 seconds: refresh automatically
4. If refresh fails: logout and show session expired message

---

## 📊 API Call Patterns

### On Login
```
1. POST /auth/login
2. GET /users/{userId}/totalSpent
3. GET /validation/user/{userId}/summary
```

### On Dashboard Load/Refresh
```
1. GET /users/{userId}/totalSpent
2. GET /validation/user/{userId}/summary
```

### On CSV/ZIP Upload
```
1. POST /csv/import
2. GET /users/{userId}/totalSpent (to refresh total)
3. Navigate to Wrapped Journey
4. GET /validation/user/{userId}/summary (when returning to dashboard)
```

### On Token Expiry (Automatic)
```
1. Original API call fails with 401
2. POST /auth/refresh
3. Retry original API call with new token
```

---

## 🐛 Known Frontend Behaviors Backend Should Handle

### 1. Frontend Uses Same Field Name for CSV and ZIP
```
FormData field: "csvFile"
Actual file: Could be .csv OR .zip

Backend should:
- Check file extension or MIME type
- Handle both formats in the same endpoint
```

### 2. Frontend Retries Failed Requests After Token Refresh
```
If a request fails with 401:
- Frontend refreshes token
- Frontend RETRIES the exact same request
- Backend might receive duplicate requests (rare race condition)

Backend should:
- Be idempotent where possible
- Handle duplicate requests gracefully
```

### 3. Frontend Expects Specific Response Fields
```
Registration/Login MUST return:
- userId (string, UUID)
- email (string)
- accessToken (string, JWT)
- refreshToken (string, JWT)
- user (object with id, email, createdAt)

Token Refresh MUST return:
- accessToken (string, JWT)
- refreshToken (string, JWT)

CSV/ZIP Upload MUST return:
- message (string)
- importedCount (number)
- totalAmount (number)
- fileType (string: "csv" or "zip")
```

---

## 🔍 Testing Checklist for Backend

### Authentication
- [ ] POST /auth/register with valid password → Returns tokens
- [ ] POST /auth/register with duplicate email → Returns 400/409
- [ ] POST /auth/login with correct credentials → Returns tokens
- [ ] POST /auth/login with wrong password → Returns 401
- [ ] POST /auth/refresh with valid token → Returns new tokens
- [ ] POST /auth/refresh with invalid token → Returns 401
- [ ] POST /auth/logout → Invalidates refresh token

### Authorization
- [ ] Protected endpoints without token → Return 401
- [ ] Protected endpoints with valid token → Return data
- [ ] Protected endpoints with expired token → Return 401
- [ ] JWT expiry is set to 15 minutes
- [ ] Refresh token expiry is set to 7 days

### File Upload
- [ ] POST /csv/import with CSV file → Processes successfully
- [ ] POST /csv/import with ZIP file → Extracts and processes CSV
- [ ] POST /csv/import without auth → Returns 401
- [ ] POST /csv/import with invalid file → Returns 400
- [ ] Response includes importedCount, totalAmount, fileType

### Error Handling
- [ ] All errors return JSON with "error" field
- [ ] 401 errors don't expose sensitive information
- [ ] 500 errors have generic message for production

---

## 💡 Recommendations for Backend Team

### 1. Token Expiry
```
Current: 15 minutes (access), 7 days (refresh)
This works well - no changes needed
Frontend handles refresh automatically at 14 minutes
```

### 2. Error Messages
```
Be specific but secure:
✅ "Invalid email or password" (don't reveal which is wrong)
✅ "User with this email already exists"
❌ "Password is incorrect" (reveals email exists)
❌ Internal error details in production
```

### 3. ZIP File Handling
```
Frontend sends ZIP files to same endpoint as CSV
Backend should:
1. Check file extension/MIME type
2. If ZIP: extract, find CSV, process
3. If CSV: process directly
4. Return same response format for both
```

### 4. Rate Limiting (Recommended)
```
Consider rate limiting:
- Login: 5 attempts per 15 minutes per IP
- Registration: 3 attempts per hour per IP
- Token refresh: 10 per hour per user
- File upload: 5 per hour per user
```

---

## 📈 Frontend Performance Notes

### Caching
```
Frontend caches analytics data for 15 minutes
If API call fails, shows cached data with message:
"Showing cached data. Pull to refresh when online."

Backend impact:
- Reduces unnecessary API calls
- Users might not see real-time updates immediately
```

### Offline Support
```
Frontend queues operations when offline (future feature)
Currently: Shows cached data or error message
```

### Request Deduplication
```
Frontend prevents duplicate summary requests on:
- Login
- Dashboard refresh
- Returning from other screens

Backend should still handle rare duplicate requests
```

---

## 🚀 Production Readiness

### Frontend is Ready When:
- ✅ All authentication flows tested
- ✅ Token refresh tested (15+ minutes)
- ✅ ZIP upload tested with real files
- ✅ Error handling tested (network failures)
- ✅ Session persistence tested (app restart)

### Backend Should Ensure:
- [ ] HTTPS enabled (production)
- [ ] CORS configured for mobile app
- [ ] Rate limiting enabled
- [ ] Token blacklist on logout (optional but recommended)
- [ ] Error logging/monitoring
- [ ] ZIP file extraction secure (validate contents)
- [ ] File size limits enforced
- [ ] Malicious file detection

---

## 📞 Frontend Team Contact

**Mobile App Repository:** https://github.com/harry-david-brown/SnackTrackApp  
**Latest Commit:** b82f890  
**Test Coverage:** 46/46 tests passing  
**TypeScript:** 0 errors  

**Key Files:**
- `services/authApi.ts` - Auth API calls
- `services/api.ts` - Main API client with interceptors
- `utils/tokenManager.ts` - Token storage/management
- `contexts/UserContext.tsx` - Auth state management

---

**Last Updated:** October 14, 2025  
**Status:** Production-Ready Frontend ✅

