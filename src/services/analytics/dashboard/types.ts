export const DASHBOARD_INSIGHT_METRIC_VERSION = 'daily-v15';

export type DashboardExportProvider = 'uber_eats' | 'doordash';

export type DashboardInsightCategory = 'favorites' | 'habits' | 'extremes' | 'progress';
export type DashboardInsightIcon =
  | 'restaurant' | 'time' | 'calendar' | 'moon' | 'heart' | 'receipt'
  | 'meal' | 'delivery' | 'lock' | 'repeat' | 'trend' | 'trophy' | 'sparkles';
export type InsightValueFormat = 'currency' | 'number' | 'percent' | 'minutes' | 'hours' | 'days';
export type InsightAction = 'open_export';

export interface InsightMethodology {
  estimated?: boolean;
  sampleSize?: number;
  assumption?: string;
  disclaimer?: string;
}

export interface InsightPeriod {
  startDate: string;
  endDate?: string;
}

interface InsightBase {
  id: string;
  category: DashboardInsightCategory;
  icon: DashboardInsightIcon;
  eyebrow: string;
  title: string;
  detail?: string;
  methodology?: InsightMethodology;
  period?: InsightPeriod;
}

export interface HeroInsight extends InsightBase {
  presentation: 'hero';
  value: number;
  valueFormat: InsightValueFormat;
  headline?: string;
}

export interface ComparisonInsight extends InsightBase {
  presentation: 'comparison';
  comparison: {
    variant?: 'investment';
    current: number;
    previous: number;
    delta: number;
    percentDelta: number | null;
    direction: 'up' | 'down' | 'flat';
    valueFormat: 'currency' | 'number';
    currentLabel: string;
    previousLabel: string;
    driver?: 'frequency' | 'basket' | 'outlier' | 'mixed';
    subject?: {
      kind: 'meal' | 'item';
      name: string;
      restaurant?: string;
      occurrences: number;
    };
  };
}

export interface RankingInsight extends InsightBase {
  presentation: 'ranking';
  rows: Array<{ label: string; count: number; amount?: number; context?: string }>;
}

export interface OrderInsight extends InsightBase {
  presentation: 'order';
  order: {
    restaurant: string;
    restaurants?: string[];
    amount: number;
    orderedAt?: string;
    items: string[];
  };
}

export interface TimelineInsight extends InsightBase {
  presentation: 'timeline';
  events: Array<{ label: string; value: string | number; valueFormat?: InsightValueFormat; detail?: string }>;
}

export interface YearlyChampionsInsight extends InsightBase {
  presentation: 'yearly-champions';
  years: Array<{
    year: number;
    winners: string[];
    orderCount: number;
    currentYear: boolean;
  }>;
}

export interface LockedInsight extends InsightBase {
  presentation: 'locked';
  action: InsightAction;
}

export type DashboardInsight =
  | HeroInsight
  | ComparisonInsight
  | RankingInsight
  | OrderInsight
  | TimelineInsight
  | YearlyChampionsInsight
  | LockedInsight;

export interface InsightCandidate {
  insight: DashboardInsight;
  facts: Record<string, string | number | boolean | null>;
  copy: Pick<DashboardInsight, 'eyebrow' | 'title' | 'detail'>;
  family: string;
  relatedFamilies?: string[];
  copyVariants?: readonly string[];
  score: number;
  timely?: boolean;
  locked?: boolean;
  /** Ranked siblings share a group so only one can appear in an edition. */
  subjectGroup?: string;
  subjectRank?: number;
}

export type SuppressionReason =
  | 'insufficient_history'
  | 'missing_dates'
  | 'missing_export_items'
  | 'missing_delivery_times'
  | 'low_sample'
  | 'low_signal'
  | 'stale_coverage'
  | 'unsafe_estimate';

export interface SuppressedCandidate {
  id: string;
  reason: SuppressionReason;
}

export interface DashboardInsightEdition {
  localDate: string;
  timezone: string;
  generatedAt: string;
  nextRefreshAt: string;
  metricVersion: string;
  availableCandidateCount: number;
  /** Present only when detailed export history exists for exactly one supported provider. */
  partialExportProvider?: DashboardExportProvider;
  insights: DashboardInsight[];
}
