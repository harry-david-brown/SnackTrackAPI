/**
 * Compatibility barrel. Dashboard insight ownership now lives in the focused
 * dashboard module; new callers should import from `analytics/dashboard`.
 */
export * from './dashboard';

import { Receipt } from '../../models/Receipt';
import { buildDashboardInsightEdition } from './dashboard';

/** @deprecated Use buildDashboardInsightEdition and its edition metadata. */
export function buildDashboardInsights(receipts: Receipt[], timezone: string, userId: string, now: Date = new Date()) {
  return buildDashboardInsightEdition(receipts, timezone, userId, now).insights;
}
