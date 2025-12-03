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
 * Returns OAuth2Client for Gmail API access
 */
const getOAuth2Client = (): OAuth2Client => {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Gmail OAuth credentials not configured. Please set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env');
  }

  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
};

// Note: /gmail/auth-url endpoint removed - OAuth is now handled by expo-auth-session on the frontend

/**
 * @swagger
 * /gmail/oauth/callback:
 *   get:
 *     summary: OAuth callback endpoint for mobile
 *     description: Receives OAuth code from Google and redirects to mobile app
 *     tags: [Gmail Integration]
 *     parameters:
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *         description: OAuth authorization code from Google
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: State parameter for CSRF protection
 *     responses:
 *       302:
 *         description: Redirects to mobile app with OAuth code
 */
router.get('/oauth/callback', asyncHandler(async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  
  console.log('📱 Received OAuth callback:', { code: !!code, state, error });
  
  if (error) {
    // OAuth error - redirect back with error
    const deepLink = `snacktrack://oauth/callback?error=${encodeURIComponent(error as string)}`;
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Failed</title>
          <script>
            window.location.href = '${deepLink}';
          </script>
        </head>
        <body>
          <p>Authorization failed. Redirecting back to app...</p>
          <p>If you're not redirected, <a href="${deepLink}">click here</a>.</p>
        </body>
      </html>
    `);
  }
  
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }
  
  try {
    // Exchange code for tokens
    const oAuth2Client = getOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code as string);
    
    console.log('✅ Exchanged code for tokens');
    
    // Redirect back to app with access token
    const deepLink = `snacktrack://oauth/callback?${new URLSearchParams({
      access_token: tokens.access_token!,
      ...(state && { state: state as string }),
    }).toString()}`;
    
    // Show success page with auto-redirect
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Success!</title>
          <script>
            // Try to redirect
            setTimeout(function() {
              window.location.href = '${deepLink}';
            }, 500);
          </script>
        </head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>✅ Authorization Successful!</h2>
          <p>Redirecting back to SnackTrack...</p>
          <p><a href="${deepLink}" style="color: #4CAF50; text-decoration: none; font-weight: bold;">Click here if you're not redirected automatically</a></p>
          <p style="margin-top: 30px; color: #666; font-size: 14px;">You can close this window and return to the app.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('❌ Error exchanging code for tokens:', error);
    const deepLink = `snacktrack://oauth/callback?error=${encodeURIComponent('token_exchange_failed')}`;
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Error</title>
          <script>
            window.location.href = '${deepLink}';
          </script>
        </head>
        <body>
          <p>Failed to complete authorization. Redirecting back to app...</p>
          <p>If you're not redirected, <a href="${deepLink}">click here</a>.</p>
        </body>
      </html>
    `);
  }
}));

/**
 * @swagger
 * /gmail/exchange-token:
 *   post:
 *     summary: Exchange OAuth access token for Gmail connection
 *     description: Frontend sends OAuth access token from expo-auth-session
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
 *               - accessToken
 *             properties:
 *               accessToken:
 *                 type: string
 *                 description: OAuth access token from Google
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
 *         description: Bad request - missing access token
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       500:
 *         description: Internal server error
 */
router.post('/exchange-token', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const { accessToken } = req.body;
  const userId = req.user?.userId;

  if (!accessToken) {
    throw new ValidationError('Access token is required');
  }

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  try {
    console.log(`🔄 Exchanging Gmail OAuth token for user: ${userId}`);
    
    // We don't need to create an OAuth2Client to verify the token
    // The access token from expo-auth-session is already valid
    // We just need to verify it by making a Google API call
    
    // Create a simple OAuth2Client with just the access token
    const oAuth2Client = new google.auth.OAuth2();
    oAuth2Client.setCredentials({ access_token: accessToken });
    
    // Verify the token by getting user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    if (!userInfo.data.email) {
      throw new Error('Could not retrieve user email from Google');
    }

    console.log(`✅ Received Gmail OAuth token for user: ${userId} (${userInfo.data.email})`);

    // Store tokens in database
    // Note: We're storing the access token. For long-term access, we'd need a refresh token
    // which requires server-side OAuth flow. For now, this works for immediate Gmail access.
    const userRepository = container.userRepository;
    const expiryDate = new Date(Date.now() + 3600 * 1000); // 1 hour expiry
    
    await userRepository.updateGmailTokens(
      userId,
      accessToken, // Using access token as refresh token for now
      accessToken,
      expiryDate
    );

    console.log(`✅ Stored Gmail tokens for user: ${userId}`);

    res.json({
      success: true,
      message: 'Gmail connected successfully',
      connected: true
    });
  } catch (error: any) {
    console.error('❌ Error in token exchange:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data
    });
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

