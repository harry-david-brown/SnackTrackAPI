/**
 * Gmail OAuth Routes
 * 
 * Handles Gmail OAuth flow for connecting user Gmail accounts
 */

import { Router, Request, Response } from 'express';
import { google, Auth } from 'googleapis';
import jwt from 'jsonwebtoken';
import { container } from '../services/core/ServiceContainer';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import { GmailImportService } from '../services/import/GmailImportService';
import { ImportLockService } from '../services/import/ImportLockService';
import { GmailClient } from '../services/email/GmailClient';
import { User } from '../models/User';
import { authConfig } from '../config/auth';
import { validateApiKey } from '../middleware/security';
import { detectTimezoneFromRequest } from '../utils/timezone';
import { GmailConnectionHealthResult } from '../services/email/GmailConnectionHealthService';
import { resolveTrackingBaseline } from '../services/data/ImportPreferencesRepository';

const router = Router();
const REQUIRED_GMAIL_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);
const GOOGLE_AUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

/**
 * Gmail OAuth Configuration
 * Returns OAuth2Client for Gmail API access
 */
const getCallbackRedirectUri = (): string => {
  const redirectUri = process.env.GMAIL_REDIRECT_URI?.trim();
  if (!redirectUri) {
    throw new Error('GMAIL_REDIRECT_URI is not configured');
  }
  return redirectUri;
};

const getOAuth2Client = (redirectUri?: string): Auth.OAuth2Client => {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID?.trim();
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET?.trim();

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Gmail OAuth credentials not configured. Please set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env');
  }

  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
};

interface GmailOAuthStatePayload {
  userId: string;
  redirectUri: string;
  purpose: GmailConnectionPurpose;
}

const GMAIL_CONNECTION_PURPOSES = [
  'receipt_import',
  'export_ready_alerts',
  'ongoing_tracking',
  'connection_recovery',
  'manage_connection',
] as const;
type GmailConnectionPurpose = typeof GMAIL_CONNECTION_PURPOSES[number];

const isGmailConnectionPurpose = (value: unknown): value is GmailConnectionPurpose =>
  typeof value === 'string' && GMAIL_CONNECTION_PURPOSES.includes(value as GmailConnectionPurpose);

const signOAuthState = (payload: GmailOAuthStatePayload): string => {
  return jwt.sign(payload, authConfig.getJWTSecret(), {
    expiresIn: '10m',
    issuer: 'snacktrack-gmail-oauth',
  });
};

const verifyOAuthState = (state: string): GmailOAuthStatePayload => {
  return jwt.verify(state, authConfig.getJWTSecret(), {
    issuer: 'snacktrack-gmail-oauth',
  }) as GmailOAuthStatePayload;
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

const buildGmailStatus = (user: User, health?: GmailConnectionHealthResult) => {
  const scopes = user.gmailScopes || [];
  const connectionMode = getConnectionMode(user);
  const expiryDate = getExpiryDate(user);
  const hasRequiredScope = hasRequiredGmailScope(scopes);
  const hasRefreshToken = !!user.gmailRefreshToken;
  const hasAccessToken = !!user.gmailAccessToken;
  const accessTokenUsable = hasAccessToken && (!expiryDate || expiryDate.getTime() > Date.now());
  const credentialRejected = health?.status === 'reconnect_required';
  const canImport = hasRequiredScope && (hasRefreshToken || accessTokenUsable) && !credentialRejected;
  const connected = !!user.gmailConnected && connectionMode !== 'none';
  const needsReconnect = credentialRejected || (connected && !canImport);

  let statusMessage = 'Connect your Gmail account to import receipts.';
  if (needsReconnect) {
    statusMessage = 'Gmail needs to be reconnected before imports can run.';
  } else if (connected && connectionMode === 'offline') {
    statusMessage = 'Gmail is connected with durable access for imports you explicitly allow.';
  } else if (connected && connectionMode === 'temporary' && canImport && expiryDate) {
    statusMessage = `Gmail is connected with temporary access until ${expiryDate.toISOString()}.`;
  } else if (connected && connectionMode === 'temporary') {
    statusMessage = 'Gmail is connected with temporary access. Reconnect when the token expires.';
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
    connectionHealth: health?.status ?? (connected ? 'valid' : 'disconnected'),
    lastValidatedAt: health?.validatedAt ?? null,
    statusMessage,
  };
};

const getValidatedGmailStatus = async (userId: string, force = false) => {
  let user = await container.userRepository.findByIdWithGmailTokens(userId);
  if (!user) throw new ValidationError('User not found');
  const health = await container.gmailConnectionHealthService.validate(user, force);
  if (health.status === 'reconnect_required') {
    user = await container.userRepository.findByIdWithGmailTokens(userId);
    if (!user) throw new ValidationError('User not found');
  }
  return { user, health, status: buildGmailStatus(user, health) };
};

const buildImportPreferencesResponse = async (userId: string) => {
  const { user, status: gmailStatus } = await getValidatedGmailStatus(userId);

  const preferences = await container.importPreferencesRepository.get(userId);
  const sourceResult = await container.postgres.query(
    `SELECT
       COUNT(*) FILTER (WHERE data_source = 'email')::int AS email_count,
       COUNT(*) FILTER (WHERE data_source = 'csv')::int AS export_count,
       COUNT(*) FILTER (
         WHERE data_source = 'csv' AND receipt_type = 'uber_eats'
       )::int AS uber_eats_export_count,
       COUNT(*) FILTER (
         WHERE data_source = 'csv' AND receipt_type = 'doordash'
       )::int AS doordash_export_count,
       MIN(order_date) FILTER (
         WHERE data_source = 'csv' AND receipt_type = 'uber_eats'
       ) AS uber_eats_export_earliest,
       MAX(order_date) FILTER (
         WHERE data_source = 'csv' AND receipt_type = 'uber_eats'
       ) AS uber_eats_export_latest,
       MIN(order_date) FILTER (
         WHERE data_source = 'csv' AND receipt_type = 'doordash'
       ) AS doordash_export_earliest,
       MAX(order_date) FILTER (
         WHERE data_source = 'csv' AND receipt_type = 'doordash'
       ) AS doordash_export_latest
     FROM receipts WHERE user_id = $1`,
    [userId]
  );
  const emailReceiptCount = Number(sourceResult.rows[0]?.email_count || 0);
  const exportReceiptCount = Number(sourceResult.rows[0]?.export_count || 0);
  const uberEatsExportReceiptCount = Number(sourceResult.rows[0]?.uber_eats_export_count || 0);
  const doorDashExportReceiptCount = Number(sourceResult.rows[0]?.doordash_export_count || 0);
  const toIsoString = (value: unknown): string | null => value instanceof Date
    ? value.toISOString()
    : typeof value === 'string' ? value : null;
  const uberEatsExportEarliest = toIsoString(sourceResult.rows[0]?.uber_eats_export_earliest);
  const uberEatsExportLatest = toIsoString(sourceResult.rows[0]?.uber_eats_export_latest);
  const doorDashExportEarliest = toIsoString(sourceResult.rows[0]?.doordash_export_earliest);
  const doorDashExportLatest = toIsoString(sourceResult.rows[0]?.doordash_export_latest);
  const trackingBaseline = resolveTrackingBaseline({
    gmailBaselineCompletedAt: preferences.gmailBaselineCompletedAt,
    uberEatsExportCount: uberEatsExportReceiptCount,
    doorDashExportCount: doorDashExportReceiptCount,
  });
  const providerExports = await container.importPreferencesRepository.getProviderExports(userId);
  const providerStatuses = [providerExports.uber_eats.status, providerExports.doordash.status];
  // Compatibility summary for older clients. Provider-specific UI must use
  // export.providers plus receipt-derived coverage instead of this value.
  const aggregateExportStatus = providerStatuses.includes('file_ready')
    ? 'file_ready'
    : providerStatuses.includes('import_processing')
      ? 'import_processing'
      : providerStatuses.includes('requested')
        ? preferences.monitoringConsentState === 'granted'
          ? 'requested_monitoring_enabled'
          : 'requested_monitoring_disabled'
        : providerStatuses.includes('failed')
          ? 'failed'
          : providerStatuses.includes('completed')
            ? 'completed'
            : 'not_started';
  const providerRequestedDates = [providerExports.uber_eats.requestedAt, providerExports.doordash.requestedAt]
    .filter((value): value is string => Boolean(value))
    .sort();
  const providerUpdatedDates = [providerExports.uber_eats.updatedAt, providerExports.doordash.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort();
  const ordersAddedThisWeek = await container.importPreferencesRepository.getOrdersAddedThisWeek(
    userId,
    user.timezone || 'America/New_York'
  );

  let effectiveState: 'not_offered' | 'declined' | 'enabled' | 'disabled' | 'reconnect_required';
  if (preferences.monitoringConsentState === 'granted') {
    effectiveState = gmailStatus.connected
      && gmailStatus.canImport
      && gmailStatus.connectionMode === 'offline'
      ? 'enabled'
      : 'reconnect_required';
  } else if (preferences.monitoringConsentState === 'declined') {
    effectiveState = 'declined';
  } else if (preferences.monitoringConsentState === 'revoked') {
    effectiveState = 'disabled';
  } else {
    effectiveState = 'not_offered';
  }

  let ongoingTrackingEffectiveState: 'not_offered' | 'declined' | 'setting_up' | 'active' | 'paused' | 'reconnect_required' | 'error';
  if (preferences.ongoingTrackingConsentState === 'granted') {
    if (!gmailStatus.connected || !gmailStatus.canImport || gmailStatus.connectionMode !== 'offline') {
      ongoingTrackingEffectiveState = 'reconnect_required';
    } else if (preferences.trackingStatus === 'error') {
      ongoingTrackingEffectiveState = 'error';
    } else if (preferences.trackingStatus === 'setting_up') {
      ongoingTrackingEffectiveState = 'setting_up';
    } else if (preferences.trackingStatus === 'inactive' || preferences.trackingStatus === 'paused') {
      ongoingTrackingEffectiveState = 'paused';
    } else {
      ongoingTrackingEffectiveState = 'active';
    }
  } else if (preferences.ongoingTrackingConsentState === 'declined') {
    ongoingTrackingEffectiveState = 'declined';
  } else if (preferences.ongoingTrackingConsentState === 'revoked') {
    ongoingTrackingEffectiveState = 'paused';
  } else {
    ongoingTrackingEffectiveState = 'not_offered';
  }

  return {
    monitoring: {
      consentState: preferences.monitoringConsentState,
      consentVersion: preferences.monitoringConsentVersion,
      consentedAt: preferences.monitoringConsentedAt,
      revokedAt: preferences.monitoringRevokedAt,
      effectiveState,
      capability: {
        gmailConnected: gmailStatus.connected,
        durableAccess: gmailStatus.connectionMode === 'offline',
        needsReconnect: gmailStatus.needsReconnect,
        connectionHealth: gmailStatus.connectionHealth,
        lastValidatedAt: gmailStatus.lastValidatedAt,
        canMonitor: gmailStatus.connectionHealth === 'valid'
          && gmailStatus.connected
          && gmailStatus.canImport
          && gmailStatus.connectionMode === 'offline',
      },
    },
    export: {
      status: aggregateExportStatus,
      requestedAt: providerRequestedDates.at(-1) ?? null,
      updatedAt: aggregateExportStatus === 'file_ready'
        ? [providerExports.uber_eats, providerExports.doordash]
          .find((provider) => provider.status === 'file_ready')?.updatedAt ?? null
        : providerUpdatedDates.at(-1) ?? null,
      providers: {
        uberEats: providerExports.uber_eats,
        doorDash: providerExports.doordash,
      },
    },
    gmailImport: {
      status: preferences.gmailImportStatus,
      updatedAt: preferences.gmailImportUpdatedAt,
      importedCount: preferences.gmailImportedCount,
      errorCode: preferences.gmailImportErrorCode,
      receiptCount: emailReceiptCount,
      hasImported: preferences.gmailBaselineCompletedAt !== null,
    },
    gmailBaseline: {
      hasCompleted: preferences.gmailBaselineCompletedAt !== null,
      completedAt: preferences.gmailBaselineCompletedAt,
      latestAttempt: {
        status: preferences.gmailImportStatus,
        updatedAt: preferences.gmailImportUpdatedAt,
        importedCount: preferences.gmailImportedCount,
        errorCode: preferences.gmailImportErrorCode,
      },
    },
    ongoingTracking: {
      consentState: preferences.ongoingTrackingConsentState,
      consentVersion: preferences.ongoingTrackingConsentVersion,
      consentedAt: preferences.ongoingTrackingConsentedAt,
      revokedAt: preferences.ongoingTrackingRevokedAt,
      status: preferences.trackingStatus,
      effectiveState: ongoingTrackingEffectiveState,
      baseline: {
        eligible: trackingBaseline.eligible,
        source: trackingBaseline.source,
      },
      capability: {
        gmailConnected: gmailStatus.connected,
        durableAccess: gmailStatus.connectionMode === 'offline',
        needsReconnect: gmailStatus.needsReconnect,
        connectionHealth: gmailStatus.connectionHealth,
        lastValidatedAt: gmailStatus.lastValidatedAt,
        canTrack: gmailStatus.connectionHealth === 'valid'
          && gmailStatus.connected && gmailStatus.canImport && gmailStatus.connectionMode === 'offline',
      },
      activity: {
        lastCheckAttemptAt: preferences.lastCheckAttemptAt,
        lastSuccessfulCheckAt: preferences.lastSuccessfulCheckAt,
        lastStatsUpdatedAt: preferences.lastStatsUpdatedAt,
        lastNewOrderAt: preferences.lastNewOrderAt,
        ordersAddedThisWeek,
        lastErrorAt: preferences.lastTrackingErrorAt,
        lastErrorCode: preferences.lastTrackingErrorCode,
      },
    },
    coverage: {
      emailReceiptCount,
      exportReceiptCount,
      hasEmailData: emailReceiptCount > 0,
      hasExportData: exportReceiptCount > 0,
      exportProviders: {
        uberEats: {
          receiptCount: uberEatsExportReceiptCount,
          hasData: uberEatsExportReceiptCount > 0,
          earliestOrderDate: uberEatsExportEarliest,
          latestOrderDate: uberEatsExportLatest,
        },
        doorDash: {
          receiptCount: doorDashExportReceiptCount,
          hasData: doorDashExportReceiptCount > 0,
          earliestOrderDate: doorDashExportEarliest,
          latestOrderDate: doorDashExportLatest,
        },
      },
    },
  };
};

router.post('/auth-url', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const { redirectUri, purpose } = req.body;

  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  if (!redirectUri || typeof redirectUri !== 'string') {
    throw new ValidationError('redirectUri is required');
  }

  if (purpose !== undefined && !isGmailConnectionPurpose(purpose)) {
    throw new ValidationError('purpose is invalid');
  }
  const connectionPurpose: GmailConnectionPurpose = purpose ?? 'receipt_import';

  let parsedRedirectUri: URL;
  try {
    parsedRedirectUri = new URL(redirectUri);
  } catch {
    throw new ValidationError('redirectUri must be a valid absolute URI');
  }

  const allowedSchemes = ['snacktrack:', 'exp+snack-track:', 'https:', 'http:'];
  if (!allowedSchemes.includes(parsedRedirectUri.protocol)) {
    throw new ValidationError('redirectUri uses an unsupported scheme');
  }

  const callbackRedirectUri = getCallbackRedirectUri();
  const oAuth2Client = getOAuth2Client(callbackRedirectUri);
  const state = signOAuthState({
    userId,
    redirectUri,
    purpose: connectionPurpose,
  });

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...GOOGLE_AUTH_SCOPES],
    state,
  });

  res.json({
    success: true,
    authUrl,
  });
}));

router.get('/callback', asyncHandler(async (req: Request, res: Response) => {
  const { code, state, error } = req.query;

  let appRedirectUri = 'snacktrack://oauth-callback';

  try {
    if (typeof state !== 'string') {
      throw new ValidationError('Missing OAuth state');
    }

    const decodedState = verifyOAuthState(state);
    appRedirectUri = decodedState.redirectUri;

    if (error) {
      const errorRedirect = new URL(appRedirectUri);
      errorRedirect.searchParams.set('gmail', 'error');
      errorRedirect.searchParams.set('error', String(error));
      errorRedirect.searchParams.set('gmailPurpose', decodedState.purpose);
      res.redirect(errorRedirect.toString());
      return;
    }

    if (!code || typeof code !== 'string') {
      throw new ValidationError('Missing authorization code');
    }

    const callbackRedirectUri = getCallbackRedirectUri();
    const oAuth2Client = getOAuth2Client(callbackRedirectUri);
    const tokenResponse = await oAuth2Client.getToken(code);
    const tokens = tokenResponse.tokens;

    if (!tokens.access_token) {
      throw new Error('Google did not return an access token');
    }

    const scopes = normalizeScopes(tokens.scope);
    if (!hasRequiredGmailScope(scopes)) {
      throw new ValidationError('Gmail access was granted without a supported Gmail read scope.');
    }

    oAuth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const userInfo = await oauth2.userinfo.get();

    if (!userInfo.data.email) {
      throw new Error('Could not retrieve user email from Google');
    }

    const userRepository = container.userRepository;
    const connectionMode: 'temporary' | 'offline' = tokens.refresh_token ? 'offline' : 'temporary';
    const expiryDate = typeof tokens.expiry_date === 'number'
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    await userRepository.updateGmailTokens(decodedState.userId, {
      refreshToken: tokens.refresh_token || null,
      accessToken: tokens.access_token,
      expiryDate,
      gmailEmail: userInfo.data.email,
      scopes,
      connectionMode,
    });
    container.gmailConnectionHealthService.invalidate(decodedState.userId);

    const successRedirect = new URL(appRedirectUri);
    successRedirect.searchParams.set('gmail', 'success');
    successRedirect.searchParams.set('connectionMode', connectionMode);
    successRedirect.searchParams.set('gmailPurpose', decodedState.purpose);
    res.redirect(successRedirect.toString());
  } catch (callbackError: any) {
    console.error('❌ Gmail OAuth callback failed:', callbackError);
    const errorRedirect = new URL(appRedirectUri);
    errorRedirect.searchParams.set('gmail', 'error');
    errorRedirect.searchParams.set('error', callbackError.message || 'gmail_oauth_failed');
    const callbackPurpose = typeof state === 'string'
      ? (() => {
          try {
            return verifyOAuthState(state).purpose;
          } catch {
            return null;
          }
        })()
      : null;
    if (callbackPurpose) errorRedirect.searchParams.set('gmailPurpose', callbackPurpose);
    res.redirect(errorRedirect.toString());
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
  const resetImportStatus = req.body?.resetImportStatus === true;
  const preferences = await container.importPreferencesRepository.get(userId);
  await userRepository.disconnectGmail(userId);
  container.gmailConnectionHealthService.invalidate(userId);
  if (preferences.monitoringConsentState === 'granted') {
    await container.importPreferencesRepository.setMonitoringConsent(userId, 'revoked');
  }
  if (preferences.ongoingTrackingConsentState === 'granted') {
    await container.importPreferencesRepository.setOngoingTrackingConsent(userId, 'revoked');
  }
  if (resetImportStatus) {
    await container.importPreferencesRepository.resetGmailImportStatus(userId);
  }

  console.log(`✅ Disconnected Gmail for user: ${userId}`);

  res.json({
    success: true,
    message: 'Gmail account disconnected successfully'
  });
}));

router.get('/preferences', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const requestTimezone = detectTimezoneFromRequest(req);
  if (requestTimezone) {
    await container.userRepository.updateTimezone(userId, requestTimezone);
  }
  res.json(await buildImportPreferencesResponse(userId));
}));

router.put('/preferences/monitoring-consent', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const decision = req.body?.decision;
  if (typeof decision !== 'string' || !['granted', 'declined', 'revoked'].includes(decision)) {
    throw new ValidationError('decision must be granted, declined, or revoked');
  }
  const validatedDecision = decision as 'granted' | 'declined' | 'revoked';

  const consentVersion = req.body?.consentVersion;
  if (validatedDecision === 'granted') {
    if (
      typeof consentVersion !== 'string'
      || consentVersion.trim().length === 0
      || consentVersion.length > 50
    ) {
      throw new ValidationError('consentVersion is required when granting monitoring consent');
    }
  }

  await container.importPreferencesRepository.setMonitoringConsent(
    userId,
    validatedDecision,
    typeof consentVersion === 'string' ? consentVersion.trim() : undefined
  );

  res.json(await buildImportPreferencesResponse(userId));
}));

router.put('/preferences/ongoing-tracking-consent', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) throw new ValidationError('User ID not found in token');
  const decision = req.body?.decision;
  if (typeof decision !== 'string' || !['granted', 'declined', 'revoked'].includes(decision)) {
    throw new ValidationError('decision must be granted, declined, or revoked');
  }
  const consentVersion = req.body?.consentVersion;
  if (decision === 'granted' && (typeof consentVersion !== 'string' || !consentVersion.trim() || consentVersion.length > 50)) {
    throw new ValidationError('consentVersion is required when granting ongoing tracking consent');
  }
  if (decision === 'granted') {
    const baseline = await container.importPreferencesRepository.getTrackingBaseline(userId);
    if (!baseline.eligible) {
      res.status(409).json({
        success: false,
        code: 'HISTORICAL_BASELINE_REQUIRED',
        message: 'Import Gmail history or a provider export before enabling ongoing tracking.',
      });
      return;
    }
    const { health, status: gmailStatus } = await getValidatedGmailStatus(userId, true);
    if (health.status === 'unavailable') {
      res.status(503).json({
        success: false,
        code: 'GMAIL_VALIDATION_UNAVAILABLE',
        message: 'Gmail could not be reached. Your connection is unchanged; try again shortly.',
      });
      return;
    }
    if (
      health.status !== 'valid'
      || !gmailStatus.connected
      || gmailStatus.connectionMode !== 'offline'
    ) {
      res.status(409).json({
        success: false,
        code: 'GMAIL_RECONNECT_REQUIRED',
        message: 'Reconnect Gmail with durable access before enabling ongoing tracking.',
      });
      return;
    }
  }
  await container.importPreferencesRepository.setOngoingTrackingConsent(
    userId,
    decision as 'granted' | 'declined' | 'revoked',
    typeof consentVersion === 'string' ? consentVersion.trim() : undefined
  );
  res.json(await buildImportPreferencesResponse(userId));
}));

router.post('/tracking/check', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) throw new ValidationError('User ID not found in token');
  const result = await container.ongoingTrackingService.checkUser(userId);
  if (!result) {
    res.status(409).json({
      success: false,
      code: 'TRACKING_NOT_AVAILABLE',
      message: 'Ongoing tracking is not enabled, Gmail needs reconnection, or a check is already running.',
      preferences: await buildImportPreferencesResponse(userId),
    });
    return;
  }
  res.json({ ...result, preferences: await buildImportPreferencesResponse(userId) });
}));

// Scheduler-ready entry point. Production can call this with X-API-Key at the
// desired cadence without granting the scheduler access to user credentials.
router.post('/tracking/run-batch', validateApiKey, asyncHandler(async (req: Request, res: Response) => {
  const limit = typeof req.body?.limit === 'number' ? req.body.limit : 100;
  res.json(await container.ongoingTrackingService.runEligibleBatch(limit));
}));

router.post('/preferences/export-requested', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const provider = req.body?.provider;
  if (provider !== 'uber_eats' && provider !== 'doordash') {
    throw new ValidationError('provider must be uber_eats or doordash');
  }
  await container.importPreferencesRepository.markExportRequested(userId, provider);
  res.json(await buildImportPreferencesResponse(userId));
}));

router.post('/preferences/export-ready', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const provider = req.body?.provider;
  if (provider !== 'uber_eats' && provider !== 'doordash') {
    throw new ValidationError('provider must be uber_eats or doordash');
  }

  const updated = await container.importPreferencesRepository.confirmExportReady(userId, provider);
  if (!updated) {
    res.status(409).json({
      success: false,
      code: 'EXPORT_ALREADY_PROCESSING',
      message: 'This provider archive is already being processed.',
    });
    return;
  }
  res.json(await buildImportPreferencesResponse(userId));
}));

router.post('/preferences/check-export-ready', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    throw new ValidationError('User ID not found in token');
  }

  const preferences = await container.importPreferencesRepository.get(userId);
  const providerExports = await container.importPreferencesRepository.getProviderExports(userId);
  const uberExport = providerExports.uber_eats;
  if (
    preferences.monitoringConsentState !== 'granted'
    || uberExport.status !== 'requested'
    || !uberExport.requestedAt
  ) {
    res.json({
      detected: false,
      preferences: await buildImportPreferencesResponse(userId),
    });
    return;
  }

  const { user, health, status: gmailStatus } = await getValidatedGmailStatus(userId);
  if (health.status !== 'valid' || !gmailStatus.connected || !gmailStatus.canImport || gmailStatus.connectionMode !== 'offline') {
    res.json({
      detected: false,
      preferences: await buildImportPreferencesResponse(userId),
    });
    return;
  }

  const detected = await new GmailClient().hasUberExportReadyEmail(
    user,
    uberExport.requestedAt
  );
  if (detected) {
    await container.importPreferencesRepository.setExportStatus(
      userId,
      'uber_eats',
      'file_ready',
      undefined,
      'detected_email'
    );
  }

  res.json({
    detected,
    preferences: await buildImportPreferencesResponse(userId),
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

  const { status } = await getValidatedGmailStatus(userId);
  res.json(status);
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

  // Force a fresh lightweight Google validation before starting a sync run or
  // acquiring the longer-lived import lock.
  const { user, health, status: gmailStatus } = await getValidatedGmailStatus(userId, true);
  if (health.status === 'reconnect_required' || gmailStatus.needsReconnect) {
    res.status(409).json({
      success: false,
      code: 'GMAIL_RECONNECT_REQUIRED',
      message: 'Your Gmail authorization is no longer valid. Reconnect Gmail to continue.',
    });
    return;
  }
  if (health.status === 'unavailable') {
    res.status(503).json({
      success: false,
      code: 'GMAIL_VALIDATION_UNAVAILABLE',
      message: 'Gmail could not be reached to verify the connection. Please try again shortly.',
    });
    return;
  }
  if (!gmailStatus.canImport) {
    throw new ValidationError(
      gmailStatus.needsReconnect
        ? 'Gmail needs to be reconnected before imports can run.'
        : 'Gmail account not connected. Please connect your Gmail account first.'
    );
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
    console.log(`📧 Starting incremental Gmail receipt sync for user: ${user.email}`);

    const gmailImportService = new GmailImportService(container.postgres);
    const result = await gmailImportService.importFromGmail(user);

    console.log(`${result.success ? '✅ Gmail import completed' : '❌ Gmail import failed'} for user: ${user.email}`);
    console.log(`   - Emails found: ${result.totalEmailsFound}`);
    console.log(`   - Receipts processed: ${result.totalReceiptsProcessed}`);
    console.log(`   - Receipts imported: ${result.totalReceiptsImported}`);
    console.log(`   - New: ${result.newOrders}, updated: ${result.updatedOrders}, unchanged: ${result.unchangedOrders}`);
    console.log(`   - Total amount: $${result.totalAmount.toFixed(2)}`);

    const responseBody = {
      success: result.success,
      totalEmailsFound: result.totalEmailsFound,
      totalReceiptsProcessed: result.totalReceiptsProcessed,
      emailsExamined: result.emailsExamined,
      supportedReceiptsFound: result.supportedReceiptsFound,
      exportCoveredReceipts: result.exportCoveredReceipts,
      eligibleReceipts: result.eligibleReceipts,
      deduplicatedReceipts: result.deduplicatedReceipts,
      totalReceiptsImported: result.totalReceiptsImported,
      newOrders: result.newOrders,
      updatedOrders: result.updatedOrders,
      unchangedOrders: result.unchangedOrders,
      totalAmount: result.totalAmount,
      errors: result.errors,
      code: result.errorCode,
      message: result.errorCode === 'GMAIL_RECONNECT_REQUIRED'
        ? 'Your Gmail authorization is no longer valid. Reconnect Gmail to continue.'
        : result.success ? undefined : 'Gmail import failed. Please try again.'
    };

    if (!result.success) {
      res.status(result.errorCode === 'GMAIL_RECONNECT_REQUIRED' ? 409 : 502).json(responseBody);
      return;
    }
    res.json(responseBody);
  } finally {
    // Always release the lock when done (success or failure)
    await ImportLockService.releaseLock(userId);
  }
}));

export default router;
