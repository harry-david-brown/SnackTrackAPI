/**
 * Gmail OAuth Routes
 * 
 * Handles Gmail OAuth flow for connecting user Gmail accounts
 */

import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { container } from '../services/core/ServiceContainer';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import { GmailImportService } from '../services/import/GmailImportService';

const router = Router();

/**
 * Gmail OAuth Configuration
 * Returns OAuth2Client with proper redirect URI based on platform
 */
const getOAuth2Client = (platform: 'web' | 'mobile' = 'mobile'): OAuth2Client => {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Gmail OAuth credentials not configured. Please set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env');
  }

  // Choose redirect URI based on platform
  const REDIRECT_URI = platform === 'web' 
    ? (process.env.WEB_REDIRECT_URI || 'http://localhost:8081/oauth-callback')
    : (process.env.MOBILE_REDIRECT_URI || 'snacktrack://oauth/callback');

  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
};

/**
 * @swagger
 * /gmail/auth-url:
 *   get:
 *     summary: Get Gmail OAuth URL (for mobile apps)
 *     description: Returns OAuth URL without redirect - suitable for mobile apps
 *     tags: [Gmail Integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: OAuth URL returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 authUrl:
 *                   type: string
 *                   example: https://accounts.google.com/o/oauth2/v2/auth?...
 *                 state:
 *                   type: string
 *                   example: user-id-123
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       500:
 *         description: Internal server error
 */
router.get('/auth-url', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  
  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  // Get platform from query parameter (web or mobile)
  const platform = (req.query.platform as string)?.toLowerCase() === 'web' ? 'web' : 'mobile';
  
  // Create OAuth2Client with platform-specific redirect URI
  const oAuth2Client = getOAuth2Client(platform);
  const redirectUri = platform === 'web' 
    ? (process.env.WEB_REDIRECT_URI || 'http://localhost:8082/oauth-callback')
    : (process.env.MOBILE_REDIRECT_URI || 'snacktrack://oauth/callback');

  // Generate OAuth URL
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state: userId,
  });

  console.log(`🔐 Gmail OAuth initiated - User: ${userId} | Platform: ${platform} | Redirect: ${redirectUri}`);
  
  res.json({
    authUrl,
    state: userId,
    platform,
    redirectUri // For debugging
  });
}));

/**
 * @swagger
 * /gmail/exchange-token:
 *   post:
 *     summary: Exchange authorization code for tokens (mobile flow)
 *     description: Mobile apps send the authorization code here to complete OAuth
 *     tags: [Gmail Integration]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *             properties:
 *               code:
 *                 type: string
 *                 description: Authorization code from Google OAuth
 *     responses:
 *       200:
 *         description: Gmail connected successfully
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
 *                   example: Gmail connected successfully
 *                 connected:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Bad request - missing code
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       500:
 *         description: Internal server error
 */
router.post('/exchange-token', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.body;
  const userId = req.user?.userId;

  if (!code) {
    throw new ValidationError('Authorization code is required');
  }

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  try {
    const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
    const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
    
    // Use mobile redirect URI if configured, otherwise use web redirect URI
    const REDIRECT_URI = process.env.MOBILE_REDIRECT_URI || process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/gmail/callback';

    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('Gmail OAuth credentials not configured');
    }

    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    
    // Exchange authorization code for tokens
    const { tokens } = await oAuth2Client.getToken(code);
    
    if (!tokens.refresh_token) {
      throw new Error('No refresh token received. User may have already authorized this app.');
    }

    console.log(`✅ Received Gmail OAuth tokens for user: ${userId}`);

    // Store tokens in database
    const userRepository = container.userRepository;
    const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000);
    
    await userRepository.updateGmailTokens(
      userId,
      tokens.refresh_token,
      tokens.access_token || '',
      expiryDate
    );

    console.log(`✅ Stored Gmail tokens for user: ${userId}`);

    res.json({
      success: true,
      message: 'Gmail connected successfully',
      connected: true
    });
  } catch (error) {
    console.error('Error in token exchange:', error);
    throw new ValidationError('Failed to connect Gmail. Please try again.');
  }
}));

/**
 * @swagger
 * /gmail/disconnect:
 *   post:
 *     summary: Disconnect Gmail account
 *     description: Removes Gmail OAuth tokens and disconnects Gmail account
 *     tags: [Gmail Integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Gmail disconnected successfully
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
 *                   example: Gmail account disconnected successfully
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       500:
 *         description: Internal server error
 */
router.post('/disconnect', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const userRepository = container.userRepository;
  await userRepository.disconnectGmail(userId);

  console.log(`✅ Disconnected Gmail for user: ${userId}`);

  res.json({
    success: true,
    message: 'Gmail account disconnected successfully'
  });
}));

/**
 * @swagger
 * /gmail/status:
 *   get:
 *     summary: Check Gmail connection status
 *     description: Returns whether user has Gmail connected
 *     tags: [Gmail Integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Gmail connection status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 connected:
 *                   type: boolean
 *                   example: true
 *                 email:
 *                   type: string
 *                   example: user@example.com
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       500:
 *         description: Internal server error
 */
router.get('/status', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const userRepository = container.userRepository;
  const user = await userRepository.findByIdWithGmailTokens(userId);

  if (!user) {
    throw new ValidationError('User not found');
  }

  res.json({
    connected: user.gmailConnected || false,
    email: user.email
  });
}));

/**
 * @swagger
 * /gmail/import:
 *   post:
 *     summary: Import Uber Eats receipts from Gmail
 *     description: Fetches and parses Uber Eats receipts from connected Gmail account
 *     tags: [Gmail Integration]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               replaceExisting:
 *                 type: boolean
 *                 default: false
 *                 description: If true, delete existing email-based receipts before import
 *     responses:
 *       200:
 *         description: Import completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 totalEmailsFound:
 *                   type: integer
 *                   example: 150
 *                 totalReceiptsProcessed:
 *                   type: integer
 *                   example: 145
 *                 totalReceiptsImported:
 *                   type: integer
 *                   example: 145
 *                 totalAmount:
 *                   type: number
 *                   format: float
 *                   example: 2450.75
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       400:
 *         description: Bad request - Gmail not connected
 *       500:
 *         description: Internal server error
 */
router.post('/import', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const userRepository = container.userRepository;
  const user = await userRepository.findByIdWithGmailTokens(userId);

  if (!user) {
    throw new ValidationError('User not found');
  }

  if (!user.gmailConnected || !user.gmailRefreshToken) {
    throw new ValidationError('Gmail account not connected. Please connect your Gmail account first.');
  }

  const replaceExisting = req.body.replaceExisting === true;

  console.log(`📧 Starting Gmail import for user: ${user.email} (replaceExisting: ${replaceExisting})`);

  const gmailImportService = new GmailImportService(container.postgres);
  const result = await gmailImportService.importFromGmail(user, replaceExisting);

  console.log(`✅ Gmail import completed for user: ${user.email}`);
  console.log(`   - Emails found: ${result.totalEmailsFound}`);
  console.log(`   - Receipts processed: ${result.totalReceiptsProcessed}`);
  console.log(`   - Receipts imported: ${result.totalReceiptsImported}`);
  console.log(`   - Total amount: $${result.totalAmount.toFixed(2)}`);

  res.json({
    success: result.success,
    totalEmailsFound: result.totalEmailsFound,
    totalReceiptsProcessed: result.totalReceiptsProcessed,
    totalReceiptsImported: result.totalReceiptsImported,
    totalAmount: result.totalAmount,
    errors: result.errors
  });
}));

export default router;

