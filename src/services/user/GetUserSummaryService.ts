import type { InvestmentContextPort } from '../ports/MarketHistoryPorts';
import { investmentContext } from '../analytics/shared/historicalInvestment';
import { spendingByCurrency, receiptCurrency } from '../analytics/shared/receiptMetrics';
import { normalizeRestaurantName } from '../analytics/dashboard/normalization';
import logger from '../../config/logger';
import { normalizeTrackedSpend } from '../analytics/shared/normalizedTrackedSpend';
import { NotFoundError } from '../../core/errors';
import { getDefaultTimezone, getLocalDateKey } from '../../utils/timezone';
import type { UserSummaryProjection } from '../core/cacheProjections';
import type {
  UserProfilePort,
  UserSummaryCachePort,
  WrappedAnalyticsPort,
} from '../ports/ProjectionPorts';
import type { ReceiptReadPort } from '../ports/ReceiptPorts';
import { SingleFlight } from '../core/SingleFlight';
import type { DisplayCurrency, RecapCurrency, RecapExchangeRatesPort } from '../ports/RecapExchangeRatesPort';
import {
  orderMetricEligibility,
  summarizeOrderMetrics,
  summarizeOrderMetricPeriods,
  usesOrderEventMetrics,
} from '../analytics/shared/orderMetrics';

type UserSummaryUserPort = UserProfilePort;
type UserSummaryReceiptPort = Pick<ReceiptReadPort, 'findByUserId'>;
type UserSummaryAnalyticsPort = WrappedAnalyticsPort;

export interface GetUserSummaryInput {
  displayCurrency?: RecapCurrency;
  spendCurrency?: DisplayCurrency;
  userId: string;
  includeWrapped: boolean;
  requestTimezone?: string;
}

const roundMoney = (amount: number): number => Math.round((amount + Number.EPSILON) * 100) / 100;

/** Owns user-summary reads, timezone repair, projection assembly, and cache policy. */
export class GetUserSummaryService {
  private readonly singleFlight = new SingleFlight();
  constructor(
    private readonly users: UserSummaryUserPort,
    private readonly receipts: UserSummaryReceiptPort,
    private readonly wrappedAnalytics: UserSummaryAnalyticsPort,
    private readonly cache: UserSummaryCachePort,
    private readonly recapRates?: RecapExchangeRatesPort,
    private readonly market?: InvestmentContextPort,
  ) {}

  async execute(input: GetUserSummaryInput): Promise<UserSummaryProjection> {
    let user = await this.users.findProjectionProfileById(input.userId);
    if (!user) throw new NotFoundError('User', input.userId);

    if (input.requestTimezone && input.requestTimezone !== user.timezone) {
      await this.users.updateTimezone(input.userId, input.requestTimezone);
      await this.cache.invalidateAllUserCaches(input.userId);
      user = await this.users.findProjectionProfileById(input.userId);
      if (!user) throw new NotFoundError('User', input.userId);
    }

    const timezone = user.timezone || getDefaultTimezone();
    const revision = user.receiptProjectionRevision;
    // The database changes this token in the receipt transaction. Redis invalidation is cleanup,
    // not the correctness boundary, and newer requests cannot join an older single flight.
    const scope = `${input.userId}:r${revision}`;
    const market = input.includeWrapped ? await this.market?.context(new Date()) ?? investmentContext('fixed', null, new Date()) : undefined;
    const rates = input.includeWrapped || input.spendCurrency ? await this.recapRates?.snapshot() : undefined;
    const cacheKey = input.includeWrapped
      ? `${scope}-wrapped-v17-${timezone}-${input.displayCurrency ?? 'CAD'}-${rates?.id ?? 'unavailable'}-${market?.cacheToken}`
      : `${scope}-v11-${timezone}`;
    const projectionKey = `${cacheKey}-${input.spendCurrency ?? 'original'}-${input.spendCurrency ? rates?.id ?? 'unavailable' : ''}`;
    const cached = await this.cache.getUserSummary(projectionKey);
    if (cached) return cached;

    return this.singleFlight.run(projectionKey, async () => {
      const cachedAfterWait = await this.cache.getUserSummary(projectionKey);
      if (cachedAfterWait) return cachedAfterWait;
      const receipts = await this.receipts.findByUserId(input.userId);
      const eventMetrics = usesOrderEventMetrics(receipts);
      const orderMetrics = eventMetrics ? summarizeOrderMetrics(receipts) : undefined;
      const established = eventMetrics
        ? receipts.filter((r) => orderMetricEligibility(r).establishedAttempt)
        : receipts;
      const spending = spendingByCurrency(receipts);
      const totalSpent = spending.buckets[spending.primary]?.total ?? 0;
      const financialCount = spending.buckets[spending.primary]?.count ?? 0;
      const averageSpent = financialCount > 0 ? roundMoney(totalSpent / financialCount) : 0;
      const dataSourceBreakdown: Record<string, number> = {};
      const monthlyBreakdown: Record<
        string,
        { count: number; total: number; pricedCount: number }
      > = {};
      const restaurantStats: Record<string, { count: number; total: number }> = {};

      const dailyBreakdown: Record<string, { count: number; total: number }> = {};
      for (const receipt of established) {
        const eligible = orderMetricEligibility(receipt);
        const priced = !eventMetrics || eligible.netAmount !== null;
        const amount =
          receiptCurrency(receipt) === spending.primary
            ? eventMetrics
              ? (eligible.netAmount ?? 0)
              : receipt.amountSpent
            : 0;
        for (const source of new Set(
          eventMetrics
            ? (receipt.resolution?.sources ?? [receipt.dataSource])
            : [receipt.dataSource],
        ))
          dataSourceBreakdown[source] = (dataSourceBreakdown[source] ?? 0) + 1;

        if (receipt.orderDate) {
          const localDate = getLocalDateKey(
            receipt.orderDate,
            receipt.resolution?.timestamp?.timezone ?? timezone,
          );
          if (localDate) {
            const day = dailyBreakdown[localDate] ?? { count: 0, total: 0 };
            dailyBreakdown[localDate] = {
              count: day.count + 1,
              total: roundMoney(day.total + amount),
            };
            const month = localDate.substring(0, 7);
            const current = monthlyBreakdown[month] ?? { count: 0, total: 0, pricedCount: 0 };
            monthlyBreakdown[month] = {
              pricedCount:
                current.pricedCount +
                Number(priced && receiptCurrency(receipt) === spending.primary),
              count: current.count + 1,
              total: roundMoney(current.total + amount),
            };
          }
        }

        const restaurant = normalizeRestaurantName(receipt.restaurantName)?.label;
        if (
          restaurant &&
          /[\p{L}\p{N}]/u.test(restaurant) &&
          (!eventMetrics || eligible.delivered)
        ) {
          const current = restaurantStats[restaurant] ?? { count: 0, total: 0 };
          restaurantStats[restaurant] = {
            count: current.count + 1,
            total: roundMoney(current.total + amount),
          };
        }
      }

      const zeroAmountReceipts = established.filter((receipt) =>
        eventMetrics ? orderMetricEligibility(receipt).netAmount === 0 : receipt.amountSpent === 0,
      );
      const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const summary: UserSummaryProjection = {
        user: { id: user.id, email: user.email, dataSource: 'csv' },
        statistics: {
          ...(orderMetrics
            ? { orderMetrics, orderMetricPeriods: summarizeOrderMetricPeriods(receipts, timezone) }
            : {}),
          unresolvedReceiptCount: receipts.filter(
            (r) => r.resolution?.reconciliation?.status === 'unresolved',
          ).length,
          ...(input.spendCurrency ? { normalizedSpend: normalizeTrackedSpend(spending.buckets, input.spendCurrency, rates) } : {}),
          totalSpent,
          currencyCode: spending.primary,
          totalsByCurrency: spending.buckets,
          dailyBreakdown,
          amountBasis: receipts.every((r) => r.resolution?.amountBasis === 'receipt_total')
            ? 'receipt_totals'
            : 'best_available',
          averageSpent,
          totalReceipts: established.length,
          dataSourceBreakdown,
          monthlyBreakdown,
          topRestaurants: Object.entries(restaurantStats)
            .map(([name, stats]) => ({ name, ...stats }))
            .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name))
            .slice(0, 10),
        },
        validation: {
          issues: orderMetrics
            ? [
                ...(orderMetrics.possibleAdditionalOrders
                  ? [
                      `${orderMetrics.possibleAdditionalOrders} possible additional orders are shown separately from established totals`,
                    ]
                  : []),
                ...(orderMetrics.currencies.some((c) => c.unknownPriceOrders)
                  ? ['Some order costs are unknown; totals include known amounts only']
                  : []),
                ...(orderMetrics.legacyOrders
                  ? ['Some older receipts do not establish delivery or refund status']
                  : []),
              ]
            : zeroAmountReceipts.length > 0
              ? [
                  `${zeroAmountReceipts.length} receipts have zero amount (delivery/refund status unknown)`,
                ]
              : [],
          zeroAmountReceipts: zeroAmountReceipts.length,
          refundedReceipts:
            orderMetrics?.confirmedRefunds ??
            receipts.filter((r) => r.resolution?.adjustments.some((a) => a.kind === 'refund'))
              .length,
        },
        recentReceipts: established
          .filter((receipt) => receipt.orderDate && receipt.orderDate.getTime() > recentCutoff)
          .sort((a, b) => (b.orderDate?.getTime() ?? 0) - (a.orderDate?.getTime() ?? 0))
          .slice(0, 5)
          .map((receipt) => ({
            restaurantName: receipt.restaurantName,
            amountSpent: receipt.amountSpent,
            ...(eventMetrics ? { netAmount: orderMetricEligibility(receipt).netAmount } : {}),
            orderDate: receipt.orderDate,
            dataSource: receipt.dataSource,
          })),
      };

      if (input.includeWrapped) {
        try {
          summary.wrappedAnalytics = await this.wrappedAnalytics.calculateWrappedAnalytics(
            input.userId,
            { receipts, timezone, displayCurrency: input.displayCurrency ?? 'CAD', rates, market },
          );
        } catch (error) {
          logger.warn('Wrapped analytics unavailable for user summary', { error });
          summary.wrappedAnalytics = null;
        }
      }

      const current = await this.users.findProjectionProfileById(input.userId);
      if (current?.receiptProjectionRevision === revision) {
        await this.cache.cacheUserSummary(projectionKey, summary);
      }
      return summary;
    });
  }
}
