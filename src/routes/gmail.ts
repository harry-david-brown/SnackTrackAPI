/**
 * Gmail OAuth Routes
 * 
 * Handles Gmail OAuth flow for connecting user Gmail accounts
 */

import { Router, Request, Response } from 'express';
import { google, Auth } from 'googleapis';
import { container } from '../services/core/ServiceContainer';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import { GmailImportService } from '../services/import/GmailImportService';
import { ImportLockService } from '../services/import/ImportLockService';
import { User } from '../models/User';

const router = Router();
const REQUIRED_GMAIL_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);

/**
 * Gmail OAuth Configuration
 * Returns OAuth2Client for Gmail API access
 */
const getOAuth2Client = (): Auth.OAuth2Client => {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Gmail OAuth credentials not configured. Please set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env');
  }

  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
};

const normalizeScopes = (scopes: string[] | string | undefined | null): string[] => {
  if (!scopes) {
    return [];
  }

  if (Array.isArray(scopes)) {
    return scopes.filter(Boolean);
  }

  return scopes
    .split(' ')
    .map((scope) => scope.trim())
    .filter(Boolean);
};

const hasRequiredGmailScope = (scopes: string[]): boolean => {
  return scopes.some((scope) => REQUIRED_GMAIL_SCOPES.has(scope));
};

const getConnectionMode = (user: User): 'temporary' | 'offline' | 'none' => {
  if (user.gmailConnectionMode === 'offline' || user.gmailConnectionMode === 'temporary') {
    return user.gmailConnectionMode;
  }
  if (user.gmailRefreshToken) {
    return 'offline';
  }
  if (user.gmailAccessToken) {
    return 'temporary';
  }
  return 'none';
};

const getExpiryDate = (user: User): Date | null => {
  if (!user.gmailTokenExpiry) {
    return null;
  }

  const expiry = new Date(user.gmailTokenExpiry);
  return Number.isNaN(expiry.getTime()) ? null : expiry;
};

const buildGmailStatus = (user: User) => {
  const scopes = user.gmailScopes || [];
  const connectionMode = getConnectionMode(user);
  const expiryDate = getExpiryDate(user);
  const hasRequiredScope = hasRequiredGmailScope(scopes);
  const hasRefreshToken = !!user.gmailRefreshToken;
  const hasAccessToken = !!user.gmailAccessToken;
  const accessTokenUsable = hasAccessToken && (!expiryDate || expiryDate.getTime() > Date.now());
  const canImport = hasRequiredScope && (hasRefreshToken || accessTokenUsable);
  const connected = !!user.gmailConnected && connectionMode !== 'none';
  const needsReconnect = connected && !canImport;

  let statusMessage = 'Connect your Gmail account to import receipts.';
  if (connected && connectionMode === 'offline') {
    statusMessage = 'Gmail is connected with durable access. Imports can refresh automatically.';
  } else if (connected && connectionMode === 'temporary' && canImport && expiryDate) {
    statusMessage = `Gmail is connected with temporary access until ${expiryDate.toISOString()}.`;
  } else if (connected && connectionMode === 'temporary') {
    statusMessage = 'Gmail is connected with temporary access. Reconnect when the token expires.';
  } else if (needsReconnect) {
    statusMessage = 'Gmail needs to be reconnected before imports can run.';
  }

  return {
    connected,
    canImport,
    needsReconnect,
    email: user.gmailEmail || user.email,
    connectionMode,
    scopes,
    hasRequiredScope,
    expiresAt: expiryDate?.toISOString() || null,
    statusMessage,
  };
};

// Note: OAuth is now handled entirely by expo-auth-session on the frontend
// The frontend gets the access token directly and sends it to /gmail/exchange-token

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
  const { accessToken, refreshToken } = req.body;
  const userId = req.user?.userId;

  if (!accessToken) {
    throw new ValidationError('Access token is required');
  }

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  try {
    console.log(`🔄 Exchanging Gmail OAuth token for user: ${userId}`, {
      hasRefreshToken: !!refreshToken
    });

    const oAuth2Client = getOAuth2Client();
    oAuth2Client.setCredentials({ access_token: accessToken });

    const tokenInfo = await oAuth2Client.getTokenInfo(accessToken);
    const scopes = normalizeScopes(tokenInfo.scopes);

    if (!hasRequiredGmailScope(scopes)) {
      throw new ValidationError('Gmail access was granted without a supported Gmail read scope. Please reconnect and approve Gmail access.');
    }

    // Verify the token by getting user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const userInfo = await oauth2.userinfo.get();

    if (!userInfo.data.email) {
      throw new Error('Could not retrieve user email from Google');
    }

    const gmailEmail = userInfo.data.email;
    console.log(`✅ Received Gmail OAuth token for user: ${userId} (${gmailEmail})`);

    const userRepository = container.userRepository;
    const connectionMode: 'temporary' | 'offline' = refreshToken ? 'offline' : 'temporary';
    const expiryDate = typeof (tokenInfo as any).expiry_date === 'number'
      ? new Date((tokenInfo as any).expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    await userRepository.updateGmailTokens(
      userId,
      {
        refreshToken: refreshToken || null,
        accessToken,
        expiryDate,
        gmailEmail,
        scopes,
        connectionMode,
      }
    );

    if (refreshToken) {
      console.log(`✅ Stored refresh token for long-term access`);
    } else {
      console.log(`⚠️  Stored access token only. Users will need to reconnect when it expires.`);
    }

    console.log(`✅ Stored Gmail tokens for user: ${userId}`);

    res.json({
      success: true,
      message: connectionMode === 'offline'
        ? 'Gmail connected successfully'
        : 'Gmail connected with temporary access',
      connected: true,
      connectionMode,
      expiresAt: expiryDate.toISOString(),
      scopes,
    });
  } catch (error: any) {
    console.error('❌ Error in token exchange:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data
    });
    if (error instanceof ValidationError) {
      throw error;
    }
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
    ...buildGmailStatus(user)
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
/**
 * @swagger
 * /gmail/import/status:
 *   get:
 *     summary: Check if import is in progress
 *     description: Returns whether a receipt import is currently running for the user
 *     tags: [Gmail Integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Import status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 inProgress:
 *                   type: boolean
 *                   example: false
 *       401:
 *         description: Unauthorized - missing or invalid token
 */
router.get('/import/status', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const inProgress = await ImportLockService.isLocked(userId);

  res.json({
    inProgress
  });
}));

router.post('/import', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  // Increase timeout to 10 minutes (600000ms) for large imports
  req.setTimeout(600000);

  const userId = req.user?.userId;

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  // Try to acquire import lock - prevents duplicate imports for same user
  const lockAcquired = await ImportLockService.acquireLock(userId);
  if (!lockAcquired) {
    // Import already in progress for this user
    res.status(409).json({
      success: false,
      error: 'Import already in progress',
      message: 'A receipt import is already running for your account. Please wait for it to complete.',
      code: 'IMPORT_IN_PROGRESS'
    });
    return;
  }

  try {
    const userRepository = container.userRepository;
    const user = await userRepository.findByIdWithGmailTokens(userId);

    if (!user) {
      throw new ValidationError('User not found');
    }

    const gmailStatus = buildGmailStatus(user);
    if (!gmailStatus.canImport) {
      throw new ValidationError(
        gmailStatus.needsReconnect
          ? 'Gmail needs to be reconnected before imports can run.'
          : 'Gmail account not connected. Please connect your Gmail account first.'
      );
    }

    console.log(`📧 Starting Gmail import for user: ${user.email} (will replace existing email receipts)`);

    const gmailImportService = new GmailImportService(container.postgres);
    const result = await gmailImportService.importFromGmail(user);

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
  } finally {
    // Always release the lock when done (success or failure)
    await ImportLockService.releaseLock(userId);
  }
}));

export default router;
