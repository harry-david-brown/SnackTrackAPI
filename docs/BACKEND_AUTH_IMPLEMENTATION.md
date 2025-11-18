# Backend Implementation Guide: Password Reset & Email Verification

This document provides complete specifications for implementing the password reset and email verification endpoints required by the frontend app.

## Overview

The frontend requires 5 new authentication endpoints:
1. **Password Reset Request** - Send OTP code to user's email
2. **Password Reset Verify** - Validate OTP code
3. **Password Reset Complete** - Set new password after code verification
4. **Email Verification Send** - Send verification OTP to new user
5. **Email Verification Confirm** - Verify email with OTP code

Additionally, existing endpoints need updates:
- `/auth/register` - Must return `emailVerified: false` in user object
- `/auth/login` - Must return `emailVerified` status in user object

---

## API Endpoint Specifications

### 1. POST `/auth/password/reset/request`

**Purpose:** Request a password reset code to be sent to the user's email.

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Password reset code sent to your email",
  "expiresIn": 60,
  "attemptLimit": 5
}
```

**Response Fields:**
- `success` (boolean): Always `true` on success
- `message` (string): User-friendly message
- `expiresIn` (number): Cooldown in seconds before resend is allowed (frontend uses this for timer)
- `attemptLimit` (number, optional): Maximum verification attempts allowed

**Error Responses:**
- `400 Bad Request`: Invalid email format
- `404 Not Found`: Email not found (for security, don't reveal if email exists)
- `429 Too Many Requests`: Rate limit exceeded (too many requests from same IP/email)

**Security Notes:**
- **Always return 200 OK** even if email doesn't exist (prevent email enumeration)
- Rate limit: Max 3 requests per email per hour, 10 requests per IP per hour
- Generate 6-digit numeric OTP (000000-999999)
- Store OTP with expiration (15 minutes recommended)
- Hash OTP before storing (use bcrypt or similar)

---

### 2. POST `/auth/password/reset/verify`

**Purpose:** Verify the password reset OTP code before allowing password change.

**Request Body:**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Code verified successfully",
  "expiresIn": 60
}
```

**Response Fields:**
- `success` (boolean): Always `true` on success
- `message` (string): User-friendly message
- `expiresIn` (number): Cooldown in seconds (for resend functionality)

**Error Responses:**
- `400 Bad Request`: Missing email or code
- `401 Unauthorized`: Invalid or expired code
- `404 Not Found`: No pending reset request for this email
- `429 Too Many Requests`: Too many verification attempts (max 5 attempts per code)

**Security Notes:**
- Track verification attempts per code (max 5 attempts)
- Invalidate code after successful verification
- Invalidate code after max attempts exceeded
- Code expires after 15 minutes
- After successful verification, issue a temporary token (JWT) valid for 5 minutes to complete password reset

---

### 3. POST `/auth/password/reset/complete`

**Purpose:** Complete password reset with new password after code verification.

**Request Body:**
```json
{
  "email": "user@example.com",
  "code": "123456",
  "newPassword": "NewPassword123"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Password reset successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid password format or missing fields
- `401 Unauthorized`: Invalid or expired code
- `404 Not Found`: No pending reset request for this email

**Security Notes:**
- Validate password meets requirements (8+ chars, 1 uppercase, 1 number)
- Verify code is still valid (not expired, not already used)
- Hash new password with bcrypt before storing
- Invalidate all existing refresh tokens for this user (force re-login)
- Clear the OTP record after successful reset
- Log password reset event for security auditing

---

### 4. POST `/auth/email/verify/send`

**Purpose:** Send email verification code to user (triggered after registration or login with unverified email).

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "expiresIn": 60,
  "message": "Verification code sent to your email"
}
```

**Response Fields:**
- `success` (boolean): Always `true` on success
- `expiresIn` (number): Cooldown in seconds before resend is allowed
- `message` (string, optional): User-friendly message

**Error Responses:**
- `400 Bad Request`: Invalid email format
- `404 Not Found`: Email not found
- `429 Too Many Requests`: Rate limit exceeded (max 3 per hour per email)

**Security Notes:**
- Rate limit: Max 3 requests per email per hour
- Generate 6-digit numeric OTP
- Store OTP with expiration (15 minutes)
- Hash OTP before storing

---

### 5. POST `/auth/email/verify/confirm`

**Purpose:** Verify email address with OTP code.

**Request Body:**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Email verified successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Missing email or code
- `401 Unauthorized`: Invalid or expired code
- `404 Not Found`: No pending verification request for this email
- `429 Too Many Requests`: Too many verification attempts

**Security Notes:**
- Track verification attempts (max 5 attempts per code)
- Invalidate code after successful verification
- Update user's `emailVerified` field to `true` in database
- Clear the OTP record after successful verification
- Log email verification event

---

## Database Schema Changes

### 1. Add `emailVerified` Column to Users Table

```sql
ALTER TABLE users 
ADD COLUMN email_verified BOOLEAN DEFAULT FALSE NOT NULL;

-- Create index for faster lookups
CREATE INDEX idx_users_email_verified ON users(email_verified);
```

### 2. Create OTP Storage Table

```sql
CREATE TABLE verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  code_hash VARCHAR(255) NOT NULL, -- Hashed OTP code
  code_type VARCHAR(50) NOT NULL, -- 'password_reset' or 'email_verification'
  expires_at TIMESTAMP NOT NULL,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 5,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  used_at TIMESTAMP NULL,
  
  -- Indexes
  INDEX idx_verification_email_type (email, code_type),
  INDEX idx_verification_expires (expires_at)
);

-- Clean up expired codes periodically (add to cron job)
-- DELETE FROM verification_codes WHERE expires_at < NOW() - INTERVAL '1 day';
```

**Table Fields:**
- `id`: Primary key
- `email`: User's email address (indexed with code_type)
- `code_hash`: Bcrypt hash of the 6-digit OTP
- `code_type`: Either `'password_reset'` or `'email_verification'`
- `expires_at`: When the code expires (15 minutes from creation)
- `attempts`: Number of verification attempts made
- `max_attempts`: Maximum allowed attempts (default 5)
- `created_at`: When code was created
- `used_at`: When code was successfully used (NULL if unused)

---

## OTP Generation & Storage Strategy

### Code Generation

```typescript
// Generate 6-digit numeric OTP
function generateOTP(): string {
  const min = 100000;
  const max = 999999;
  return Math.floor(Math.random() * (max - min + 1) + min).toString().padStart(6, '0');
}
```

### Code Storage

**DO NOT store plain text OTPs.** Hash them before storing:

```typescript
import bcrypt from 'bcryptjs';

async function storeOTP(email: string, codeType: 'password_reset' | 'email_verification'): Promise<string> {
  const code = generateOTP();
  const codeHash = await bcrypt.hash(code, 10); // Use same salt rounds as passwords
  
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 15); // 15 minute expiration
  
  // Invalidate any existing codes for this email/type
  await db.query(
    'DELETE FROM verification_codes WHERE email = $1 AND code_type = $2',
    [email, codeType]
  );
  
  // Store new code
  await db.query(
    `INSERT INTO verification_codes (email, code_hash, code_type, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [email, codeHash, codeType, expiresAt]
  );
  
  return code; // Return plain code to send via email
}
```

### Code Verification

```typescript
async function verifyOTP(
  email: string, 
  code: string, 
  codeType: 'password_reset' | 'email_verification'
): Promise<boolean> {
  // Find valid, unused code
  const result = await db.query(
    `SELECT * FROM verification_codes 
     WHERE email = $1 
       AND code_type = $2 
       AND expires_at > NOW() 
       AND used_at IS NULL
     ORDER BY created_at DESC 
     LIMIT 1`,
    [email, codeType]
  );
  
  if (result.rows.length === 0) {
    return false; // No valid code found
  }
  
  const record = result.rows[0];
  
  // Check attempt limit
  if (record.attempts >= record.max_attempts) {
    // Mark as used to prevent further attempts
    await db.query(
      'UPDATE verification_codes SET used_at = NOW() WHERE id = $1',
      [record.id]
    );
    return false;
  }
  
  // Verify code hash
  const isValid = await bcrypt.compare(code, record.code_hash);
  
  if (isValid) {
    // Mark as used
    await db.query(
      'UPDATE verification_codes SET used_at = NOW() WHERE id = $1',
      [record.id]
    );
    return true;
  } else {
    // Increment attempt counter
    await db.query(
      'UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1',
      [record.id]
    );
    return false;
  }
}
```

---

## Email Service Setup

### Email Service Interface

Create a new email sending service (separate from the existing email reading clients):

```typescript
// src/services/email/EmailSender.ts

export interface EmailSender {
  sendVerificationEmail(email: string, code: string): Promise<void>;
  sendPasswordResetEmail(email: string, code: string): Promise<void>;
}

export class EmailSenderService implements EmailSender {
  constructor(
    private smtpConfig: {
      host: string;
      port: number;
      secure: boolean;
      auth: {
        user: string;
        pass: string;
      };
    }
  ) {}
  
  async sendVerificationEmail(email: string, code: string): Promise<void> {
    const subject = 'Verify your Snack Track email';
    const html = this.getVerificationEmailTemplate(code);
    const text = `Your Snack Track verification code is: ${code}`;
    
    await this.sendEmail(email, subject, html, text);
  }
  
  async sendPasswordResetEmail(email: string, code: string): Promise<void> {
    const subject = 'Reset your Snack Track password';
    const html = this.getPasswordResetEmailTemplate(code);
    const text = `Your password reset code is: ${code}`;
    
    await this.sendEmail(email, subject, html, text);
  }
  
  private async sendEmail(
    to: string, 
    subject: string, 
    html: string, 
    text: string
  ): Promise<void> {
    // Implementation using nodemailer, SendGrid, AWS SES, etc.
    // See recommended implementations below
  }
  
  private getVerificationEmailTemplate(code: string): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; 
                    text-align: center; padding: 20px; background: #f5f5f5; 
                    border-radius: 8px; margin: 20px 0; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Verify your email address</h1>
            <p>Thanks for signing up for Snack Track! Enter this code in the app to verify your email:</p>
            <div class="code">${code}</div>
            <p>This code expires in 15 minutes.</p>
            <p>If you didn't create a Snack Track account, you can safely ignore this email.</p>
            <div class="footer">
              <p>Snack Track Team</p>
            </div>
          </div>
        </body>
      </html>
    `;
  }
  
  private getPasswordResetEmailTemplate(code: string): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; 
                    text-align: center; padding: 20px; background: #f5f5f5; 
                    border-radius: 8px; margin: 20px 0; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Reset your password</h1>
            <p>We received a request to reset your Snack Track password. Enter this code in the app:</p>
            <div class="code">${code}</div>
            <p>This code expires in 15 minutes.</p>
            <p>If you didn't request a password reset, you can safely ignore this email.</p>
            <div class="footer">
              <p>Snack Track Team</p>
            </div>
          </div>
        </body>
      </html>
    `;
  }
}
```

### Email Provider Options

#### Option 1: Nodemailer (SMTP) - Recommended for Development

```typescript
import nodemailer from 'nodemailer';

private async sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: this.smtpConfig.host,
    port: this.smtpConfig.port,
    secure: this.smtpConfig.secure,
    auth: {
      user: this.smtpConfig.auth.user,
      pass: this.smtpConfig.auth.pass,
    },
  });
  
  await transporter.sendMail({
    from: '"Snack Track" <noreply@snacktrack.com>',
    to,
    subject,
    text,
    html,
  });
}
```

**Configuration (environment variables):**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
```

#### Option 2: SendGrid - Recommended for Production

```typescript
import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

private async sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  await sgMail.send({
    to,
    from: 'noreply@snacktrack.com',
    subject,
    text,
    html,
  });
}
```

#### Option 3: AWS SES - For High Volume

```typescript
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

private async sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const client = new SESClient({ region: 'us-east-1' });
  
  await client.send(new SendEmailCommand({
    Source: 'noreply@snacktrack.com',
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: text },
        Html: { Data: html },
      },
    },
  }));
}
```

---

## Rate Limiting Implementation

### Recommended Rate Limits

```typescript
// src/middleware/rateLimiting.ts

import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';

// Password reset request: 3 per hour per email, 10 per hour per IP
export const passwordResetRequestLimiter = rateLimit({
  store: new RedisStore({
    client: new Redis(process.env.REDIS_URL),
    prefix: 'rl:pwreset:',
  }),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per window
  keyGenerator: (req) => req.body.email || req.ip, // Limit by email, fallback to IP
  message: 'Too many password reset requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Email verification send: 3 per hour per email
export const emailVerificationLimiter = rateLimit({
  store: new RedisStore({
    client: new Redis(process.env.REDIS_URL),
    prefix: 'rl:emailverify:',
  }),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req) => req.body.email || req.ip,
  message: 'Too many verification requests. Please try again later.',
});
```

---

## Updated Auth Endpoints

### Update `/auth/register`

**Add to response:**
```typescript
user: {
  id: user.id,
  email: user.email,
  createdAt: user.createdAt,
  emailVerified: false // NEW: Always false for new registrations
}
```

### Update `/auth/login`

**Add to response:**
```typescript
user: {
  id: user.id,
  email: user.email,
  createdAt: user.createdAt,
  emailVerified: user.emailVerified || false // NEW: Include verification status
}
```

---

## Implementation Checklist

### Phase 1: Database Setup
- [ ] Add `email_verified` column to `users` table
- [ ] Create `verification_codes` table
- [ ] Add indexes for performance
- [ ] Set up cleanup job for expired codes

### Phase 2: Email Service
- [ ] Choose email provider (SendGrid/AWS SES/Nodemailer)
- [ ] Set up email service with templates
- [ ] Configure SMTP/API credentials
- [ ] Test email delivery (check spam folders)
- [ ] Set up email domain authentication (SPF, DKIM, DMARC)

### Phase 3: OTP Service
- [ ] Implement OTP generation (6-digit numeric)
- [ ] Implement OTP hashing and storage
- [ ] Implement OTP verification logic
- [ ] Add attempt tracking and limits
- [ ] Add expiration handling

### Phase 4: API Endpoints
- [ ] Implement `/auth/password/reset/request`
- [ ] Implement `/auth/password/reset/verify`
- [ ] Implement `/auth/password/reset/complete`
- [ ] Implement `/auth/email/verify/send`
- [ ] Implement `/auth/email/verify/confirm`
- [ ] Update `/auth/register` to return `emailVerified: false`
- [ ] Update `/auth/login` to return `emailVerified` status

### Phase 5: Security & Rate Limiting
- [ ] Add rate limiting middleware
- [ ] Implement IP-based rate limiting
- [ ] Implement email-based rate limiting
- [ ] Add security logging for auth events
- [ ] Test rate limit enforcement

### Phase 6: Testing
- [ ] Unit tests for OTP generation/verification
- [ ] Integration tests for all endpoints
- [ ] Test email delivery (multiple providers)
- [ ] Test rate limiting
- [ ] Test edge cases (expired codes, max attempts, etc.)
- [ ] Manual testing with frontend app

---

## Security Best Practices

1. **Never reveal if email exists** - Always return 200 OK for password reset requests
2. **Hash OTPs** - Use bcrypt (same as passwords) before storing
3. **Short expiration** - 15 minutes for OTP codes
4. **Attempt limits** - Max 5 verification attempts per code
5. **Rate limiting** - Prevent abuse with IP and email-based limits
6. **Invalidate on success** - Mark codes as used immediately after verification
7. **Invalidate old tokens** - On password reset, invalidate all refresh tokens
8. **Log security events** - Track password resets and email verifications
9. **Email domain authentication** - Set up SPF, DKIM, DMARC for deliverability
10. **HTTPS only** - All endpoints must use HTTPS in production

---

## Error Handling

All endpoints should use consistent error responses:

```typescript
// Success
{
  "success": true,
  "message": "Operation completed successfully",
  ...
}

// Validation Error (400)
{
  "error": "Invalid email format",
  "message": "Please provide a valid email address",
  "statusCode": 400
}

// Authentication Error (401)
{
  "error": "Invalid code",
  "message": "The verification code is invalid or has expired",
  "statusCode": 401
}

// Not Found (404)
{
  "error": "Not found",
  "message": "No pending verification request found",
  "statusCode": 404
}

// Rate Limit (429)
{
  "error": "Too many requests",
  "message": "Too many verification requests. Please try again later.",
  "statusCode": 429
}
```

---

## Testing Recommendations

### Unit Tests
- OTP generation (ensure 6 digits, numeric only)
- OTP hashing and verification
- Code expiration logic
- Attempt limit enforcement

### Integration Tests
- Full password reset flow (request → verify → complete)
- Full email verification flow (send → confirm)
- Rate limiting enforcement
- Error handling for invalid inputs
- Expired code handling

### Manual Testing Checklist
- [ ] Register new user → receive verification email
- [ ] Verify email with correct code → success
- [ ] Verify email with wrong code → error
- [ ] Request password reset → receive email
- [ ] Complete password reset flow → can login with new password
- [ ] Test rate limiting (make 4 requests, 4th should fail)
- [ ] Test expired codes (wait 16 minutes, code should fail)
- [ ] Test max attempts (enter wrong code 6 times, code should be invalidated)

---

## Frontend Integration Notes

The frontend expects:
- All endpoints return JSON
- Success responses include `success: true`
- Error responses include `error` and `message` fields
- `expiresIn` field in responses (seconds) for resend cooldown timers
- `/auth/register` and `/auth/login` return `user.emailVerified` boolean

The frontend handles:
- OTP input formatting (numbers only, 6 digits)
- Resend cooldown timers (uses `expiresIn` from response)
- Error message display
- Loading states during API calls
- Modal navigation between steps

---

## Questions or Issues?

If you encounter any issues during implementation:
1. Check the frontend API calls in `services/authApi.ts` for exact request/response formats
2. Review the frontend types in `types/api.ts` for TypeScript interfaces
3. Test endpoints with Postman/curl before frontend integration
4. Check email delivery logs if codes aren't arriving
5. Verify Redis is running if using Redis-based rate limiting

---

## Next Steps After Implementation

Once endpoints are implemented:
1. Update Swagger/OpenAPI documentation
2. Deploy to staging environment
3. Test with frontend app (see `MANUAL_TESTING_AUTH.md` in frontend repo)
4. Monitor email delivery rates and spam scores
5. Set up alerts for failed email deliveries
6. Document any deviations from this spec

