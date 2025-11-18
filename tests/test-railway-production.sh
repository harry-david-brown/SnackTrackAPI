#!/bin/bash

# Test script for Railway production deployment
# Tests password reset and email verification endpoints

BASE_URL="https://snacktrackapi-production.up.railway.app"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "ERROR: jq is required but not installed. Install it with: sudo apt-get install jq"
    exit 1
fi

echo "========================================================="
echo "🧪 Testing Railway Production Deployment"
echo "URL: $BASE_URL"
echo "========================================================="
echo ""

# Test user credentials - use timestamp to make unique
TIMESTAMP=$(date +%s)
TEST_EMAIL="test${TIMESTAMP}@example.com"
TEST_PASSWORD="TestPassword123"

echo "[Step 1] Health Check"
echo "-----------------------------------"
HEALTH=$(curl -s "$BASE_URL/")
if [ "$HEALTH" = "ALIVE" ]; then
  echo "✅ Server is alive"
else
  echo "❌ Server health check failed: $HEALTH"
  exit 1
fi

echo ""
echo "[Step 2] Register a new test user"
echo "-----------------------------------"
echo "Using email: $TEST_EMAIL"
REGISTER_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")

echo "$REGISTER_RESPONSE" | jq '.'

# Check if registration was successful
ERROR_MESSAGE=$(echo "$REGISTER_RESPONSE" | jq -r '.error.message // empty')
if [ -n "$ERROR_MESSAGE" ]; then
  echo ""
  echo "⚠️  Registration returned an error: $ERROR_MESSAGE"
  echo "Attempting to login instead..."
  
  LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")
  
  USER_ID=$(echo "$LOGIN_RESPONSE" | jq -r '.userId // empty')
  if [ -z "$USER_ID" ] || [ "$USER_ID" = "null" ]; then
    echo "❌ ERROR: Could not register or login"
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
  echo "❌ ERROR: Failed to get user ID"
  exit 1
fi

if [ "$EMAIL_VERIFIED" != "false" ]; then
  echo "⚠️  WARNING: emailVerified is not false (it's: $EMAIL_VERIFIED)"
else
  echo "✅ PASS: User ready (emailVerified=false)"
fi

echo ""
echo "[Step 3] Request email verification code"
echo "----------------------------------------"
VERIFY_SEND_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/email/verify/send" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}")

echo "$VERIFY_SEND_RESPONSE" | jq '.'

SUCCESS=$(echo "$VERIFY_SEND_RESPONSE" | jq -r '.success')
if [ "$SUCCESS" = "true" ]; then
  echo "✅ PASS: Verification code sent"
  echo ""
  echo "⚠️  IMPORTANT: Check Railway logs for the verification code:"
  echo "    Railway Dashboard → Your Service → Logs"
  echo "    Look for: 📧 [DEV] Verification code for ${TEST_EMAIL}: XXXXXX"
  echo ""
  echo "Enter the 6-digit verification code from Railway logs: "
  read VERIFICATION_CODE
else
  echo "❌ FAIL: Failed to send verification code"
  exit 1
fi

echo ""
echo "[Step 4] Confirm email verification with code"
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
echo "[Step 5] Login and verify emailVerified status"
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
echo "[Step 6] Request password reset"
echo "-------------------------------"
PASSWORD_RESET_REQUEST=$(curl -s -X POST "${BASE_URL}/auth/password/reset/request" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}")

echo "$PASSWORD_RESET_REQUEST" | jq '.'

SUCCESS=$(echo "$PASSWORD_RESET_REQUEST" | jq -r '.success')
if [ "$SUCCESS" = "true" ]; then
  echo "✅ PASS: Password reset request successful"
  echo ""
  echo "⚠️  IMPORTANT: Check Railway logs for the password reset code:"
  echo "    Look for: 📧 [DEV] Password reset code for ${TEST_EMAIL}: XXXXXX"
  echo ""
  echo "Enter the 6-digit password reset code from Railway logs: "
  read RESET_CODE
else
  echo "❌ FAIL: Password reset request failed"
  exit 1
fi

echo ""
echo "[Step 7] Verify password reset code"
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
echo "[Step 8] Complete password reset"
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
echo "[Step 9] Login with new password"
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

