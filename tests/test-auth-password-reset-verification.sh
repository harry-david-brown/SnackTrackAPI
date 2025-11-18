#!/bin/bash

# Test script for password reset and email verification endpoints
# Run this after starting the server locally with: docker-compose up

BASE_URL="http://localhost:3000"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "ERROR: jq is required but not installed. Install it with: sudo apt-get install jq"
    exit 1
fi

echo "========================================================="
echo "🧪 Testing Password Reset & Email Verification Endpoints"
echo "========================================================="
echo ""
echo "TIP: Keep docker logs open in another terminal with:"
echo "     docker-compose logs -f snack-track-api"
echo ""

# Test user credentials - use timestamp to make unique
TIMESTAMP=$(date +%s)
TEST_EMAIL="test${TIMESTAMP}@example.com"
TEST_PASSWORD="TestPassword123"

echo "[Step 1] Register a new test user"
echo "-----------------------------------"
echo "Using email: $TEST_EMAIL"
REGISTER_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")

echo "$REGISTER_RESPONSE" | jq '.'

# Check if registration was successful or if user already exists
ERROR_MESSAGE=$(echo "$REGISTER_RESPONSE" | jq -r '.error.message // empty')
if [ -n "$ERROR_MESSAGE" ]; then
  echo ""
  echo "⚠️  Registration returned an error: $ERROR_MESSAGE"
  echo "Attempting to login instead..."
  
  # Try to login instead
  LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")
  
  USER_ID=$(echo "$LOGIN_RESPONSE" | jq -r '.userId // empty')
  if [ -z "$USER_ID" ] || [ "$USER_ID" = "null" ]; then
    echo "❌ ERROR: Could not register or login. Please check the response above."
    exit 1
  fi
  
  REGISTER_RESPONSE="$LOGIN_RESPONSE"
  echo "✅ Successfully logged in with existing user"
fi

USER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.userId // empty')
EMAIL_VERIFIED=$(echo "$REGISTER_RESPONSE" | jq -r '.user.emailVerified // false')

echo ""
echo "User ID: $USER_ID"
echo "Email Verified: $EMAIL_VERIFIED"
echo ""

if [ -z "$USER_ID" ] || [ "$USER_ID" = "null" ]; then
  echo "❌ ERROR: Failed to get user ID. Response:"
  echo "$REGISTER_RESPONSE" | jq '.'
  exit 1
fi

if [ "$EMAIL_VERIFIED" != "false" ]; then
  echo "⚠️  WARNING: emailVerified is not false (it's: $EMAIL_VERIFIED)"
  echo "This might be expected if testing with an existing verified user."
else
  echo "✅ PASS: User ready (emailVerified=false)"
fi

echo ""
echo "[Step 2] Request email verification code"
echo "----------------------------------------"
VERIFY_SEND_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/email/verify/send" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}")

echo "$VERIFY_SEND_RESPONSE" | jq '.'

# Try to extract code from docker logs
echo ""
echo "Checking docker logs for verification code..."
# Log format: 📧 [DEV] Verification code for test@example.com: 123456
# Extract only the code after the colon and email
VERIFICATION_CODE=$(docker-compose logs --tail=30 snack-track-api 2>/dev/null | grep -iE "\[DEV\].*verification code for ${TEST_EMAIL//./\\.}" | tail -1 | grep -oE "${TEST_EMAIL//./\\.}: [0-9]{6}" | grep -oE "[0-9]{6}$" | head -1 | tr -d '[:space:]')

# Clean and validate the code
VERIFICATION_CODE=$(echo "$VERIFICATION_CODE" | grep -oE "^[0-9]{6}$" | head -1)

if [ -z "$VERIFICATION_CODE" ]; then
  echo ""
  echo "⚠️  Could not find code in logs. Please check manually:"
  echo "    docker-compose logs --tail=50 snack-track-api | grep -i 'verification code'"
  echo ""
  echo "Enter the 6-digit verification code: "
  read VERIFICATION_CODE
else
  echo "✅ Found code in logs: $VERIFICATION_CODE"
fi

echo ""
echo "[Step 3] Confirm email verification with code"
echo "---------------------------------------------"
echo "Using verification code: $VERIFICATION_CODE"
VERIFY_CONFIRM_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/email/verify/confirm" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"code\": \"${VERIFICATION_CODE}\"}")

echo "$VERIFY_CONFIRM_RESPONSE" | jq '.'

SUCCESS=$(echo "$VERIFY_CONFIRM_RESPONSE" | jq -r '.success')
if [ "$SUCCESS" = "true" ]; then
  echo "✅ PASS: Email verification successful"
else
  echo "❌ FAIL: Email verification failed"
  echo "Response: $VERIFY_CONFIRM_RESPONSE"
fi

echo ""
echo "[Step 4] Login and verify emailVerified status"
echo "----------------------------------------------"
LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")

EMAIL_VERIFIED_AFTER=$(echo "$LOGIN_RESPONSE" | jq -r '.user.emailVerified')
echo "$LOGIN_RESPONSE" | jq '.user'

if [ "$EMAIL_VERIFIED_AFTER" = "true" ]; then
  echo "✅ PASS: Email is now verified"
else
  echo "❌ FAIL: Email verification did not update (still false)"
fi

echo ""
echo "[Step 5] Request password reset"
echo "-------------------------------"
PASSWORD_RESET_REQUEST=$(curl -s -X POST "${BASE_URL}/auth/password/reset/request" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}")

echo "$PASSWORD_RESET_REQUEST" | jq '.'

# Try to extract code from docker logs
echo ""
echo "Checking docker logs for password reset code..."
# Log format: 📧 [DEV] Password reset code for test@example.com: 123456
# Extract only the code after the colon and email
RESET_CODE=$(docker-compose logs --tail=30 snack-track-api 2>/dev/null | grep -iE "\[DEV\].*password reset code for ${TEST_EMAIL//./\\.}" | tail -1 | grep -oE "${TEST_EMAIL//./\\.}: [0-9]{6}" | grep -oE "[0-9]{6}$" | head -1 | tr -d '[:space:]')

# Clean and validate the code
RESET_CODE=$(echo "$RESET_CODE" | grep -oE "^[0-9]{6}$" | head -1)

if [ -z "$RESET_CODE" ]; then
  echo ""
  echo "⚠️  Could not find code in logs. Please check manually:"
  echo "    docker-compose logs --tail=50 snack-track-api | grep -i 'password reset code'"
  echo ""
  echo "Enter the 6-digit password reset code: "
  read RESET_CODE
else
  echo "✅ Found code in logs: $RESET_CODE"
fi

echo ""
echo "[Step 6] Verify password reset code"
echo "-----------------------------------"
echo "Using reset code: $RESET_CODE"
RESET_VERIFY_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/password/reset/verify" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"code\": \"${RESET_CODE}\"}")

echo "$RESET_VERIFY_RESPONSE" | jq '.'

SUCCESS=$(echo "$RESET_VERIFY_RESPONSE" | jq -r '.success')
if [ "$SUCCESS" = "true" ]; then
  echo "✅ PASS: Password reset code verified"
else
  echo "❌ FAIL: Password reset code verification failed"
  echo "Response: $RESET_VERIFY_RESPONSE"
fi

echo ""
echo "[Step 7] Complete password reset"
echo "--------------------------------"
NEW_PASSWORD="NewPassword123"
RESET_COMPLETE_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/password/reset/complete" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"code\": \"${RESET_CODE}\", \"newPassword\": \"${NEW_PASSWORD}\"}")

echo "$RESET_COMPLETE_RESPONSE" | jq '.'

SUCCESS=$(echo "$RESET_COMPLETE_RESPONSE" | jq -r '.success')
if [ "$SUCCESS" = "true" ]; then
  echo "✅ PASS: Password reset completed successfully"
else
  echo "❌ FAIL: Password reset completion failed"
  echo "Response: $RESET_COMPLETE_RESPONSE"
fi

echo ""
echo "[Step 8] Login with new password"
echo "--------------------------------"
NEW_LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${NEW_PASSWORD}\"}")

echo "$NEW_LOGIN_RESPONSE" | jq '.user'

LOGIN_SUCCESS=$(echo "$NEW_LOGIN_RESPONSE" | jq -r '.userId // empty')
if [ -n "$LOGIN_SUCCESS" ]; then
  echo "✅ PASS: Login with new password successful"
else
  echo "❌ FAIL: Login with new password failed"
  echo "Response: $NEW_LOGIN_RESPONSE"
fi

echo ""
echo "========================================================="
echo "✅ Testing complete!"
echo "========================================================="
echo ""
echo "Summary:"
echo "- Email verification: $([ "$EMAIL_VERIFIED_AFTER" = "true" ] && echo "✅ PASS" || echo "❌ FAIL")"
echo "- Password reset: $([ "$(echo "$RESET_COMPLETE_RESPONSE" | jq -r '.success')" = "true" ] && echo "✅ PASS" || echo "❌ FAIL")"
echo "- Login with new password: $([ -n "$LOGIN_SUCCESS" ] && echo "✅ PASS" || echo "❌ FAIL")"
echo ""

