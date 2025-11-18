/**
 * Email Verification Routes
 * 
 * Handles email verification flow: send code and confirm
 */

import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, ValidationError, NotFoundError, AuthenticationError } from '../middleware/errorHandler';
import { validateEmail } from '../middleware/validation';
import {
  emailVerificationSendRateLimit,
  otpVerificationRateLimit
} from '../middleware/security';

const router = Router();

/**
 * @swagger
 * /auth/email/verify/send:
 *   post:
 *     summary: Send email verification code
 *     description: Send a 6-digit OTP code to user's email for verification. Triggered after registration or login with unverified email.
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
 *         description: Verification code sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 expiresIn:
 *                   type: integer
 *                   description: Cooldown in seconds before resend is allowed
 *                   example: 60
 *                 message:
 *                   type: string
 *                   example: Verification code sent to your email
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         description: Email not found
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 */
router.post(
  '/send',
  emailVerificationSendRateLimit,
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

    // Check if user exists
    const user = await userRepository.findByEmail(normalizedEmail);
    if (!user) {
      throw new NotFoundError('Email not found');
    }

    // Only send if user's email is not already verified
    if (user.emailVerified) {
      throw new ValidationError('Email is already verified');
    }

    // Generate and store OTP
    const code = await otpService.storeOTP(normalizedEmail, 'email_verification');

    // Send email if enabled
    if (emailSender.isEnabled()) {
      await emailSender.sendVerificationEmail(normalizedEmail, code);
      console.log(`✅ Verification code sent to ${normalizedEmail}`);
    } else {
      // In development, log the code
      console.log(`📧 [DEV] Verification code for ${normalizedEmail}: ${code}`);
    }

    res.status(200).json({
      success: true,
      expiresIn: 60, // Cooldown in seconds
      message: 'Verification code sent to your email'
    });
  })
);

/**
 * @swagger
 * /auth/email/verify/confirm:
 *   post:
 *     summary: Confirm email verification
 *     description: Verify email address with 6-digit OTP code. Updates user's emailVerified status to true.
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
 *                 description: 6-digit numeric code from email
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Email verified successfully
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
 *                   example: Email verified successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         description: Invalid or expired code
 *       404:
 *         description: No pending verification request found
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 */
router.post(
  '/confirm',
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
    const userRepository = container.userRepository;

    // Check if user exists
    const user = await userRepository.findByEmail(normalizedEmail);
    if (!user) {
      throw new NotFoundError('Email not found');
    }

    // Check if there's a valid code
    const hasValidCode = await otpService.hasValidCode(normalizedEmail, 'email_verification');
    if (!hasValidCode) {
      throw new NotFoundError('No pending verification request for this email');
    }

    // Verify the code
    const isValid = await otpService.verifyOTP(normalizedEmail, code, 'email_verification');
    
    if (!isValid) {
      throw new AuthenticationError('Invalid or expired code');
    }

    // Mark email as verified
    await userRepository.updateEmailVerified(normalizedEmail, true);

    console.log(`✅ Email verified for ${normalizedEmail}`);

    res.status(200).json({
      success: true,
      message: 'Email verified successfully'
    });
  })
);

export default router;

