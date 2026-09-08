import { Router, type RequestHandler, type Response } from 'express';
import { ValidationError } from '../core/errors';
import { asyncHandler } from '../middleware/errorHandler';
import { requireObject, requireStringField, requireUuid } from '../http/validation/requestValues';
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from '../middleware/adminAuth';
import type { AdminAuthService, CreatedAdminSession } from '../services/admin/AdminAuthService';
import { isAdminRole, type AdminStatus } from '../services/admin/AdminTypes';
import type { AdminAnalyticsQueryService } from '../services/analytics/AdminAnalyticsService';
import type {
  AdminManagementService,
  AdminTimelineCategory,
  AdminUserIssue,
  AdminUserSort,
} from '../services/admin/AdminManagementService';
import type { AdminQueueOperationsService } from '../services/admin/AdminQueueOperationsService';
import type { AdConfigurationService } from '../services/ads/AdConfigurationService';
import { AD_PLACEMENTS, AD_PLACEMENTS_V2, type AdPlacement, type AdPlacementV2 } from '../services/ads/AdConfigurationTypes';

interface AdminRouterDependencies {
  auth: AdminAuthService;
  analytics: AdminAnalyticsQueryService;
  ads: Pick<AdConfigurationService, 'get' | 'update' | 'kill'>;
  management: AdminManagementService;
  authenticate: RequestHandler;
  requireCsrf: RequestHandler;
  requireOwner: RequestHandler;
  requireOperator: RequestHandler;
  databaseHealth: { check(): Promise<{ status: string; latencyMs: number | null; errorCode?: string }> };
  cache: { getStats(): Promise<unknown> };
  alerting: { getHealthStatus(): unknown };
  queues: Pick<AdminQueueOperationsService, 'status' | 'cancelPending'>;
  production: boolean;
}

const cookieOptions = (production: boolean) => `Path=/admin; Max-Age=${8 * 60 * 60}; SameSite=Strict${production ? '; Secure' : ''}`;
const setSessionCookies = (response: Response, session: CreatedAdminSession, production: boolean) => {
  response.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}; HttpOnly; ${cookieOptions(production)}`);
  response.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=${encodeURIComponent(session.csrfToken)}; ${cookieOptions(production)}`);
};
const clearSessionCookies = (response: Response, production: boolean) => {
  const suffix = `Path=/admin; Max-Age=0; SameSite=Strict${production ? '; Secure' : ''}`;
  response.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; ${suffix}`);
  response.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=; ${suffix}`);
};
const string = (body: unknown, field: string) => requireStringField(body, field);
const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ValidationError('Must be a string', field);
  return value.trim() || undefined;
};
const dateRange = (query: Record<string, unknown>) => {
  const to = optionalString(query.to, 'to') ? new Date(String(query.to)) : new Date();
  const from = optionalString(query.from, 'from') ? new Date(String(query.from)) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new ValidationError('Invalid date range');
  if (to.getTime() - from.getTime() > 397 * 86_400_000) throw new ValidationError('Date range cannot exceed 13 months');
  return { from, to };
};
const integer = (value: unknown, fallback: number, min: number, max: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ValidationError(`Must be ${min}–${max}`);
  return parsed;
};
const requiredBoolean = (body: Record<string, unknown>, field: string): boolean => {
  if (typeof body[field] !== 'boolean') throw new ValidationError('Must be true or false', field);
  return body[field] as boolean;
};
const requiredInteger = (body: Record<string, unknown>, field: string, min: number, max: number): number => {
  const value = body[field];
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ValidationError(`Must be ${min}–${max}`, field);
  }
  return Number(value);
};

export const createAdminRouter = (d: AdminRouterDependencies): Router => {
  const router = Router();

  router.post('/auth/login', asyncHandler(async (req, res) => {
    const session = await d.auth.login(string(req.body, 'email'), string(req.body, 'password'));
    setSessionCookies(res, session, d.production);
    res.json({ admin: session.admin, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  }));
  router.post('/auth/forgot-password', asyncHandler(async (req, res) => {
    await d.auth.requestPasswordReset(string(req.body, 'email'));
    res.json({ success: true });
  }));
  router.post('/auth/reset-password', asyncHandler(async (req, res) => {
    await d.auth.resetPassword(string(req.body, 'token'), string(req.body, 'password'));
    res.json({ success: true });
  }));
  router.post('/invitations/:token/accept', asyncHandler(async (req, res) => {
    const session = await d.auth.acceptInvitation(req.params.token, string(req.body, 'password'));
    setSessionCookies(res, session, d.production);
    res.status(201).json({ admin: session.admin, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  }));

  router.use(d.authenticate);
  router.get('/auth/session', asyncHandler(async (req, res) => res.json({ admin: req.admin })));
  router.post('/auth/logout', d.requireCsrf, asyncHandler(async (req, res) => {
    await d.auth.logout(req.adminSessionToken!);
    clearSessionCookies(res, d.production);
    res.json({ success: true });
  }));

  router.get('/analytics/overview', asyncHandler(async (req, res) => { const range = dateRange(req.query as Record<string, unknown>); res.json(await d.analytics.overview(range.from, range.to)); }));
  router.get('/analytics/funnel', asyncHandler(async (req, res) => {
    const range = dateRange(req.query as Record<string, unknown>);
    const kind = optionalString(req.query.kind, 'kind') ?? 'activation';
    if (kind !== 'activation' && kind !== 'wrapped' && kind !== 'export') throw new ValidationError('Invalid funnel kind', 'kind');
    res.json(await d.analytics.funnel(range.from, range.to, kind));
  }));
  router.get('/analytics/retention', asyncHandler(async (req, res) => { const range = dateRange(req.query as Record<string, unknown>); res.json(await d.analytics.retention(range.from, range.to)); }));
  router.get('/analytics/features', asyncHandler(async (req, res) => { const range = dateRange(req.query as Record<string, unknown>); res.json(await d.analytics.features(range.from, range.to)); }));
  router.get('/analytics/ads', asyncHandler(async (req, res) => { const range = dateRange(req.query as Record<string, unknown>); res.json(await d.analytics.ads(range.from, range.to)); }));

  router.get('/ads/config', asyncHandler(async (_req, res) => res.json(await d.ads.get())));
  router.patch('/ads/config', d.requireOwner, d.requireCsrf, asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const placement = string(body, 'placement');
    if (!AD_PLACEMENTS.includes(placement as AdPlacement)) throw new ValidationError('Invalid placement', 'placement');
    const placements = body.placements;
    if (!Array.isArray(placements) || placements.some((value) => typeof value !== 'string' || !AD_PLACEMENTS_V2.includes(value as AdPlacementV2))) {
      throw new ValidationError('Invalid placements', 'placements');
    }
    res.json(await d.ads.update({
      enabled: requiredBoolean(body, 'enabled'),
      iosRolloutPercent: requiredInteger(body, 'iosRolloutPercent', 0, 100),
      androidRolloutPercent: requiredInteger(body, 'androidRolloutPercent', 0, 100),
      placement: placement as AdPlacement,
      placements: placements as AdPlacementV2[],
      maxImpressionsPerSession: requiredInteger(body, 'maxImpressionsPerSession', 1, 3),
      maxImpressionsPerDay: requiredInteger(body, 'maxImpressionsPerDay', 1, 10),
      minimumReceiptCount: requiredInteger(body, 'minimumReceiptCount', 1, 100),
      expectedVersion: requiredInteger(body, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER),
      actorAdminId: req.admin!.id,
      reason: string(body, 'reason'),
      requestId: req.requestId,
    }));
  }));
  router.post('/ads/kill', d.requireOwner, d.requireCsrf, asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    res.json(await d.ads.kill({ actorAdminId: req.admin!.id, reason: string(body, 'reason'), requestId: req.requestId }));
  }));

  router.get('/operations/health', d.requireOperator, asyncHandler(async (_req, res) => {
    const database = await d.databaseHealth.check();
    const now = new Date();
    const recentImports = await d.management.imports(new Date(now.getTime() - 24 * 60 * 60 * 1000), now);
    res.json({ timestamp: now.toISOString(), database, cache: await d.cache.getStats(), instance: { scope: 'current_process', uptimeSeconds: process.uptime(), alerting: d.alerting.getHealthStatus() }, recentImports });
  }));
  router.get('/operations/queues', d.requireOperator, asyncHandler(async (_req, res) => {
    res.json(await d.queues.status());
  }));
  router.post('/operations/queues/cancel-pending', d.requireOwner, d.requireCsrf, asyncHandler(async (req, res) => {
    const reason = string(req.body, 'reason');
    if (reason.length < 10 || reason.length > 500) throw new ValidationError('Must be 10–500 characters', 'reason');
    if (string(req.body, 'confirmation') !== 'CANCEL PENDING IMPORTS') {
      throw new ValidationError('Must exactly match CANCEL PENDING IMPORTS', 'confirmation');
    }
    res.json(await d.queues.cancelPending({ actorAdminId: req.admin!.id, reason, requestId: req.requestId }));
  }));
  router.get('/operations/attention', d.requireOperator, asyncHandler(async (req, res) => {
    const range = dateRange(req.query as Record<string, unknown>);
    res.json(await d.management.operationalAttention(range.from, range.to));
  }));
  router.get('/imports', d.requireOperator, asyncHandler(async (req, res) => {
    const range = dateRange(req.query as Record<string, unknown>);
    res.json(await d.management.imports(range.from, range.to, optionalString(req.query.provider, 'provider'), optionalString(req.query.outcome, 'outcome')));
  }));
  router.get('/import-operations', d.requireOperator, asyncHandler(async (req, res) => {
    const status = optionalString(req.query.status, 'status');
    const statuses = ['active','awaiting_upload','pending_dispatch','queued','running','retrying','succeeded','failed','expired','superseded','cancelled'];
    if (status !== undefined && !statuses.includes(status)) throw new ValidationError('Invalid import status', 'status');
    const kind = optionalString(req.query.kind, 'kind');
    const kinds = ['gmail_historical','outlook_historical','manual_tracking','scheduled_tracking','export_file'];
    if (kind !== undefined && !kinds.includes(kind)) throw new ValidationError('Invalid import kind', 'kind');
    res.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.json(await d.management.importOperations({
      query: optionalString(req.query.query, 'query'), status, kind,
      limit: integer(req.query.limit, 50, 1, 100), offset: integer(req.query.offset, 0, 0, 1_000_000),
    }));
  }));
  router.get('/import-operations/:id', d.requireOperator, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.json(await d.management.importOperation(requireUuid(req.params.id, 'id')));
  }));
  router.get('/users', d.requireOperator, asyncHandler(async (req, res) => {
    const query = optionalString(req.query.query, 'query');
    const verifiedRaw = optionalString(req.query.verified, 'verified');
    const verified = verifiedRaw === undefined ? undefined : verifiedRaw === 'true' ? true : verifiedRaw === 'false' ? false : (() => { throw new ValidationError('Must be true or false', 'verified'); })();
    const provider = optionalString(req.query.provider, 'provider');
    if (provider !== undefined && provider !== 'gmail' && provider !== 'microsoft') throw new ValidationError('Invalid provider', 'provider');
    const createdFromRaw = optionalString(req.query.createdFrom, 'createdFrom');
    const createdToRaw = optionalString(req.query.createdTo, 'createdTo');
    const createdFrom = createdFromRaw ? new Date(createdFromRaw) : undefined;
    const createdTo = createdToRaw ? new Date(createdToRaw) : undefined;
    if (createdFrom && Number.isNaN(createdFrom.getTime())) throw new ValidationError('Invalid date', 'createdFrom');
    if (createdTo && Number.isNaN(createdTo.getTime())) throw new ValidationError('Invalid date', 'createdTo');
    const activityFromRaw = optionalString(req.query.activityFrom, 'activityFrom');
    const activityToRaw = optionalString(req.query.activityTo, 'activityTo');
    const activityFrom = activityFromRaw ? new Date(activityFromRaw) : undefined;
    const activityTo = activityToRaw ? new Date(activityToRaw) : undefined;
    if (activityFrom && Number.isNaN(activityFrom.getTime())) throw new ValidationError('Invalid date', 'activityFrom');
    if (activityTo && Number.isNaN(activityTo.getTime())) throw new ValidationError('Invalid date', 'activityTo');
    const issue = optionalString(req.query.issue, 'issue');
    const issues: readonly AdminUserIssue[] = ['stuck_import', 'recent_import_failure', 'reconnect_required', 'tracking_error'];
    if (issue !== undefined && !issues.includes(issue as AdminUserIssue)) throw new ValidationError('Invalid user issue', 'issue');
    const sort = optionalString(req.query.sort, 'sort') ?? 'created_desc';
    const sorts: readonly AdminUserSort[] = ['created_desc', 'last_activity_desc', 'receipts_desc'];
    if (!sorts.includes(sort as AdminUserSort)) throw new ValidationError('Invalid user sort', 'sort');
    res.json(await d.management.listUsers({
      query, verified, provider,
      importState: optionalString(req.query.importState, 'importState'),
      trackingState: optionalString(req.query.trackingState, 'trackingState'),
      createdFrom, createdTo,
      issue: issue as AdminUserIssue | undefined,
      activityFrom,
      activityTo,
      sort: sort as AdminUserSort,
      limit: integer(req.query.limit, 50, 1, 100), offset: integer(req.query.offset, 0, 0, 1_000_000),
    }));
  }));
  router.get('/users/:id', d.requireOperator, asyncHandler(async (req, res) => res.json(await d.management.getUser(requireUuid(req.params.id, 'id'), req.admin!.role === 'owner'))));
  router.get('/users/:id/timeline', d.requireOperator, asyncHandler(async (req, res) => {
    const category = optionalString(req.query.category, 'category');
    const categories: readonly AdminTimelineCategory[] = ['account', 'authentication', 'connection', 'import', 'tracking', 'administration'];
    if (category !== undefined && !categories.includes(category as AdminTimelineCategory)) throw new ValidationError('Invalid timeline category', 'category');
    res.json(await d.management.userTimeline(requireUuid(req.params.id, 'id'), {
      cursor: optionalString(req.query.cursor, 'cursor'),
      limit: integer(req.query.limit, 30, 1, 100),
      category: category as AdminTimelineCategory | undefined,
    }));
  }));
  router.patch('/users/:id/mailbox-security-policy', d.requireOperator, d.requireCsrf, asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    if (typeof body.allowForwardedReceipts !== 'boolean') throw new ValidationError('Must be true or false', 'allowForwardedReceipts');
    res.json({ mailboxSecurity: await d.management.updateMailboxSecurityPolicy({
      userId: requireUuid(req.params.id, 'id'),
      allowForwardedReceipts: body.allowForwardedReceipts,
      reason: string(body, 'reason'),
      actorAdminId: req.admin!.id,
      requestId: req.requestId,
    }) });
  }));
  router.patch('/users/:id/test-scenarios/gmail-long-running', d.requireOwner, d.requireCsrf, asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    if (typeof body.enabled !== 'boolean') throw new ValidationError('Must be true or false', 'enabled');
    res.json({ testScenarios: await d.management.updateGmailLongRunningScenario({
      userId: requireUuid(req.params.id, 'id'),
      enabled: body.enabled,
      reason: string(body, 'reason'),
      actorAdminId: req.admin!.id,
      requestId: req.requestId,
    }) });
  }));
  router.delete('/users/:id', d.requireOwner, d.requireCsrf, asyncHandler(async (req, res) => {
    res.json(await d.management.deleteUser({ userId: requireUuid(req.params.id, 'id'), confirmationEmail: string(req.body, 'confirmationEmail'), reason: string(req.body, 'reason'), actorAdminId: req.admin!.id, requestId: req.requestId }));
  }));

  router.post('/invitations', d.requireOwner, d.requireCsrf, asyncHandler(async (req, res) => {
    const role = string(req.body, 'role');
    if (!isAdminRole(role)) throw new ValidationError('Invalid role', 'role');
    const invitation = await d.auth.invite(req.admin!, string(req.body, 'email'), role);
    res.status(201).json(invitation);
  }));
  router.get('/administrators', d.requireOwner, asyncHandler(async (_req, res) => res.json({ administrators: await d.auth.listAdministrators() })));
  router.patch('/administrators/:id', d.requireOwner, d.requireCsrf, asyncHandler(async (req, res) => {
    const body = requireObject(req.body);
    const role = optionalString(body.role, 'role');
    const status = optionalString(body.status, 'status');
    if (role !== undefined && !isAdminRole(role)) throw new ValidationError('Invalid role', 'role');
    if (status !== undefined && status !== 'active' && status !== 'disabled') throw new ValidationError('Invalid status', 'status');
    res.json(await d.auth.updateAdministrator(req.admin!.id, requireUuid(req.params.id, 'id'), { role, status: status as AdminStatus | undefined }));
  }));
  router.get('/audit-events', d.requireOwner, asyncHandler(async (req, res) => res.json(await d.management.auditEvents(integer(req.query.limit, 50, 1, 100), integer(req.query.offset, 0, 0, 1_000_000)))));
  return router;
};
