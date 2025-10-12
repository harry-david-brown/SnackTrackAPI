# 📱 Frontend App Context for API Development

**Date:** October 11, 2025  
**App:** Snack Track Mobile (React Native/Expo)  
**Purpose:** Technical context for backend API development  
**Audience:** Backend developers working on API production updates

---

## Executive Summary

The Snack Track mobile app is a viral-focused food delivery spending tracker with Spotify Wrapped-style social sharing. The app is designed for a "candle that burns bright and fast" - users upload their data, get roasted with savage analytics, share to social media, then likely churn. The frontend is production-ready for MVP launch pending backend authentication implementation.

---

## Critical API Dependencies

### 🔴 P0 Blockers for Frontend

**1. Authentication System (2 weeks)**
- **Current:** Email-only user creation, no passwords
- **Required:** JWT or session-based auth with secure token storage
- **Frontend Impact:** Need to store auth tokens in AsyncStorage, add Authorization headers to all requests
- **Endpoints Needed:**
  - `POST /auth/login` - Email + password → JWT token
  - `POST /auth/register` - Email + password → JWT token
  - `POST /auth/logout` - Invalidate token
  - `POST /auth/refresh` - Refresh expired tokens

**2. Authorization/Ownership Validation (1 week)**
- **Current:** Any user can access any userId data
- **Required:** All endpoints validate user owns the data they're requesting
- **Frontend Impact:** App already sends userId, backend must validate it matches auth token
- **Critical Routes:**
  - `GET /validation/user/:userId/summary` - Must verify :userId matches token
  - `POST /csv/import` - Must verify userId in request matches token
  - All user-specific endpoints must validate ownership

**3. ZIP File Upload Support (NEW - 3-5 days)**
- **Current:** CSV file upload only
- **Required:** Accept ZIP files, auto-extract `user_orders-0.csv` from Uber data folder
- **File Path:** `/Uber Data Request {hash}/Uber Data/Eats/user_orders-0.csv`
- **Frontend Change:** File picker now allows `.zip` files
- **Backend Change:** 
  - Update Multer to accept `.zip` MIME type
  - Extract ZIP in memory or temp directory
  - Locate and extract `user_orders-0.csv`
  - Process CSV as normal
  - Clean up temp files
- **Error Handling:** If CSV not found in ZIP, return clear error message

---

## Current API Integration

### Endpoints Used by Mobile App

**User Management:**
```typescript
POST /users/create
  Request: { email: string }
  Response: { userId: string, message: string }
  Frontend: Creates user on login screen
  
GET /users/:userId/totalSpent
  Response: number
  Frontend: Displays on dashboard
  Note: Currently called on every app launch
```

**Analytics:**
```typescript
GET /validation/user/:userId/summary
  Response: UserSummary (see types below)
  Frontend: Dashboard, Analytics screen, Wrapped journey
  Caching: 15min TTL in AsyncStorage
  Note: Called frequently, good candidate for backend caching
```

**CSV Upload:**
```typescript
POST /csv/import
  Request: FormData with CSV file + userId
  Response: { receiptsCount: number }
  Frontend: Upload screen
  Note: CHANGING TO ZIP UPLOAD (see above)
```

**Database Queries (Dev/Debug Only):**
```typescript
GET /database/stats
GET /database/users  
GET /receipts?limit=20&offset=0
  Frontend: Not used in production app
  Note: Can be removed or restricted to admin only
```

---

## TypeScript Interfaces (Frontend)

### UserSummary Interface
```typescript
export interface UserSummary {
  userId: string;
  totalSpent: number;
  totalReceipts: number;
  averageOrderValue: number;
  topRestaurants: Array<{
    name: string;
    count: number;
    totalSpent: number;
  }>;
  monthlyBreakdown: Array<{
    month: string;  // Format: "2024-01" or "January 2024"
    totalSpent: number;
    receiptCount: number;
  }>;
  refundedReceipts: number;
  dataQuality: {
    issues: string[];
    recommendations: string[];
  };
}
```

**Important Notes:**
- `monthlyBreakdown.month` must be parseable as YYYY-MM format or month name
- Frontend groups by year if multiple years present
- Sorted oldest to newest for chart display

### User Interface
```typescript
export interface User {
  id: string;        // UUID
  email: string;
  createdAt: string; // ISO 8601
}
```

**Note:** Frontend does NOT store `totalSpent` or `receiptCount` on User object - these come from analytics endpoint

---

## Frontend Caching Strategy

### What We Cache
1. **Analytics Data** - 15 minute TTL
   - Stored in AsyncStorage with userId + timestamp
   - Validated on retrieval (TTL + userId check)
   - Used for offline viewing
   - Cleared on logout

### What We Don't Cache
- User authentication state (persisted indefinitely)
- CSV uploads (always fresh)
- Error states (ephemeral)

### Cache Keys
```typescript
'@snacktrack_analytics_cache' - Analytics data
'@snacktrack_last_sync' - Last successful sync timestamp
'@snacktrack_onboarding_completed' - Onboarding completion flag
'@snacktrack_user_data' - User object
'@snacktrack_user_id' - User ID
```

**Backend Implication:** Frontend expects data to be fresh within 15 minutes. Backend caching should have shorter TTL (5 min recommended) to ensure consistency.

---

## Error Handling Expectations

### Frontend Error Parser
```typescript
// Frontend parses API errors into 3 categories:
type ErrorType = 'network' | 'validation' | 'server';

- Network errors: Offline, timeout, DNS failure
- Validation errors: 400, 422 status codes
- Server errors: 500, 502, 503 status codes
```

### Expected Error Response Format
```json
{
  "error": {
    "message": "User-friendly error message",
    "statusCode": 400,
    "timestamp": "2025-10-11T...",
    "path": "/csv/import",
    "method": "POST"
  }
}
```

**Frontend Behavior:**
- Network errors → Show cached data if available
- Validation errors → Show error message with retry button
- Server errors → Show generic error, log to console (dev only)
- **No console errors in production** - All errors handled in UI

---

## User Journey & API Timing

### Critical Path (First-Time User)
```
1. Open App
   → No API calls

2. Onboarding (4 slides)
   → No API calls

3. Uber ZIP Tutorial (3 slides)
   → No API calls

4. Login Screen
   → POST /users/create { email }
   → GET /users/:userId/totalSpent
   
5. Dashboard Load
   → GET /validation/user/:userId/summary
   (Cached for 15min, background refresh)

6. Upload ZIP
   → POST /csv/import (FormData with ZIP)
   (Processing should be async, return quickly)

7. Processing Loader (1.5 seconds)
   → No API calls (frontend animation only)

8. Wrapped Journey
   → GET /validation/user/:userId/summary (if not cached)
   
9. Share to Social
   → No API calls (native share sheet)

10. Return to Dashboard
    → No API calls (uses cached data)
```

### Performance Requirements
- **CSV/ZIP Import:** Must return within 30 seconds or show progress
- **Analytics Fetch:** Should return within 2 seconds
- **User Creation:** Should return within 1 second

**Recommendation:** Implement async job queue for CSV processing with job status endpoint:
```typescript
POST /csv/import → { jobId: string, status: 'processing' }
GET /csv/import/status/:jobId → { status: 'completed', receiptsCount: 202 }
```

---

## ZIP File Upload Implementation

### Current Implementation (CSV)
```typescript
// Frontend sends CSV file
const formData = new FormData();
formData.append('file', csvFile);
formData.append('userId', userId);

// Backend receives and processes synchronously
```

### Required Implementation (ZIP)
```typescript
// Frontend sends ZIP file
const formData = new FormData();
formData.append('file', zipFile); // .zip MIME type
formData.append('userId', userId);

// Backend must:
1. Accept multipart/form-data with .zip file
2. Extract ZIP to temp directory
3. Navigate to: */Uber Data/Eats/user_orders-0.csv
4. Validate CSV exists and is valid format
5. Process CSV as normal
6. Clean up temp directory
7. Return { receiptsCount: number }
```

### File Structure in Uber ZIP
```
Uber Data Request {random-hash}/
  ├── Uber Data/
  │   ├── Eats/
  │   │   ├── user_orders-0.csv    ← THIS FILE
  │   │   ├── user_orders-1.csv (if exists)
  │   │   └── ...
  │   ├── Rides/
  │   └── ...
  └── ...
```

### Implementation Recommendations

**Option 1: Synchronous (Simple, MVP)**
```typescript
// Pros: Simple implementation
// Cons: Blocks request, 30s timeout risk
// Use for: MVP with small ZIPs (< 5MB)

import AdmZip from 'adm-zip';

const zip = new AdmZip(file.buffer);
const csvEntry = zip.getEntries().find(entry => 
  entry.entryName.includes('Uber Data/Eats/user_orders-0.csv')
);
const csvContent = csvEntry.getData().toString('utf8');
// Process CSV...
```

**Option 2: Async Job Queue (Better, Scalable)**
```typescript
// Pros: Non-blocking, supports large files, can show progress
// Cons: More complex, needs Redis + BullMQ
// Use for: Post-MVP scaling

POST /csv/import → { jobId, status: 'queued' }
GET /csv/job/:jobId → { status: 'processing' | 'completed', progress: 50 }
```

**Frontend Recommendation:** Option 1 for MVP, migrate to Option 2 post-launch.

---

## Network & Offline Behavior

### Network Status Monitoring
- Frontend uses `@react-native-community/netinfo`
- Detects online/offline state
- Shows user-friendly error messages when offline
- **Never shows console errors to users**

### Offline Behavior
1. **Analytics queries fail** → Show cached data (if < 15min old)
2. **CSV upload fails** → Show error message, user must retry when online
3. **User creation fails** → Show error message
4. **No automatic retry** - User must manually retry

### API Expectations
- Return proper HTTP status codes (network errors vs server errors)
- Timeout after 30 seconds (frontend will show network error)
- Return consistent error format (see Error Handling section)

---

## Authentication Flow (When Implemented)

### Current Flow
```
1. User enters email
2. POST /users/create { email }
3. Store { userId, email, createdAt } in AsyncStorage
4. Navigate to dashboard
```

### Required Flow (After Auth Implementation)
```
1. User enters email + password
2. POST /auth/register { email, password }
   Response: { userId, token, refreshToken, user: {...} }
3. Store token + refreshToken in AsyncStorage
4. Add Authorization: Bearer {token} to all future requests
5. On 401 response → Try refresh token
6. If refresh fails → Force logout → Clear AsyncStorage → Show login
```

### Token Storage
```typescript
// Frontend will store in AsyncStorage:
{
  '@snacktrack_auth_token': 'jwt_token_here',
  '@snacktrack_refresh_token': 'refresh_token_here',
  '@snacktrack_user_data': '{"id":"...","email":"...",...}',
  '@snacktrack_user_id': 'uuid'
}
```

### Token Refresh Strategy
- Check token expiry before each API call
- Refresh if expiring within 5 minutes
- Handle race conditions (multiple simultaneous requests)
- **Backend must:** Return token expiry in response or JWT payload

---

## Social Sharing Requirements

### What Gets Shared
- PNG images captured from app screens (not sent to API)
- Native iOS/Android share sheet
- **No API involvement** in sharing process

### Analytics Data for Graphics
The Wrapped Journey needs these data points from UserSummary:
1. `totalSpent` - Main headline number
2. `totalReceipts` - Receipt count
3. `topRestaurants[0]` - Most frequent restaurant
4. `monthlyBreakdown` - For trend chart
5. Calculated: Most expensive order (max of topRestaurants.totalSpent)

**Ensure UserSummary always returns:**
- At least 1 restaurant in topRestaurants array
- At least 1 month in monthlyBreakdown array
- Valid numbers (not null/undefined)

---

## Data Validation Requirements

### CSV/ZIP Upload Validation

**Frontend Validation (Already Done):**
- File type check (.csv or .zip)
- File size limit (10MB)
- User must be authenticated

**Backend Validation (Required):**
```typescript
1. File exists and is valid ZIP/CSV
2. ZIP contains the correct CSV file path
3. CSV has required columns (date, restaurant, amount, etc.)
4. CSV data is valid (proper date formats, numeric amounts)
5. File size < 50MB (backend limit)
6. Virus scan (optional but recommended)
7. User owns this upload (userId validation)
```

**Error Messages:**
- "ZIP file is corrupted or invalid"
- "Could not find Uber Eats CSV in ZIP file"
- "CSV format is invalid - please download fresh data from Uber"
- "File too large - maximum 50MB"
- "Unable to process CSV - contact support"

### User Email Validation

**Frontend:** Basic email format check only  
**Backend Must:** 
- Validate email format (regex)
- Check for duplicate emails (unique constraint)
- Sanitize email input (prevent injection)
- Lowercase emails before storage (consistency)

---

## Production Configuration

### Environment Variables (Frontend)
```bash
EXPO_PUBLIC_API_URL=https://api.snacktrack.app
```

**Current:** Points to `http://localhost:3000` (dev)  
**Production:** Will point to hosted API URL  
**CORS Required:** Backend must whitelist production domain

### Expected Production API URL
```
https://api.snacktrack.app
```

**Backend CORS must allow:**
```typescript
// Replace placeholder in backend
origin: [
  'https://snacktrack.app',        // Production web (if built)
  'snacktrack://',                 // Deep linking
  // Expo Go origins during testing
]
```

---

## Performance Expectations

### Response Time Targets
- User creation: < 1 second
- Analytics query: < 2 seconds  
- CSV import: < 30 seconds (or return jobId for async processing)
- Health check: < 100ms

### Caching Recommendations

**High-Value Cache Targets:**
```typescript
// Frontend caches for 15min, backend should cache for 5min
GET /validation/user/:userId/summary
  - TTL: 5 minutes
  - Invalidate on: CSV import for that userId
  - Hit rate: Very high (called on every dashboard load)

// Moderate caching
GET /users/:userId/totalSpent
  - TTL: 1 minute
  - Less critical (summary endpoint has this data)
```

**Don't Cache:**
- POST endpoints (writes)
- User creation
- CSV uploads

---

## Data Structure Requirements

### Monthly Breakdown Format

**Frontend Expects:**
```typescript
monthlyBreakdown: [
  { 
    month: "2024-01",      // YYYY-MM format (preferred)
    totalSpent: 1234.56,
    receiptCount: 45
  },
  // OR
  {
    month: "January 2024",  // Month name (also works)
    totalSpent: 1234.56,
    receiptCount: 45
  }
]
```

**Frontend Logic:**
- Parses YYYY-MM format: "2024-01" → "Jan"
- Groups by year if multiple years present
- Shows yearly chart if data spans 2+ years
- Shows monthly chart if single year
- **Sorts oldest to newest** for display

**Backend Should:**
- Return consistent format (prefer YYYY-MM)
- Sort by date ascending (oldest first)
- Include all months (even if 0 spending)
- Limit to last 24 months (performance)

### Top Restaurants Format

**Frontend Expects:**
```typescript
topRestaurants: [
  {
    name: "McDonald's",
    count: 23,          // Number of orders
    totalSpent: 456.78  // Total across all orders
  },
  // Sorted by count (most frequent first)
  // Minimum 1 restaurant, maximum 10
]
```

**Frontend Uses:**
- `topRestaurants[0]` for "Repeat Offender" slide
- Displays top 3-5 on analytics screen
- Calculates most expensive order as max(topRestaurants.totalSpent)

---

## Error Handling Integration

### Frontend Error Categories

**Network Errors** (Client-Side)
```typescript
- Device offline
- DNS failure  
- Request timeout (30s)
- Connection refused

Frontend Action: Show cached data or friendly offline message
```

**Validation Errors** (400, 422)
```typescript
- Invalid email format
- Missing required fields
- Invalid CSV format
- File too large

Frontend Action: Show specific error message with retry button
```

**Server Errors** (500, 502, 503)
```typescript
- Database connection failed
- Unhandled exception
- Service unavailable

Frontend Action: Show generic error, offer retry
```

### Error Message Guidelines

**Good Error Messages (User-Friendly):**
- "Unable to process your CSV file. Please ensure it's a valid Uber Eats export."
- "This email is already registered. Please log in or use a different email."
- "Connection lost. Your data is saved and will sync when you're back online."

**Bad Error Messages (Don't Send These):**
```
❌ "PostgreSQL connection timeout on line 234"
❌ "Undefined property 'totalSpent' of null"  
❌ "Internal server error"
```

**Backend Should:**
- Return user-friendly messages in production
- Log technical details server-side only
- Use frontend ErrorType hints: "network", "validation", "server"

---

## Mobile App Capabilities & Constraints

### Platform Support
- iOS 13+ (Expo Go or standalone)
- Android 5.0+ (Expo Go or standalone)
- Web (limited, not primary target)

### Device Storage
- AsyncStorage limit: ~6MB on iOS, ~10MB on Android
- Frontend stores: Auth tokens, user data, cached analytics
- **Keep cached responses small** (< 100KB per user summary)

### File Upload Constraints
- Max file size: 10MB (frontend enforced)
- Supported types: .csv, .zip
- Upload via multipart/form-data
- Progress tracking shown to user

### Network Conditions
- Frontend designed for mobile networks (3G/4G/5G)
- Handles intermittent connectivity
- 30-second request timeout
- **Backend must respond within 30s or return job status**

---

## Security & Privacy

### Current Security (Frontend)
- User data stored in device-local AsyncStorage (encrypted by OS)
- No password storage (yet)
- HTTPS required for production API
- No sensitive data logged in production

### Required Backend Security
1. **HTTPS only** - Reject HTTP requests in production
2. **Validate file uploads** - Check MIME types, scan for malware
3. **Rate limiting** - Already implemented (excellent)
4. **SQL injection prevention** - Use parameterized queries
5. **User data isolation** - Strict userId ownership validation

### GDPR/Privacy Considerations
- Users can delete account (frontend has UI, backend needs endpoint)
- Users can export data (not yet implemented)
- No tracking cookies (mobile app)
- Analytics stored locally and on server
- **Required Endpoint:** `DELETE /users/:userId` - Delete all user data

---

## Future Frontend Features (Context for Backend Planning)

### Planned (Not Yet Built)
1. **Receipt List View**
   - Would need: `GET /receipts?userId=X&limit=20&offset=0`
   - Pagination support
   - Search/filter by restaurant, date

2. **Data Export**
   - Would need: `GET /users/:userId/export` → CSV download
   - User wants their data back out

3. **Currency Detection**
   - Frontend will detect CAD/USD/EUR from CSV or device locale
   - Backend should store currency with user profile
   - Convert amounts for display

4. **Multiple Share Templates**
   - More Wrapped-style slides (already partially built)
   - All use same UserSummary data structure

### Not Planned (No Backend Work Needed)
- Push notifications (maybe post-MVP)
- Real-time updates (not needed)
- Multi-device sync (single device per user)
- Receipt photo upload (not in scope)

---

## Testing Collaboration

### Frontend Testing Needs from Backend

**Mock Data Requirements:**
- Test user with 0 receipts (empty state)
- Test user with 1-10 receipts (small dataset)
- Test user with 100+ receipts (pagination)
- Test user with multi-year data (yearly chart)
- Test invalid CSV upload (error handling)

**Test Endpoints:**
- Keep `/database/stats` for development
- Add `GET /health` with detailed status (DB connection, Redis, etc.)
- Add `POST /test/reset-user/:userId` (dev only) - Reset user data for testing

---

## API Response Time Budget

### By Endpoint Priority

**Critical (< 1s):**
- `POST /auth/login`
- `POST /auth/register`
- `GET /health`

**Important (< 2s):**
- `GET /validation/user/:userId/summary`
- `GET /users/:userId/totalSpent`

**Can Be Slower (< 30s):**
- `POST /csv/import`
- Complex analytics queries

**Should Be Async (> 30s):**
- Large CSV processing
- Bulk operations
- Heavy computations

---

## Mobile-Specific Considerations

### Request Headers
```typescript
// Frontend sends
User-Agent: Expo/XX.X.X (iOS/Android)
Content-Type: application/json (or multipart/form-data)
Authorization: Bearer {token} (after auth implemented)
```

### Network Reliability
- Mobile users have intermittent connectivity
- Requests may fail mid-flight
- **Backend should:** Be idempotent where possible
- **Frontend will:** Retry on network errors (with exponential backoff)

### File Upload from Mobile
- Files come from device storage or cloud providers
- May be slow on cellular networks
- **Backend should:** Support chunked uploads (future enhancement)
- **Frontend shows:** Upload progress bar

---

## Deployment Coordination

### Frontend Deployment Process
```
1. Update EXPO_PUBLIC_API_URL to production URL
2. Build with EAS: npx eas build --platform all
3. Submit to App Store / Google Play
4. Review period: 1-2 days (iOS), hours (Android)
5. Release to users
```

### Backend Deployment Requirements

**Before Frontend Can Deploy:**
- [ ] Production API hosted and accessible (HTTPS)
- [ ] CORS configured for production domain
- [ ] Authentication implemented
- [ ] ZIP upload support added
- [ ] All P0 items complete (auth, monitoring)

**Nice to Have:**
- [ ] Redis caching (performance)
- [ ] Database indexes (performance)
- [ ] Async job processing (UX)

---

## Contact Points & Breaking Changes

### Frontend Team Needs Notice For:
1. **Breaking API changes** - Endpoint URLs, response formats
2. **New required fields** - Will need app update
3. **Authentication implementation** - Coordinated release required
4. **Error response format changes** - Frontend parser depends on it
5. **Rate limit changes** - May affect user experience

### Backend Team Needs Notice For:
1. **New data requirements** - Need new endpoints or fields
2. **File upload changes** - ZIP → other formats
3. **Heavy API usage** - Viral spikes, load testing needed
4. **Mobile app release dates** - Traffic surge expected

---

## Success Metrics (Frontend Tracking)

### What Frontend Measures
- App opens
- User registrations
- CSV uploads (success/failure)
- Analytics views
- Social shares initiated
- Time spent in Wrapped journey

### What Backend Should Measure
- API request rates by endpoint
- CSV processing times
- Error rates by type
- Cache hit/miss rates
- User creation success rate
- Authentication success rate

**Coordination:** Both should report to same analytics platform for unified view

---

## Critical API Endpoints Summary

### Must Work for MVP
```
POST /users/create (or /auth/register after auth)
GET /validation/user/:userId/summary
POST /csv/import (must accept ZIP)
GET /health
```

### Nice to Have
```
GET /users/:userId/totalSpent (redundant with summary)
GET /database/stats (dev/debug only)
DELETE /users/:userId (for GDPR)
```

### Future Needs
```
GET /receipts (for receipt list view)
GET /users/:userId/export (for data export)
POST /csv/job/:jobId/status (for async processing)
```

---

## Appendix: Frontend Tech Stack

**Core:**
- React Native (Expo SDK 51+)
- TypeScript
- Expo Router (file-based navigation)

**State Management:**
- React Context (UserContext, OnboardingContext)
- AsyncStorage (persistence)
- No Redux/Zustand (keeping it simple)

**API Client:**
- Axios
- Custom error parser
- 30-second timeout
- Automatic retry on network errors (exponential backoff)

**UI Libraries:**
- expo-linear-gradient
- react-native-chart-kit
- react-native-view-shot (screenshot capture)
- expo-sharing (native share sheet)
- @react-native-community/netinfo

**Key Dependencies:**
```json
{
  "expo": "~51.0.0",
  "react-native": "0.74.0",
  "axios": "^1.6.0",
  "@react-native-async-storage/async-storage": "^1.23.0"
}
```

---

## Questions for Backend Team

1. **Authentication Timeline:** When will JWT auth be ready? (Blocks frontend deployment)
2. **ZIP Upload:** Can we implement synchronous extraction for MVP, async for scale?
3. **Job Status:** If async processing, what's the polling interval recommendation?
4. **Rate Limits:** Current limits (100 CSV/hour) appropriate for viral growth?
5. **CORS:** What domain(s) should we whitelist for production?
6. **Monitoring:** Should frontend errors be sent to backend Sentry, or separate instance?

---

## Conclusion

The frontend is production-ready and optimized for viral growth. Key backend requirements:
1. **JWT Authentication** (P0)
2. **ZIP file upload support** (P0)
3. **Ownership validation** (P0)  
4. **Performance optimization** (P1)
5. **Error tracking integration** (P1)

Frontend can support 10K+ users with current architecture. Backend API is the critical path to launch. Coordinate authentication implementation for simultaneous deployment.

