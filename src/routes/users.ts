import { RequestHandler, Router } from 'express';
import { requestTimezone } from '../http/requestTimezone';
import { mapReceiptPageResponse } from '../http/mappers/receiptResponse';
import { parseQueryBoolean, parseQueryInteger } from '../http/validation/requestValues';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import { MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET } from '../services/analytics/dashboard';
import type { AccountResetService } from '../services/data/AccountResetService';
import type { GetDashboardInsightsService } from '../services/user/GetDashboardInsightsService';
import type { GetUserSummaryService } from '../services/user/GetUserSummaryService';

export interface UsersRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly authorizeOwnership: RequestHandler;
  readonly validateUserId: RequestHandler;
  readonly production: boolean;
  readonly accountReset: Pick<AccountResetService, 'resetForOnboarding'>;
  readonly dashboardInsights: Pick<GetDashboardInsightsService, 'execute' | 'getInsightOrders'>;
  readonly summaries: Pick<GetUserSummaryService, 'execute'>;
}

/** Composition-only transport for authenticated user resources. */
export const createUsersRouter = (dependencies: UsersRouterDependencies): Router => {
  const router = Router();
  const ownedUser = [
    dependencies.authenticate,
    dependencies.authorizeOwnership,
    dependencies.validateUserId,
  ];

  router.post(
    '/:id/reset-onboarding',
    ...ownedUser,
    asyncHandler(async (request, response) => {
      const result = await dependencies.accountReset.resetForOnboarding(request.params.id);
      response.json({
        success: true,
        deletedReceipts: result.deletedReceipts,
        message: 'Account import data reset successfully',
      });
    }),
  );

  /**
   * @swagger
   * /users/{id}/dashboard-insights:
   *   get:
   *     summary: Get the user's daily dashboard insight edition
   *     tags: [Users]
   *     security: [{ BearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
   *       - { in: header, name: X-Timezone, schema: { type: string } }
   *       - { in: query, name: devDayOffset, schema: { type: integer, minimum: 0, maximum: 365 } }
   *     responses:
   *       200:
   *         description: Daily dashboard insight edition
   *         content: { application/json: { schema: { $ref: '#/components/schemas/DashboardInsightEdition' } } }
   *       400: { $ref: '#/components/responses/ValidationError' }
   *       401: { $ref: '#/components/responses/Unauthorized' }
   *       403: { $ref: '#/components/responses/Forbidden' }
   *       404: { $ref: '#/components/responses/NotFound' }
   */
  router.get(
    '/:id/dashboard-insights',
    ...ownedUser,
    asyncHandler(async (request, response) => {
      if (request.query.devDayOffset !== undefined && dependencies.production) {
        throw new ValidationError(
          'devDayOffset is only available outside production',
          'devDayOffset',
        );
      }
      const devDayOffset =
        parseQueryInteger(request.query.devDayOffset, 'devDayOffset', {
          defaultValue: 0,
          minimum: 0,
          maximum: MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET,
        }) ?? 0;
      const edition = await dependencies.dashboardInsights.execute({
        userId: request.params.id,
        requestTimezone: requestTimezone(request) ?? undefined,
        devDayOffset,
      });
      response.set('Cache-Control', 'private, no-cache');
      response.json(edition);
    }),
  );

  router.get(
    '/:id/dashboard-insights/:insightId/orders',
    ...ownedUser,
    asyncHandler(async (request, response) => {
      const localDate = typeof request.query.localDate === 'string' ? request.query.localDate : '';
      const parsedLocalDate = new Date(`${localDate}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(localDate) ||
        !Number.isFinite(parsedLocalDate.getTime()) ||
        parsedLocalDate.toISOString().slice(0, 10) !== localDate
      ) {
        throw new ValidationError('Expected YYYY-MM-DD', 'localDate');
      }
      if (!/^[a-z0-9-]{1,120}$/i.test(request.params.insightId)) {
        throw new ValidationError('Invalid insight identifier', 'insightId');
      }
      const page = parseQueryInteger(request.query.page, 'page', {
        defaultValue: 1,
        minimum: 1,
        maximum: 100_000,
      }) ?? 1;
      const limit = parseQueryInteger(request.query.limit, 'limit', {
        defaultValue: 30,
        minimum: 1,
        maximum: 100,
      }) ?? 30;
      const snapshotId = request.query.snapshotId;
      if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshotId))) throw new ValidationError('Invalid snapshot identifier', 'snapshotId');
      const result = await dependencies.dashboardInsights.getInsightOrders({
        snapshotId: typeof snapshotId === 'string' ? snapshotId : undefined,
        userId: request.params.id,
        insightId: request.params.insightId,
        localDate,
        page,
        limit,
      });
      response.set('Cache-Control', 'private, no-cache');
      response.json(mapReceiptPageResponse(result.receipts, result.total, page, limit, result.timezone));
    }),
  );

  /**
   * @swagger
   * /users/{id}/summary:
   *   get:
   *     summary: Get the user's receipt summary and analytics
   *     tags: [Users]
   *     security: [{ BearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
   *       - { in: query, name: includeWrapped, schema: { type: boolean, default: false } }
   *       - { in: query, name: displayCurrency, schema: { type: string, enum: [CAD, USD, EUR, GBP] }, description: Approximate recap display currency; does not change summary totals. }
   *       - { in: header, name: X-Timezone, schema: { type: string } }
   *     responses:
   *       200:
   *         description: User summary
   *         content: { application/json: { schema: { $ref: '#/components/schemas/UserSummary' } } }
   *       400: { $ref: '#/components/responses/ValidationError' }
   *       401: { $ref: '#/components/responses/Unauthorized' }
   *       403: { $ref: '#/components/responses/Forbidden' }
   *       404: { $ref: '#/components/responses/NotFound' }
   */
  router.get(
    '/:id/summary',
    ...ownedUser,
    asyncHandler(async (request, response) => {
      const summary = await dependencies.summaries.execute({
        displayCurrency: (() => {
          const value = request.query.displayCurrency;
          if (value === undefined) return undefined;
          if (value === 'CAD' || value === 'USD' || value === 'EUR' || value === 'GBP') return value;
          throw new ValidationError('Invalid displayCurrency');
        })(),
        userId: request.params.id,
        includeWrapped:
          parseQueryBoolean(request.query.includeWrapped, 'includeWrapped', false) ?? false,
        requestTimezone: requestTimezone(request) ?? undefined,
      });
      response.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      response.set('Pragma', 'no-cache');
      response.set('Expires', '0');
      response.json(summary);
    }),
  );

  return router;
};
