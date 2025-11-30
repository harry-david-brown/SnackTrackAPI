# Timezone Conversion for Analytics

## Overview

Receipt times are stored in **UTC** in the database (as they come from Uber Eats and DoorDash CSV exports). However, analytics like "3am regret" orders and "percentage of orders after 10pm" need to be calculated based on the **user's local timezone**, not UTC.

## How It Works

### 1. Receipt Storage
- All receipt `orderDate` and `deliveryTime` fields are stored as **UTC timestamps** in the database
- This is the raw data from Uber Eats and DoorDash exports

### 2. User Timezone
- Each user has a `timezone` field in the database
- **Automatic Detection**: When creating a user, the timezone is automatically detected from:
  1. `X-Timezone` header (mobile apps should send this based on device settings)
  2. `X-User-Timezone` header (alternative header name)
  3. `timezone` field in request body (optional)
  4. Defaults to `'America/New_York'` if none provided
- **Manual Override**: Users can update their timezone via `PUT /users/{id}/timezone` API endpoint
- Timezone must be a valid IANA timezone identifier (e.g., `'America/New_York'`, `'Europe/London'`, `'Asia/Tokyo'`)

### 3. Analytics Calculation
When calculating time-based analytics:

1. **Fetch user's timezone** from the database
2. **For each receipt**, convert the UTC `orderDate` to the user's local timezone
3. **Extract local time components** (hour, day of week, etc.) from the converted time
4. **Calculate analytics** based on local time values

### Example: "3am Regret" Calculation

```typescript
// Receipt stored in database: 2025-01-15T03:00:00Z (3am UTC)

// For user in New York (EST, UTC-5):
//   3am UTC → 10pm EST (previous day)
//   Local hour = 22
//   Is late night (0-6am)? NO ❌

// For user in London (GMT, UTC+0):
//   3am UTC → 3am GMT (same day)
//   Local hour = 3
//   Is late night (0-6am)? YES ✅

// For user in Tokyo (JST, UTC+9):
//   3am UTC → 12pm JST (same day)
//   Local hour = 12
//   Is late night (0-6am)? NO ❌
```

## Implementation Details

### Timezone Utility Functions

Located in `src/utils/timezone.ts`:

- **`getLocalHour(utcDate, timezone)`**: Gets the hour (0-23) in user's timezone
- **`getLocalDay(utcDate, timezone)`**: Gets day of week (0-6) in user's timezone  
- **`getLocalDate(utcDate, timezone)`**: Gets Date object with local time components

These functions use `Intl.DateTimeFormat` with the `timeZone` option to correctly convert UTC dates to the specified timezone.

### Analytics That Use Timezone Conversion

All time-based analytics now use the user's timezone:

1. **`calculateLateNightOrders()`** - "3am regret" orders (midnight-6am local time)
2. **`calculateLaziestDay()`** - Day with most orders (using local dates)
3. **`calculateLongestStreak()`** - Consecutive days (using local dates)
4. **`calculateNightOwl()`** - Orders after 10pm (in local time)
5. **`calculateSpentThisYear()`** - Year calculation (using local timezone)
6. **`calculatePeakHungerHour()`** - Peak ordering hour (in local time)
7. **`calculateWeekendWarrior()`** - Weekend vs weekday (using local day of week)

## API Endpoints

### Create User (Automatic Timezone Detection)

**Endpoint**: `POST /users/create`

**Headers** (Mobile apps should send):
```
X-Timezone: America/New_York
```

**Request Body**:
```json
{
  "email": "user@example.com",
  "timezone": "America/New_York"  // Optional, will use X-Timezone header if not provided
}
```

**Response**:
```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "User created successfully",
  "timezone": "America/New_York"  // Shows what timezone was set
}
```

**Priority Order**:
1. `X-Timezone` header (preferred for mobile apps)
2. `X-User-Timezone` header (alternative)
3. `timezone` field in request body
4. Default: `'America/New_York'`

### Update User Timezone (Manual Override)

**Endpoint**: `PUT /users/{id}/timezone`

**Authentication**: Required (Bearer token)

**Request Body**:
```json
{
  "timezone": "America/New_York"
}
```

**Response**:
```json
{
  "message": "Timezone updated successfully",
  "timezone": "America/New_York"
}
```

**Example**:
```bash
curl -X PUT "https://api.example.com/users/{userId}/timezone" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timezone": "Europe/London"}'
```

## Common IANA Timezones

- `America/New_York` - Eastern Time (US)
- `America/Chicago` - Central Time (US)
- `America/Denver` - Mountain Time (US)
- `America/Los_Angeles` - Pacific Time (US)
- `Europe/London` - GMT/BST (UK)
- `Europe/Paris` - CET (Central Europe)
- `Asia/Tokyo` - JST (Japan)
- `Australia/Sydney` - AEST (Australia)

See [IANA Time Zone Database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) for complete list.

## Testing

Run the timezone conversion test to verify it works correctly:

```bash
node tests/test-timezone-conversion.js
```

This test verifies that:
- UTC receipt times are correctly converted to user's local timezone
- "3am regret" calculation correctly identifies late-night orders based on local time
- Different timezones produce different results for the same UTC receipt time

## Important Notes

1. **Receipt times are NOT modified** - They remain stored as UTC in the database
2. **Conversion happens at analytics time** - We convert UTC → local timezone only when calculating analytics
3. **Default timezone** - New users default to `'America/New_York'` until they set their timezone
4. **Timezone affects all time-based analytics** - Changing timezone will recalculate all analytics with the new timezone

## Mobile App Integration

### For Mobile Developers

When creating a user account, send the device's timezone in the request header:

**iOS (Swift)**:
```swift
let timezone = TimeZone.current.identifier // e.g., "America/New_York"
request.setValue(timezone, forHTTPHeaderField: "X-Timezone")
```

**Android (Kotlin)**:
```kotlin
val timezone = TimeZone.getDefault().id // e.g., "America/New_York"
request.setHeader("X-Timezone", timezone)
```

**React Native**:
```javascript
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
headers: {
  'X-Timezone': timezone
}
```

The backend will automatically use this timezone for all analytics calculations.

## Migration

Existing users will have `timezone = 'America/New_York'` by default. They can update it via the API endpoint, or the mobile app can update it automatically when they log in.

