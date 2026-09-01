import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { GmailConnectionService } from '../services/import/GmailConnectionService';
import type { ImportPreferencesService } from '../services/import/ImportPreferencesService';
import type { ManualTrackingCheckService } from '../services/import/ManualTrackingCheckService';
import type { OngoingTrackingService } from '../services/import/OngoingTrackingService';
import type { ImportStatusService } from '../services/import/ImportStatusService';
import type { HistoricalGmailImportService } from '../services/import/HistoricalGmailImportService';
import { createGmailImportRouter } from './gmailImport';
import { createGmailOAuthRouter } from './gmailOAuth';
import { createGmailPreferencesRouter } from './gmailPreferences';
import { createGmailTrackingRouter } from './gmailTracking';

export interface GmailRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly validateScheduler: RequestHandler;
  readonly connections: GmailConnectionService;
  readonly preferences: ImportPreferencesService;
  readonly manualCheck: ManualTrackingCheckService;
  readonly scheduledTracking: OngoingTrackingService;
  readonly status: ImportStatusService;
  readonly historicalImport: HistoricalGmailImportService;
  readonly logger: Parameters<typeof createGmailOAuthRouter>[0]['logger'];
}

/** Composition-only router for focused Gmail HTTP capabilities. */
export const createGmailRouter = (dependencies: GmailRouterDependencies): Router => {
  const router = Router();
  router.use(
    createGmailOAuthRouter({
      authenticate: dependencies.authenticate,
      connections: dependencies.connections,
      logger: dependencies.logger,
    }),
  );
  router.use(
    createGmailPreferencesRouter({
      authenticate: dependencies.authenticate,
      preferences: dependencies.preferences,
    }),
  );
  router.use(
    createGmailTrackingRouter({
      authenticate: dependencies.authenticate,
      validateScheduler: dependencies.validateScheduler,
      manualCheck: dependencies.manualCheck,
      scheduledTracking: dependencies.scheduledTracking,
    }),
  );
  router.use(
    createGmailImportRouter({
      authenticate: dependencies.authenticate,
      status: dependencies.status,
      historicalImport: dependencies.historicalImport,
    }),
  );
  return router;
};
