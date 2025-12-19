/**
 * Authentication Routes
 * 
 * Handles user registration, login, token refresh, and logout
 */

import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import { userCreationRateLimit } from '../middleware/security';
import { validateEmail } from '../middleware/validation';
import { AuthService } from '../services/AuthService';
import { LoginRequest, RegisterRequest, RefreshTokenRequest } from '../models/Token';
import { detectTimezoneFromRequest, getDefaultTimezone } from '../utils/timezone';

const router = Router();

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     description: Create a new user account with email and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User email address
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User password (min 8 characters, 1 uppercase, 1 number)
 *                 example: MyPassword123
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                   format: uuid
 *                 email:
 *                   type: string
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     email:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 */
router.post('/register', userCreationRateLimit, asyncHandler(async (req: Request, res: Response) => {
  const { email, password }: RegisterRequest = req.body;

  // Validate required fields
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  // Validate email format
  if (!validateEmail(email)) {
    throw new ValidationError('Invalid email format', 'email');
  }

  // Detect timezone from request (header or body)
  const timezone = detectTimezoneFromRequest(req) || getDefaultTimezone();

  const authService = container.get<AuthService>('authService');
  const result = await authService.register(email, password, timezone);

  res.status(201).json(result);
}));

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     description: Authenticate user with email and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: MyPassword123
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                 email:
 *                   type: string
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 user:
 *                   type: object
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  const { email, password }: LoginRequest = req.body;

  // Validate required fields
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  const authService = container.get<AuthService>('authService');
  const result = await authService.login(email, password);

  res.status(200).json(result);
}));

/**
 * @swagger
 * /auth/google:
 *   post:
 *     summary: Login with Google
 *     description: Authenticate user with Google ID token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idToken
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 * */
router.post('/google', asyncHandler(async (req: Request, res: Response) => {
  console.log('Received Google Login request');
  const { idToken } = req.body;

  if (!idToken) {
    throw new ValidationError('ID token is required');
  }

  const authService = container.get<AuthService>('authService');
  const result = await authService.loginWithGoogle(idToken);

  res.status(200).json(result);
}));

/**
 * @swagger
 * /auth/apple:
 *   post:
 *     summary: Login with Apple
 *     description: Authenticate user with Apple ID token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - identityToken
 *             properties:
 *               identityToken:
 *                 type: string
 *                 description: Apple identity token
 *               user:
 *                 type: object
 *                 description: User data (only provided on first sign-in)
 *                 properties:
 *                   email:
 *                     type: string
 *                   name:
 *                     type: object
 *                     properties:
 *                       firstName:
 *                         type: string
 *                       lastName:
 *                         type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                 email:
 *                   type: string
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 user:
 *                   type: object
 *       401:
 *         description: Invalid Apple token
 */
router.post('/apple', asyncHandler(async (req: Request, res: Response) => {
  console.log('Received Apple Login request');
  const { identityToken, user } = req.body;

  if (!identityToken) {
    throw new ValidationError('Identity token is required');
  }

  const authService = container.get<AuthService>('authService');
  const result = await authService.loginWithApple(identityToken, user);

  res.status(200).json(result);
}));

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     description: Get a new access token using a valid refresh token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Valid refresh token
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken }: RefreshTokenRequest = req.body;

  if (!refreshToken) {
    throw new ValidationError('Refresh token is required', 'refreshToken');
  }

  const authService = container.get<AuthService>('authService');
  const tokens = await authService.refreshAccessToken(refreshToken);

  res.status(200).json(tokens);
}));

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout user
 *     description: Invalidate refresh token (client should also discard tokens)
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logout successful
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
 *                   example: Logged out successfully
 */
router.post('/logout', asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken }: RefreshTokenRequest = req.body;

  // For MVP, we're using stateless JWT tokens
  // In production, you might want to maintain a blacklist of invalidated tokens
  // For now, client should simply discard the tokens

  // Implement token blacklist/revocation
  if (refreshToken) {
    const authService = container.get<AuthService>('authService');
    await authService.revokeRefreshToken(refreshToken);
  }

  res.status(200).json({
    success: true,
    message: 'Logged out successfully.'
  });
}));

export default router;

