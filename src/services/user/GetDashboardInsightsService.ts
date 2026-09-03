import { NotFoundError } from '../../core/errors';
import { getDefaultTimezone, getLocalDateKey } from '../../utils/timezone';
import {
  buildDashboardInsightEdition,
  DASHBOARD_INSIGHT_METRIC_VERSION,
  DashboardInsightEdition,
  getDashboardInsightPreviewNow,
} from '../analytics/dashboard';
import type { DashboardCachePort, UserProfilePort } from '../ports/ProjectionPorts';
import type { ReceiptReadPort } from '../ports/ReceiptPorts';
import { SingleFlight } from '../core/SingleFlight';

type DashboardUserPort = UserProfilePort;
type DashboardReceiptPort = Pick<ReceiptReadPort, 'findByUserId'>;

export interface GetDashboardInsightsInput {
  userId: string;
  requestTimezone?: string;
  devDayOffset: number;
}

/** Owns dashboard timezone repair, daily projection assembly, and cache policy. */
export class GetDashboardInsightsService {
  private readonly singleFlight = new SingleFlight();
  constructor(
    private readonly users: DashboardUserPort,
    private readonly receipts: DashboardReceiptPort,
    private readonly cache: DashboardCachePort,
  ) {}

  async execute(input: GetDashboardInsightsInput): Promise<DashboardInsightEdition> {
    let user = await this.users.findById(input.userId);
    if (!user) throw new NotFoundError('User', input.userId);

    if (input.requestTimezone && input.requestTimezone !== user.timezone) {
      await this.users.updateTimezone(input.userId, input.requestTimezone);
      await this.cache.invalidateAllUserCaches(input.userId);
      user = { ...user, timezone: input.requestTimezone };
    }

    const timezone = user.timezone || getDefaultTimezone();
    const actualNow = new Date();
    const now = getDashboardInsightPreviewNow(actualNow, timezone, input.devDayOffset);
    const localDate = getLocalDateKey(now, timezone) ?? now.toISOString().slice(0, 10);
    const cacheKey = `${input.userId}:${DASHBOARD_INSIGHT_METRIC_VERSION}:${timezone}:${localDate}`;
    const isDevPreview = input.devDayOffset > 0;

    if (!isDevPreview) {
      const cached = await this.cache.getDashboardInsightEdition(cacheKey);
      if (cached) return cached;
    }

    return this.singleFlight.run(cacheKey, async () => {
    if (!isDevPreview) {
      const cachedAfterWait = await this.cache.getDashboardInsightEdition(cacheKey);
      if (cachedAfterWait) return cachedAfterWait;
    }
    const receipts = await this.receipts.findByUserId(input.userId);
    const edition = buildDashboardInsightEdition(receipts, timezone, input.userId, now);
    if (!isDevPreview) {
      const ttlSeconds = (Date.parse(edition.nextRefreshAt) - actualNow.getTime()) / 1000 + 60;
      await this.cache.cacheDashboardInsightEdition(cacheKey, edition, ttlSeconds);
    }
    return edition;
    });
  }
}
