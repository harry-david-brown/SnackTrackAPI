import logger from '../../config/logger';
import { NotFoundError } from '../../core/errors';
import { getDefaultTimezone, getLocalDateKey } from '../../utils/timezone';
import type { UserSummaryProjection } from '../core/cacheProjections';
import type {
  UserProfilePort,
  UserSummaryCachePort,
  WrappedAnalyticsPort,
} from '../ports/ProjectionPorts';
import type { ReceiptReadPort } from '../ports/ReceiptPorts';

type UserSummaryUserPort = UserProfilePort;
type UserSummaryReceiptPort = Pick<ReceiptReadPort, 'findByUserId'>;
type UserSummaryAnalyticsPort = WrappedAnalyticsPort;

export interface GetUserSummaryInput {
  userId: string;
  includeWrapped: boolean;
  requestTimezone?: string;
}

const roundMoney = (amount: number): number => Math.round((amount + Number.EPSILON) * 100) / 100;

/** Owns user-summary reads, timezone repair, projection assembly, and cache policy. */
export class GetUserSummaryService {
  constructor(
    private readonly users: UserSummaryUserPort,
    private readonly receipts: UserSummaryReceiptPort,
    private readonly wrappedAnalytics: UserSummaryAnalyticsPort,
    private readonly cache: UserSummaryCachePort,
  ) {}

  async execute(input: GetUserSummaryInput): Promise<UserSummaryProjection> {
    let user = await this.users.findById(input.userId);
    if (!user) throw new NotFoundError('User', input.userId);

    if (input.requestTimezone && input.requestTimezone !== user.timezone) {
      await this.users.updateTimezone(input.userId, input.requestTimezone);
      await this.cache.invalidateAllUserCaches(input.userId);
      user = { ...user, timezone: input.requestTimezone };
    }

    const timezone = user.timezone || getDefaultTimezone();
    const cacheKey = input.includeWrapped
      ? `${input.userId}-wrapped-v6-${timezone}`
      : `${input.userId}-v5-${timezone}`;
    const cached = await this.cache.getUserSummary(cacheKey);
    if (cached) return cached;

    const receipts = await this.receipts.findByUserId(input.userId);
    const totalSpent = roundMoney(receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0));
    const averageSpent = receipts.length > 0 ? roundMoney(totalSpent / receipts.length) : 0;
    const dataSourceBreakdown: Record<string, number> = {};
    const monthlyBreakdown: Record<string, { count: number; total: number }> = {};
    const restaurantStats: Record<string, { count: number; total: number }> = {};

    for (const receipt of receipts) {
      dataSourceBreakdown[receipt.dataSource] = (dataSourceBreakdown[receipt.dataSource] ?? 0) + 1;

      if (receipt.orderDate) {
        const localDate = getLocalDateKey(receipt.orderDate, timezone);
        if (localDate) {
          const month = localDate.substring(0, 7);
          const current = monthlyBreakdown[month] ?? { count: 0, total: 0 };
          monthlyBreakdown[month] = {
            count: current.count + 1,
            total: roundMoney(current.total + receipt.amountSpent),
          };
        }
      }

      const restaurant = receipt.restaurantName?.trim();
      if (restaurant && /[\p{L}\p{N}]/u.test(restaurant)) {
        const current = restaurantStats[restaurant] ?? { count: 0, total: 0 };
        restaurantStats[restaurant] = {
          count: current.count + 1,
          total: roundMoney(current.total + receipt.amountSpent),
        };
      }
    }

    const zeroAmountReceipts = receipts.filter((receipt) => receipt.amountSpent === 0);
    const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const summary: UserSummaryProjection = {
      user: { id: user.id, email: user.email, dataSource: 'csv' },
      statistics: {
        totalSpent,
        averageSpent,
        totalReceipts: receipts.length,
        dataSourceBreakdown,
        monthlyBreakdown,
        topRestaurants: Object.entries(restaurantStats)
          .map(([name, stats]) => ({ name, ...stats }))
          .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name))
          .slice(0, 10),
      },
      validation: {
        issues:
          zeroAmountReceipts.length > 0
            ? [`${zeroAmountReceipts.length} receipts have zero amount (likely refunded orders)`]
            : [],
        zeroAmountReceipts: zeroAmountReceipts.length,
        refundedReceipts: zeroAmountReceipts.length,
      },
      recentReceipts: receipts
        .filter((receipt) => receipt.orderDate && receipt.orderDate.getTime() > recentCutoff)
        .sort((a, b) => (b.orderDate?.getTime() ?? 0) - (a.orderDate?.getTime() ?? 0))
        .slice(0, 5)
        .map((receipt) => ({
          restaurantName: receipt.restaurantName,
          amountSpent: receipt.amountSpent,
          orderDate: receipt.orderDate,
          dataSource: receipt.dataSource,
        })),
    };

    if (input.includeWrapped) {
      try {
        summary.wrappedAnalytics = await this.wrappedAnalytics.calculateWrappedAnalytics(
          input.userId,
        );
      } catch (error) {
        logger.warn('Wrapped analytics unavailable for user summary', { error });
        summary.wrappedAnalytics = null;
      }
    }

    await this.cache.cacheUserSummary(cacheKey, summary);
    return summary;
  }
}
