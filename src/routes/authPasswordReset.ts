/**
 * Password Reset Routes
 * 
 * Handles password reset flow: request, verify, and complete
 */

import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, ValidationError, NotFoundError, AuthenticationError } from '../middleware/errorHandler';
import { validateEmail } from '../middleware/validation';
import {
  passwordResetRequestRateLimit,
  passwordResetIPRateLimit,
  otpVerificationRateLimit
} from '../middleware/security';

const router = Router();

/**
 * @swagger
 * /auth/password/reset/request:
 *   post:
 *     summary: Request password reset code
 *     description: Send a 6-digit OTP code to user's email for password reset. Always returns 200 OK for security (prevents email enumeration).
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *     responses:
 *       200:
 *         description: Password reset code sent (always returns success for security)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Password reset code sent to your email
 *                 expiresIn:
 *                   type: integer
 *                   description: Cooldown in seconds before resend is allowed
 *                   example: 60
 *                 attemptLimit:
 *                   type: integer
 *                   description: Maximum verification attempts allowed
 *                   example: 5
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 */
router.post(
  '/request',
  passwordResetIPRateLimit, // Apply IP rate limit first
  passwordResetRequestRateLimit, // Then apply email-based rate limit
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;

    if (!email) {
      throw new ValidationError('Email is required', 'email');
    }

    if (!validateEmail(email)) {
      throw new ValidationError('Invalid email format', 'email');
    }

    const normalizedEmail = email.toLowerCase().trim();
    const otpService = container.otpService;
    const emailSender = container.emailSender;
    const userRepository = container.userRepository;

    // Check if user exists (but don't reveal if they don't - security best practice)
    const user = await userRepository.findByEmail(normalizedEmail);
    
    // Always return 200 OK even if email doesn't exist (prevent email enumeration)
    // Only send email if user exists and email sender is enabled
    if (user && emailSender.isEnabled()) {
      const code = await otpService.storeOTP(normalizedEmail, 'password_reset');
      await emailSender.sendPasswordResetEmail(normalizedEmail, code);
      console.log(`✅ Password reset code sent to ${normalizedEmail}`);
    } else if (user && !emailSender.isEnabled()) {
      // In development, log the code instead
      const code = await otpService.storeOTP(normalizedEmail, 'password_reset');
      console.log(`📧 [DEV] Password reset code for ${normalizedEmail}: ${code}`);
    } else {
      // User doesn't exist, but don't reveal this
      console.log(`⚠️  Password reset requested for non-existent email: ${normalizedEmail}`);
    }

    // Always return success response (60 second cooldown)
    res.status(200).json({
      success: true,
      message: 'Password reset code sent to your email',
      expiresIn: 60, // Cooldown in seconds before resend allowed
      attemptLimit: 5
    });
  })
);

/**
 * @swagger
 * /auth/password/reset/verify:
 *   post:
 *     summary: Verify password reset code
 *     description: Verify the 6-digit OTP code received via email. Does not mark code as used yet (complete endpoint does that).
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - code
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               code:
 *                 type: string
 *                 pattern: '^[0-9]{6}$'
 *                 description: 6-digit numeric code
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Code verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Code verified successfully
 *                 expiresIn:
 *                   type: integer
 *                   example: 60
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         description: Invalid or expired code
 *       404:
 *         description: No pending reset request found
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 */
router.post(
  '/verify',
  otpVerificationRateLimit,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, code } = req.body;

    if (!email || !code) {
      throw new ValidationError('Email and code are required');
    }

    if (!validateEmail(email)) {
      throw new ValidationError('Invalid email format', 'email');
    }

    const normalizedEmail = email.toLowerCase().trim();
    const otpService = container.otpService;

    // Check if there's a valid code
    const hasValidCode = await otpService.hasValidCode(normalizedEmail, 'password_reset');
    if (!hasValidCode) {
      throw new NotFoundError('No pending reset request for this email');
    }

    // Verify the code (but don't mark as used yet - complete endpoint will do that)
    const isValid = await otpService.verifyOTP(normalizedEmail, code, 'password_reset', false);
    
    if (!isValid) {
      throw new AuthenticationError('Invalid or expired code');
    }

    res.status(200).json({
      success: true,
      message: 'Code verified successfully',
      expiresIn: 60
    });
  })
);

/**
 * @swagger
 * /auth/password/reset/complete:
 *   post:
 *     summary: Complete password reset
 *     description: Set new password after code verification. Code must be valid and not expired. Invalidates code after successful reset.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - code
 *               - newPassword
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               code:
 *                 type: string
 *                 pattern: '^[0-9]{6}$'
 *                 description: 6-digit numeric code from email
 *                 example: "123456"
 *               newPassword:
 *                 type: string
 *                 format: password
 *                 description: New password (min 8 chars, 1 uppercase, 1 number)
 *                 example: NewPassword123
 *     responses:
 *       200:
 *         description: Password reset successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Password reset successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         description: Invalid or expired code
 *       404:
 *         description: User not found
 */
router.post(
  '/complete',
  asyncHandler(async (req: Request, res: Response) => {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      throw new ValidationError('Email, code, and newPassword are required');
    }

    if (!validateEmail(email)) {
      throw new ValidationError('Invalid email format', 'email');
    }

    const normalizedEmail = email.toLowerCase().trim();
    const otpService = container.otpService;
    const authService = container.authService;
    const userRepository = container.userRepository;

    // Check if user exists
    const user = await userRepository.findByEmail(normalizedEmail);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Verify the code again (and mark as used this time)
    const isValid = await otpService.verifyOTP(normalizedEmail, code, 'password_reset', true);
    
    if (!isValid) {
      throw new AuthenticationError('Invalid or expired code');
    }

    // Reset password (this validates and hashes the new password)
    await authService.resetPassword(normalizedEmail, code, newPassword);

    // Note: In a production system, you might want to invalidate all refresh tokens here
    // For now, the frontend should handle token cleanup

    console.log(`✅ Password reset completed for ${normalizedEmail}`);

    res.status(200).json({
      success: true,
      message: 'Password reset successfully'
    });
  })
);

export default router;

