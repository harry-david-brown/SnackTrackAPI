import { Request, RequestHandler, Response, Router } from 'express';
import { authenticatedUserId } from '../http/authenticatedUser';
import { requestTimezone } from '../http/requestTimezone';
import { requireObject } from '../http/validation/requestValues';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import {
  isConsentDecision,
  isExportProvider,
  isProviderRelevance,
  type ConsentDecision,
  type ExportProvider,
} from '../services/import/ImportLifecycleTypes';
import type { ImportPreferencesService } from '../services/import/ImportPreferencesService';

export interface GmailPreferencesRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly preferences: Pick<
    ImportPreferencesService,
    | 'get'
    | 'setMonitoringConsent'
    | 'setOngoingTrackingConsent'
    | 'markExportRequested'
    | 'confirmExportReady'
    | 'checkExportReady'
    | 'getSetupGuidance'
    | 'setInitialSetupDeferral'
    | 'setProviderRelevance'
  >;
}

const consentInput = (request: Request, label: string) => {
  const body = requireObject(request.body as unknown);
  const decision = body.decision;
  if (!isConsentDecision(decision)) {
    throw new ValidationError('decision must be granted, declined, or revoked');
  }
  const consentVersion = body.consentVersion;
  if (
    decision === 'granted' &&
    (typeof consentVersion !== 'string' || !consentVersion.trim() || consentVersion.length > 50)
  ) {
    throw new ValidationError(`consentVersion is required when granting ${label}`);
  }
  return {
    decision,
    consentVersion: typeof consentVersion === 'string' ? consentVersion.trim() : undefined,
  };
};
const providerInput = (request: Request): ExportProvider => {
  const provider = requireObject(request.body as unknown).provider;
  if (!isExportProvider(provider)) {
    throw new ValidationError('provider must be uber_eats or doordash');
  }
  return provider;
};

export const createGmailPreferencesRouter = (
  dependencies: GmailPreferencesRouterDependencies,
): Router => {
  const router = Router();

  router.get(
    '/preferences/setup-guidance',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json(await dependencies.preferences.getSetupGuidance(authenticatedUserId(request)));
    }),
  );
  router.put(
    '/preferences/setup-deferral',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const decision = requireObject(request.body as unknown).decision;
      if (decision !== 'defer' && decision !== 'resume') {
        throw new ValidationError('decision must be defer or resume');
      }
      response.json(
        await dependencies.preferences.setInitialSetupDeferral(
          authenticatedUserId(request),
          decision,
        ),
      );
    }),
  );
  router.put(
    '/preferences/provider-relevance',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const body = requireObject(request.body as unknown);
      if (!isExportProvider(body.provider)) {
        throw new ValidationError('provider must be uber_eats or doordash');
      }
      if (!isProviderRelevance(body.relevance)) {
        throw new ValidationError('relevance must be unknown or not_used');
      }
      response.json(
        await dependencies.preferences.setProviderRelevance(
          authenticatedUserId(request),
          body.provider,
          body.relevance,
        ),
      );
    }),
  );
  router.get(
    '/preferences',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json(
        await dependencies.preferences.get(
          authenticatedUserId(request),
          requestTimezone(request) ?? undefined,
        ),
      );
    }),
  );
  router.put(
    '/preferences/monitoring-consent',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const input = consentInput(request, 'monitoring consent');
      response.json(
        await dependencies.preferences.setMonitoringConsent(
          authenticatedUserId(request),
          input.decision,
          input.consentVersion,
        ),
      );
    }),
  );
  router.put(
    '/preferences/ongoing-tracking-consent',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const input = consentInput(request, 'ongoing tracking consent');
      response.json(
        await dependencies.preferences.setOngoingTrackingConsent(
          authenticatedUserId(request),
          input.decision,
          input.consentVersion,
        ),
      );
    }),
  );
  router.post(
    '/preferences/export-requested',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json(
        await dependencies.preferences.markExportRequested(
          authenticatedUserId(request),
          providerInput(request),
        ),
      );
    }),
  );
  router.post(
    '/preferences/export-ready',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json(
        await dependencies.preferences.confirmExportReady(
          authenticatedUserId(request),
          providerInput(request),
        ),
      );
    }),
  );
  router.post(
    '/preferences/check-export-ready',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json(await dependencies.preferences.checkExportReady(authenticatedUserId(request)));
    }),
  );

  return router;
};
