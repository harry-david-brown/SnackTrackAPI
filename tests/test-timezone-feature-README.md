# Timezone Feature Test Suite

## Overview

Comprehensive test suite for the timezone conversion feature. Tests automatic timezone detection, database storage, analytics conversion, and timezone updates.

## Running the Tests

### Prerequisites

1. Start the local development environment:
   ```bash
   docker-compose up --build -d
   ```

2. Wait for services to be ready (check with `docker-compose ps`)

3. Run the test suite:
   ```bash
   ./tests/test-timezone-feature.sh
   ```

### Test Coverage

The test suite covers:

1. **Database Schema Verification**
   - Checks that `timezone` column exists in `users` table
   - Verifies column type and default value

2. **Timezone Detection from Header**
   - Tests `X-Timezone` header detection
   - Verifies timezone is stored in database

3. **Timezone Detection from Request Body**
   - Tests timezone field in request body
   - Verifies fallback behavior

4. **Default Timezone Fallback**
   - Tests that default timezone (`America/New_York`) is applied when no timezone is provided

5. **Timezone Priority**
   - Tests that header timezone takes priority over body timezone

6. **Invalid Timezone Format**
   - Tests that invalid timezone formats are rejected
   - Verifies default is applied for invalid formats

7. **Update User Timezone**
   - Tests `PUT /users/{id}/timezone` endpoint
   - Verifies timezone update in database

8. **Analytics Timezone Conversion**
   - Tests that analytics use correct timezone
   - Verifies "3am regret" calculation uses local timezone

## Test Results

The test suite provides:
- ✅ Pass count
- ❌ Fail count
- Detailed output for each test
- Color-coded results

## Known Issues

- **Analytics Test**: The analytics timezone conversion test may fail if the API hasn't been restarted after code changes. Restart the API with `docker-compose restart snack-track-api` if needed.

## Environment Variables

- `API_URL`: API endpoint URL (default: `http://localhost:3000`)
- `API_KEY`: API key for authentication (default: `test-key`)

## Example Output

```
🧪 Comprehensive Timezone Conversion Test Suite
==========================================================

API URL: http://localhost:3000

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Checking API Health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ API is running

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Test Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Tests Passed: 15
🎉 All tests passed!
```

