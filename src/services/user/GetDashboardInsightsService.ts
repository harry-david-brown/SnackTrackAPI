import type { InvestmentContextPort } from '../ports/MarketHistoryPorts';
import { investmentContext } from '../analytics/shared/historicalInvestment';
import { NotFoundError } from '../../core/errors';
import { getDefaultTimezone, getLocalDateKey, zonedDateTimeToUtc } from '../../utils/timezone';
import type { Receipt } from '../../models/Receipt';
import {
  buildDashboardInsightCatalogue,
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

export interface GetDashboardInsightOrdersInput {
  snapshotId?: string;
  userId: string;
  insightId: string;
  localDate: string;
  page: number;
  limit: number;
}

export interface DashboardInsightOrderPage {
  receipts: Receipt[];
  total: number;
  timezone: string;
}

const insightDateNow = (localDate: string, timezone: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== day
  ) return null;
  return zonedDateTimeToUtc({ year, month, day, hour: 12, minute: 0, second: 0 }, timezone);
};

/** Owns dashboard timezone repair, daily projection assembly, and cache policy. */
export class GetDashboardInsightsService {
  private readonly singleFlight = new SingleFlight();
  constructor(
    private readonly users: DashboardUserPort,
    private readonly receipts: DashboardReceiptPort,
    private readonly cache: DashboardCachePort,
    private readonly market?: InvestmentContextPort,
  ) {}

  async execute(input: GetDashboardInsightsInput): Promise<DashboardInsightEdition> {
    let user = await this.users.findProjectionProfileById(input.userId);
    if (!user) throw new NotFoundError('User', input.userId);

    if (input.requestTimezone && input.requestTimezone !== user.timezone) {
      await this.users.updateTimezone(input.userId, input.requestTimezone);
      await this.cache.invalidateAllUserCaches(input.userId);
      user = await this.users.findProjectionProfileById(input.userId);
      if (!user) throw new NotFoundError('User', input.userId);
    }

    const timezone = user.timezone || getDefaultTimezone();
    const actualNow = new Date();
    const now = getDashboardInsightPreviewNow(actualNow, timezone, input.devDayOffset);
    const localDate = getLocalDateKey(now, timezone) ?? now.toISOString().slice(0, 10);
    const market = await this.market?.context(actualNow) ?? investmentContext('fixed', null, actualNow);
    const revision = user.receiptProjectionRevision;
    const cacheKey = `${input.userId}:r${revision}:${DASHBOARD_INSIGHT_METRIC_VERSION}:${timezone}:${localDate}:${market.cacheToken}`;
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
      const edition = buildDashboardInsightEdition(receipts, timezone, input.userId, now, market);
      if (!isDevPreview) {
        const ttlSeconds = (Date.parse(edition.nextRefreshAt) - actualNow.getTime()) / 1000 + 60;
        const current = await this.users.findProjectionProfileById(input.userId);
        if (current?.receiptProjectionRevision === revision) {
          await this.cache.cacheDashboardInsightEdition(cacheKey, edition, ttlSeconds);
        }
      }
      return edition;
    });
  }

  async getInsightOrders(input: GetDashboardInsightOrdersInput): Promise<DashboardInsightOrderPage> {
    const user = await this.users.findProjectionProfileById(input.userId);
    if (!user) throw new NotFoundError('User', input.userId);
    const timezone = user.timezone || getDefaultTimezone();
    const now = insightDateNow(input.localDate, timezone);
    if (!now) throw new NotFoundError('Dashboard insight', input.insightId);

    const receipts = await this.receipts.findByUserId(input.userId);
    const market = await this.market?.context(new Date(), input.snapshotId) ?? investmentContext('fixed', null, new Date());
    const candidate = buildDashboardInsightCatalogue(receipts, timezone, now, market).eligible.find(
      (entry) => entry.insight.id === input.insightId && entry.orderIds?.length,
    );
    if (!candidate?.orderIds?.length) throw new NotFoundError('Dashboard insight', input.insightId);

    const ids = new Set(candidate.orderIds);
    const matching = receipts
      .filter((receipt) => Boolean(receipt.id && ids.has(receipt.id)))
      .sort((a, b) =>
        (b.orderDate?.getTime() ?? Number.MIN_SAFE_INTEGER) -
          (a.orderDate?.getTime() ?? Number.MIN_SAFE_INTEGER) ||
        (a.id ?? '').localeCompare(b.id ?? ''),
      );
    const offset = (input.page - 1) * input.limit;
    return {
      receipts: matching.slice(offset, offset + input.limit),
      total: matching.length,
      timezone,
    };
  }
}
