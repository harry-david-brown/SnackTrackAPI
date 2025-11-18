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
 * POST /auth/password/reset/request
 * Request a password reset code
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
 * POST /auth/password/reset/verify
 * Verify the password reset OTP code
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
 * POST /auth/password/reset/complete
 * Complete password reset with new password
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

