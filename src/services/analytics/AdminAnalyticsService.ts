import { ValidationError } from '../../core/errors';
import type { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';

export const CLIENT_ANALYTICS_EVENTS = [
  'app_session_started', 'onboarding_started', 'onboarding_completed',
  'mailbox_provider_selected', 'dashboard_viewed', 'history_viewed',
  'history_filter_changed', 'wrapped_started', 'wrapped_slide_viewed',
  'wrapped_exited', 'wrapped_completed', 'wrapped_share_tapped',
  'wrapped_share_completed', 'wrapped_share_failed', 'export_offer_shown',
  'export_offer_clicked', 'export_offer_dismissed',
] as const;
export type ClientAnalyticsEventName = (typeof CLIENT_ANALYTICS_EVENTS)[number];

export interface ClientAnalyticsEventInput {
  readonly eventId: string;
  readonly eventName: ClientAnalyticsEventName;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly platform?: 'ios' | 'android';
  readonly appVersion?: string;
  readonly provider?: 'gmail' | 'microsoft' | 'uber_eats' | 'doordash';
  readonly environment?: 'development' | 'preview' | 'staging' | 'production';
  readonly sessionId?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_KEY = /(email|token|password|receipt|restaurant|item|filename|url)/i;
const EVENT_SET = new Set<string>(CLIENT_ANALYTICS_EVENTS);
const PROPERTY_KEYS: Partial<Record<ClientAnalyticsEventName, readonly string[]>> = {
  mailbox_provider_selected: ['provider'],
  history_filter_changed: ['filter'],
  wrapped_slide_viewed: ['slideId', 'deckPosition', 'deckLength'],
  wrapped_exited: ['slideId', 'deckPosition', 'deckLength'],
  wrapped_share_completed: ['method'],
  wrapped_share_failed: ['errorCode'],
  export_offer_shown: ['surface'],
  export_offer_clicked: ['surface'],
  export_offer_dismissed: ['surface'],
};

const propertyValue = (value: unknown): boolean =>
  value === null || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length <= 120 && !/@/.test(value) && !/^https?:/i.test(value));

const validateProperties = (
  eventName: ClientAnalyticsEventName,
  value: unknown,
): Record<string, string | number | boolean | null> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Must be an object', 'properties');
  const allowed = new Set(PROPERTY_KEYS[eventName] ?? []);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 12) throw new ValidationError('Too many properties', 'properties');
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, candidate] of entries) {
    if (FORBIDDEN_KEY.test(key) || !allowed.has(key) || !propertyValue(candidate)) {
      throw new ValidationError(`Property ${key} is not allowed`, 'properties');
    }
    result[key] = candidate as string | number | boolean | null;
  }
  return result;
};

export interface AnalyticsBatchResult { accepted: number; duplicates: number; rejected: number; }

export class AnalyticsEventService {
  constructor(private readonly database: DatabaseQueryExecutor, private readonly nowMs: () => number = Date.now) {}

  async ingest(userId: string, rawEvents: unknown): Promise<AnalyticsBatchResult> {
    if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > 50) {
      throw new ValidationError('Must contain between 1 and 50 events', 'events');
    }
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const raw of rawEvents) {
      try {
        const event = this.validate(raw);
        const result = await this.database.query(
          `INSERT INTO analytics_events
           (event_id, event_name, schema_version, occurred_at, user_id, source, platform,
            app_version, provider, environment, session_id, properties)
           VALUES ($1,$2,$3,$4,$5,'mobile',$6,$7,$8,$9,$10,$11::JSONB)
           ON CONFLICT (event_id) DO NOTHING`,
          [event.eventId, event.eventName, event.schemaVersion, event.occurredAt, userId,
           event.platform ?? null, event.appVersion ?? null, event.provider ?? null,
           event.environment ?? null, event.sessionId ?? null, JSON.stringify(event.properties ?? {})],
        );
        if (result.rowCount === 0) duplicates += 1; else accepted += 1;
      } catch (error) {
        if (error instanceof ValidationError) rejected += 1; else throw error;
      }
    }
    return { accepted, duplicates, rejected };
  }

  async recordServerEvent(input: {
    eventId: string; eventName: string; occurredAt?: Date; userId?: string;
    provider?: string; properties?: Record<string, unknown>;
  }, executor: DatabaseQueryExecutor = this.database): Promise<void> {
    await executor.query(
      `INSERT INTO analytics_events
       (event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
       VALUES ($1,$2,1,$3,$4,'server','server',$5,$6::JSONB) ON CONFLICT DO NOTHING`,
      [input.eventId, input.eventName, input.occurredAt ?? new Date(), input.userId ?? null,
       input.provider ?? null, JSON.stringify(input.properties ?? {})],
    );
  }

  private validate(value: unknown): ClientAnalyticsEventInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Must be an object', 'event');
    const raw = value as Record<string, unknown>;
    if (typeof raw.eventId !== 'string' || !UUID.test(raw.eventId)) throw new ValidationError('Invalid UUID', 'eventId');
    if (typeof raw.eventName !== 'string' || !EVENT_SET.has(raw.eventName)) throw new ValidationError('Unsupported event', 'eventName');
    if (raw.schemaVersion !== 1) throw new ValidationError('Unsupported schema version', 'schemaVersion');
    if (typeof raw.occurredAt !== 'string') throw new ValidationError('Invalid timestamp', 'occurredAt');
    const occurred = Date.parse(raw.occurredAt);
    if (!Number.isFinite(occurred) || occurred < this.nowMs() - 7 * 86_400_000 || occurred > this.nowMs() + 300_000) {
      throw new ValidationError('Timestamp is outside the accepted window', 'occurredAt');
    }
    if (raw.platform !== undefined && raw.platform !== 'ios' && raw.platform !== 'android') throw new ValidationError('Invalid platform', 'platform');
    for (const field of ['appVersion', 'sessionId'] as const) {
      if (raw[field] !== undefined && (typeof raw[field] !== 'string' || raw[field].length > 120)) throw new ValidationError('Invalid value', field);
    }
    const provider = raw.provider;
    if (provider !== undefined && !['gmail','microsoft','uber_eats','doordash'].includes(String(provider))) throw new ValidationError('Invalid provider', 'provider');
    const environment = raw.environment;
    if (environment !== undefined && !['development','preview','staging','production'].includes(String(environment))) throw new ValidationError('Invalid environment', 'environment');
    return {
      eventId: raw.eventId,
      eventName: raw.eventName as ClientAnalyticsEventName,
      schemaVersion: 1,
      occurredAt: new Date(occurred).toISOString(),
      platform: raw.platform as 'ios' | 'android' | undefined,
      appVersion: raw.appVersion as string | undefined,
      provider: provider as ClientAnalyticsEventInput['provider'],
      environment: environment as ClientAnalyticsEventInput['environment'],
      sessionId: raw.sessionId as string | undefined,
      properties: validateProperties(raw.eventName as ClientAnalyticsEventName, raw.properties),
    };
  }
}

const count = (value: unknown): number => Number(value ?? 0);
const isoDay = (value: unknown): string => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export class AdminAnalyticsQueryService {
  constructor(private readonly database: DatabaseQueryExecutor) {}

  async overview(from: Date, to: Date) {
    const durationMs = to.getTime() - from.getTime();
    const previousFrom = new Date(from.getTime() - durationMs);
    const [result, previous, trend, imports, providers, collection] = await Promise.all([
      this.database.query<DatabaseRow>(
      `SELECT event_name, COUNT(DISTINCT user_id)::int AS users, COUNT(*)::int AS events
       FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2
         AND event_name = ANY($3::text[]) GROUP BY event_name`,
      [from, to, ['account_registered','email_verified','user_activated','app_session_started']]),
      this.database.query<DatabaseRow>(
        `SELECT event_name,COUNT(DISTINCT user_id)::int AS users FROM analytics_events
         WHERE occurred_at >= $1 AND occurred_at < $2 AND event_name=ANY($3::text[]) GROUP BY event_name`,
        [previousFrom, from, ['account_registered','email_verified','user_activated','app_session_started']]),
      this.database.query<DatabaseRow>(
        `SELECT occurred_at::date AS day,event_name,COUNT(DISTINCT user_id)::int AS users
         FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2
           AND event_name=ANY($3::text[]) GROUP BY day,event_name ORDER BY day`,
        [from, to, ['account_registered','user_activated','app_session_started']]),
      this.database.query<DatabaseRow>(
        `SELECT outcome,COUNT(*)::int AS count FROM (
          SELECT outcome,started_at FROM gmail_sync_runs UNION ALL SELECT outcome,started_at FROM mailbox_sync_runs
        ) runs WHERE started_at >= $1 AND started_at < $2 AND outcome <> 'running' GROUP BY outcome`, [from, to]),
      this.database.query<DatabaseRow>(
        `SELECT provider,COUNT(DISTINCT user_id)::int AS users FROM (
          SELECT id AS user_id,'gmail'::text AS provider FROM users WHERE COALESCE(gmail_connected,FALSE)
          UNION ALL SELECT user_id,provider FROM mailbox_connections WHERE status='connected'
        ) connections GROUP BY provider ORDER BY provider`),
      this.database.query<DatabaseRow>(
        `SELECT MIN(created_at) AS started_at FROM analytics_events WHERE source='mobile'`),
    ]);
    const metrics = Object.fromEntries(result.rows.map((row) => [String(row.event_name), { users: count(row.users), events: count(row.events) }]));
    const previousUsers = new Map(previous.rows.map((row) => [String(row.event_name), count(row.users)]));
    const comparisons = Object.fromEntries(Object.entries(metrics).map(([name, value]) => {
      const baseline = previousUsers.get(name) ?? 0;
      return [name, { previousUsers: baseline, changePercent: baseline ? Math.round((value.users-baseline)/baseline*1000)/10 : null }];
    }));
    const importTotals = Object.fromEntries(imports.rows.map((row) => [String(row.outcome), count(row.count)]));
    const terminalRuns = Object.values(importTotals).reduce((sum, value) => sum + value, 0);
    return {
      from: from.toISOString(), to: to.toISOString(), metrics, comparisons,
      trend: trend.rows.map((row) => ({ date: isoDay(row.day), eventName: String(row.event_name), users: count(row.users) })),
      imports: { totals: importTotals, successRate: terminalRuns ? Math.round((importTotals.success ?? 0)/terminalRuns*1000)/10 : null },
      providerDistribution: providers.rows.map((row) => ({ provider: String(row.provider), users: count(row.users) })),
      clientCollectionStartedAt: collection.rows[0]?.started_at ? new Date(String(collection.rows[0].started_at)).toISOString() : null,
      collectedAt: new Date().toISOString(),
    };
  }

  async funnel(from: Date, to: Date, kind: 'activation' | 'wrapped' | 'export') {
    const definitions = {
      activation: ['account_registered','mailbox_provider_selected','mailbox_connected','historical_import_completed','user_activated'],
      wrapped: ['wrapped_started','wrapped_completed','wrapped_share_tapped','wrapped_share_completed'],
      export: ['export_offer_shown','export_offer_clicked','export_import_completed'],
    } as const;
    const names = definitions[kind];
    const steps = names.map((_, index) => {
      const eventParameter = index + 3;
      if (index === 0) {
        return `step_0 AS (
          SELECT user_id,MIN(occurred_at) AS reached_at FROM analytics_events
          WHERE occurred_at >= $1 AND occurred_at < $2 AND user_id IS NOT NULL
            AND event_name=$${eventParameter} GROUP BY user_id
        )`;
      }
      return `step_${index} AS (
        SELECT event.user_id,MIN(event.occurred_at) AS reached_at
        FROM analytics_events event JOIN step_${index - 1} previous ON previous.user_id=event.user_id
        WHERE event.occurred_at >= previous.reached_at AND event.occurred_at < $2
          AND event.event_name=$${eventParameter}
        GROUP BY event.user_id
      )`;
    });
    const selections = names.map((_, index) =>
      `SELECT $${index + 3}::text AS event_name,COUNT(*)::int AS users FROM step_${index}`,
    );
    const result = await this.database.query<DatabaseRow>(
      `WITH ${steps.join(',')} ${selections.join(' UNION ALL ')}`, [from, to, ...names],
    );
    const values = new Map(result.rows.map((row) => [String(row.event_name), count(row.users)]));
    let previous: number | null = null;
    return { kind, steps: names.map((name) => {
      const users = values.get(name) ?? 0;
      const conversionFromPrevious = previous === null ? 100 : previous > 0 ? Math.round(users / previous * 1000) / 10 : 0;
      previous = users;
      return { name, users, conversionFromPrevious };
    }) };
  }

  async retention(from: Date, to: Date) {
    const result = await this.database.query<DatabaseRow>(
      `WITH activated AS (
         SELECT user_id, MIN(occurred_at)::date AS cohort_date FROM analytics_events
         WHERE event_name = 'user_activated' AND user_id IS NOT NULL GROUP BY user_id
       ), active AS (
         SELECT DISTINCT user_id, occurred_at::date AS active_date FROM analytics_events
         WHERE event_name = 'app_session_started' AND user_id IS NOT NULL
       ) SELECT a.cohort_date, COUNT(*)::int AS cohort_size,
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM active x WHERE x.user_id=a.user_id AND x.active_date=a.cohort_date+1))::int AS d1,
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM active x WHERE x.user_id=a.user_id AND x.active_date=a.cohort_date+7))::int AS d7,
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM active x WHERE x.user_id=a.user_id AND x.active_date=a.cohort_date+30))::int AS d30
       FROM activated a WHERE a.cohort_date >= $1::date AND a.cohort_date < $2::date
       GROUP BY a.cohort_date ORDER BY a.cohort_date`, [from, to],
    );
    return { cohorts: result.rows.map((row) => ({ date: isoDay(row.cohort_date), size: count(row.cohort_size), d1: count(row.d1), d7: count(row.d7), d30: count(row.d30) })) };
  }

  async features(from: Date, to: Date) {
    const result = await this.database.query<DatabaseRow>(
      `SELECT event_name, COUNT(DISTINCT user_id)::int AS users, COUNT(*)::int AS events
       FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2
         AND (event_name LIKE 'wrapped_%' OR event_name LIKE 'export_offer_%' OR event_name IN ('dashboard_viewed','history_viewed','export_import_completed'))
       GROUP BY event_name ORDER BY event_name`, [from, to],
    );
    const metrics = result.rows.map((row) => ({ eventName: String(row.event_name), users: count(row.users), events: count(row.events) }));
    const users = new Map(metrics.map((metric) => [metric.eventName, metric.users]));
    const rate = (numerator: string, denominator: string) => {
      const base = users.get(denominator) ?? 0;
      return base ? Math.round((users.get(numerator) ?? 0) / base * 1000) / 10 : null;
    };
    return {
      metrics,
      conversions: {
        wrappedCompletionRate: rate('wrapped_completed', 'wrapped_started'),
        wrappedShareTapRate: rate('wrapped_share_tapped', 'wrapped_completed'),
        wrappedShareCompletionRate: rate('wrapped_share_completed', 'wrapped_share_tapped'),
        exportOfferClickRate: rate('export_offer_clicked', 'export_offer_shown'),
        exportCompletionRate: rate('export_import_completed', 'export_offer_clicked'),
      },
    };
  }
}
