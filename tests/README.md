# 🧪 Test Suite

Comprehensive test scripts for validating API functionality.

## Available Tests

### `test-full-suite.sh` ⭐ (Recommended)
**Complete end-to-end validation**

Runs all tests in sequence:
- Server health & database connection
- Authentication (register, login, refresh, logout)
- Authorization & ownership validation
- Redis caching performance
- Cache invalidation
- ZIP file upload
- User data isolation

**Usage:**
```bash
cd tests
./test-full-suite.sh
```

**Output:** 14 test cases with pass/fail status

---

### `test-auth-comprehensive.sh`
**Authentication system validation**

Tests:
- User registration
- Login with correct/incorrect credentials
- Token refresh
- Logout
- Protected route access
- Invalid token handling

**Usage:**
```bash
cd tests
./test-auth-comprehensive.sh
```

---

### `test-cache-performance.sh`
**Redis caching performance**

Tests:
- Cache MISS (first request)
- Cache HIT (subsequent requests)
- Performance improvement measurement
- Cache consistency

**Expected Results:**
- 30-40% performance improvement
- Cache HIT < Cache MISS latency

**Usage:**
```bash
cd tests
./test-cache-performance.sh
```

---

### `test-cache-invalidation.sh`
**Cache invalidation on data changes**

Tests:
- Initial summary (0 receipts)
- Cache hit on second request
- ZIP file upload
- Cache invalidation after upload
- Updated summary reflects new data

**Usage:**
```bash
cd tests
./test-cache-invalidation.sh
```

**Note:** Requires `MockUberData/Uber Data Request B18832D3.zip`

---

## Prerequisites

All tests require:
- Docker containers running (`docker-compose up -d`)
- Server accessible at `http://localhost:3000`
- Python 3 installed (for JSON parsing)

## Quick Start

Run all tests:
```bash
docker-compose up -d
cd tests
./test-full-suite.sh
```

## Test Data

Tests use:
- Unique timestamped emails to avoid conflicts
- Real Uber ZIP file from `MockUberData/`
- Automatically created/cleaned test users

## Expected Output

✅ **Success:** All tests pass (green checkmarks)  
❌ **Failure:** Specific test fails with error details

## CI/CD Integration

Tests run automatically on:
- Pull requests (GitHub Actions)
- Pre-deployment validation
- Manual workflow dispatch

See `.github/workflows/ci.yml` for details.

