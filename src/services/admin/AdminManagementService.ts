import { NotFoundError, ValidationError } from '../../core/errors';
import type { AccountDeletionService } from '../account/AccountDeletionService';
import type { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';
import type { MailboxSecurityPolicyRepository } from '../data/MailboxSecurityPolicyRepository';
import type { ImportTestScenarioRepository } from '../data/ImportTestScenarioRepository';

const asNumber = (value: unknown): number => Number(value ?? 0);
const asIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const blockedDiagnosticKey = /(?:token|cursor|authorization|cookie|body|subject|headers?|object_?key|etag|email_?content)/i;
const safeDiagnosticValue = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value
    .replace(/[\w.+-]+@[\w.-]+/g, '[address]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:ya29\.|1\/\/|GOCSPX-)[A-Za-z0-9_.\/-]+/g, '[redacted]')
    .slice(0, 1_500);
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => safeDiagnosticValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !blockedDiagnosticKey.test(key))
      .slice(0, 100)
      .map(([key, item]) => [key, safeDiagnosticValue(item, depth + 1)]));
  }
  return String(value).slice(0, 1_500);
};

const safeDiagnosticObject = (value: unknown): Readonly<Record<string, unknown>> => {
  const safe = safeDiagnosticValue(value);
  return safe && typeof safe === 'object' && !Array.isArray(safe) ? safe as Readonly<Record<string, unknown>> : {};
};

const importProvider = (row: DatabaseRow): string => {
  if (row.export_provider) return String(row.export_provider);
  if (row.kind === 'gmail_historical') return 'gmail';
  if (row.kind === 'outlook_historical') return 'microsoft';
  return String(row.kind).includes('tracking') ? 'mailbox tracking' : 'unknown';
};

const importOperationSummary = (row: DatabaseRow) => ({
  id: String(row.id),
  userId: String(row.user_id),
  userEmail: String(row.user_email),
  kind: String(row.kind),
  provider: importProvider(row),
  trigger: String(row.trigger_type),
  journeyContext: String(row.journey_context),
  status: String(row.status),
  phase: String(row.phase),
  progress: asNumber(row.progress),
  attempts: asNumber(row.attempts),
  errorCode: row.error_code ? String(row.error_code) : null,
  errorMessage: row.error_message ? String(row.error_message) : null,
  createdAt: asIso(row.created_at),
  queuedAt: asIso(row.queued_at),
  startedAt: asIso(row.started_at),
  completedAt: asIso(row.completed_at),
  updatedAt: asIso(row.updated_at),
  heartbeatAt: asIso(row.heartbeat_at),
  durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : Math.max(0, asNumber(row.duration_seconds)),
  lastHeartbeatAgeSeconds: row.heartbeat_age_seconds === null || row.heartbeat_age_seconds === undefined ? null : Math.max(0, asNumber(row.heartbeat_age_seconds)),
  stalled: Boolean(row.stalled),
});

export interface AdminUserFilters {
  query?: string;
  verified?: boolean;
  provider?: 'gmail' | 'microsoft';
  importState?: string;
  trackingState?: string;
  createdFrom?: Date;
  createdTo?: Date;
  issue?: AdminUserIssue;
  activityFrom?: Date;
  activityTo?: Date;
  sort?: AdminUserSort;
  limit: number;
  offset: number;
}

export interface AdminImportOperationFilters {
  query?: string;
  status?: string;
  kind?: string;
  limit: number;
  offset: number;
}

export type AdminUserIssue =
  | 'stuck_import'
  | 'recent_import_failure'
  | 'reconnect_required'
  | 'tracking_error';

export type AdminUserSort = 'created_desc' | 'last_activity_desc' | 'receipts_desc';

export type AdminTimelineCategory = 'account' | 'authentication' | 'connection' | 'import' | 'tracking' | 'administration';

export interface AdminTimelineEvent {
  readonly id: string;
  readonly kind: string;
  readonly category: AdminTimelineCategory;
  readonly occurredAt: string;
  readonly provider: string | null;
  readonly outcome: string | null;
  readonly provenance: 'exact' | 'inferred' | 'snapshot';
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

interface TimelineCursor { readonly occurredAt: string; readonly id: string; }

const timelineCursor = (value?: string): TimelineCursor | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.occurredAt !== 'string' || typeof candidate.id !== 'string' || Number.isNaN(Date.parse(candidate.occurredAt))) throw new Error('invalid');
    return { occurredAt: new Date(candidate.occurredAt).toISOString(), id: candidate.id };
  } catch {
    throw new ValidationError('Invalid timeline cursor', 'cursor');
  }
};

const encodeTimelineCursor = (event: AdminTimelineEvent): string =>
  Buffer.from(JSON.stringify({ occurredAt: event.occurredAt, id: event.id })).toString('base64url');

const timelineOrder = (left: AdminTimelineEvent, right: AdminTimelineEvent): number =>
  right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);

const isBeforeCursor = (event: AdminTimelineEvent, cursor?: TimelineCursor): boolean =>
  !cursor || event.occurredAt < cursor.occurredAt || (event.occurredAt === cursor.occurredAt && event.id < cursor.id);

export class AdminManagementService {
  constructor(
    private readonly database: DatabaseQueryExecutor,
    private readonly accountDeletion: Pick<AccountDeletionService, 'deleteAccount'>,
    private readonly mailboxSecurityPolicies: MailboxSecurityPolicyRepository,
    private readonly importTestScenarios: ImportTestScenarioRepository,
  ) {}

  async listUsers(filters: AdminUserFilters) {
    const search = filters.query?.trim().toLowerCase() || null;
    const orderBy = {
      created_desc: 'u.created_at DESC, u.id',
      last_activity_desc: 'MAX(COALESCE(r.created_at, u.created_at)) DESC, u.id',
      receipts_desc: 'COUNT(r.id) DESC, u.id',
    }[filters.sort ?? 'created_desc'];
    const result = await this.database.query<DatabaseRow>(
      `SELECT u.id, u.email, u.email_verified, u.timezone, u.created_at,
         COUNT(r.id)::int AS receipt_count, MAX(r.order_date) AS last_receipt_at,
         MAX(COALESCE(r.created_at, u.created_at)) AS last_activity_at,
         COALESCE(u.gmail_connected, false) AS gmail_connected,
         EXISTS (SELECT 1 FROM mailbox_connections mc WHERE mc.user_id=u.id AND mc.provider='microsoft' AND mc.status='connected') AS microsoft_connected,
         p.gmail_import_status, p.tracking_status,
         COUNT(*) OVER()::int AS total
       FROM users u LEFT JOIN receipts r ON r.user_id = u.id
       LEFT JOIN user_import_preferences p ON p.user_id = u.id
       WHERE ($1::text IS NULL OR POSITION($1 IN LOWER(u.email)) > 0 OR u.id::text = $1)
         AND ($2::boolean IS NULL OR u.email_verified = $2)
         AND ($3::text IS NULL OR ($3 = 'gmail' AND COALESCE(u.gmail_connected, false)) OR
              ($3 = 'microsoft' AND EXISTS (SELECT 1 FROM mailbox_connections mc WHERE mc.user_id=u.id AND mc.provider='microsoft' AND mc.status='connected')))
         AND ($4::timestamptz IS NULL OR u.created_at >= $4)
         AND ($5::timestamptz IS NULL OR u.created_at < $5)
         AND ($6::text IS NULL OR p.gmail_import_status=$6 OR EXISTS (
           SELECT 1 FROM mailbox_import_states mis WHERE mis.user_id=u.id AND mis.import_status=$6))
         AND ($7::text IS NULL OR p.tracking_status=$7)
         AND ($8::text IS NULL OR
           ($8='stuck_import' AND (EXISTS (SELECT 1 FROM gmail_sync_runs g WHERE g.user_id=u.id AND g.outcome='running' AND g.started_at<NOW()-INTERVAL '30 minutes') OR EXISTS (SELECT 1 FROM mailbox_sync_runs m WHERE m.user_id=u.id AND m.outcome='running' AND m.started_at<NOW()-INTERVAL '30 minutes'))) OR
           ($8='recent_import_failure' AND (EXISTS (SELECT 1 FROM gmail_sync_runs g WHERE g.user_id=u.id AND g.outcome IN ('failed','partial') AND g.started_at>=COALESCE($9::timestamptz,NOW()-INTERVAL '30 days') AND g.started_at<COALESCE($10::timestamptz,NOW())) OR EXISTS (SELECT 1 FROM mailbox_sync_runs m WHERE m.user_id=u.id AND m.outcome IN ('failed','partial') AND m.started_at>=COALESCE($9::timestamptz,NOW()-INTERVAL '30 days') AND m.started_at<COALESCE($10::timestamptz,NOW())))) OR
           ($8='reconnect_required' AND (p.tracking_status='reconnect_required' OR EXISTS (SELECT 1 FROM mailbox_connections mc WHERE mc.user_id=u.id AND mc.status='reconnect_required'))) OR
           ($8='tracking_error' AND p.tracking_status='error'))
       GROUP BY u.id, p.gmail_import_status, p.tracking_status ORDER BY ${orderBy} LIMIT $11 OFFSET $12`,
      [search, filters.verified ?? null, filters.provider ?? null, filters.createdFrom ?? null,
       filters.createdTo ?? null, filters.importState ?? null, filters.trackingState ?? null,
       filters.issue ?? null, filters.activityFrom ?? null, filters.activityTo ?? null,
       filters.limit, filters.offset],
    );
    return {
      users: result.rows.map((row) => ({
        id: String(row.id), email: String(row.email), emailVerified: Boolean(row.email_verified),
        timezone: String(row.timezone ?? 'America/New_York'), createdAt: asIso(row.created_at),
        receiptCount: asNumber(row.receipt_count), lastReceiptAt: asIso(row.last_receipt_at),
        lastActivityAt: asIso(row.last_activity_at),
        connections: { gmail: Boolean(row.gmail_connected), microsoft: Boolean(row.microsoft_connected) },
        importState: String(row.gmail_import_status ?? 'never_started'),
        trackingState: String(row.tracking_status ?? 'inactive'),
      })),
      pagination: { total: asNumber(result.rows[0]?.total), limit: filters.limit, offset: filters.offset },
    };
  }

  async getUser(userId: string, includeOwnerControls = false) {
    const userResult = await this.database.query<DatabaseRow>(
      `SELECT u.id, u.email, u.email_verified, u.timezone, u.created_at,
         COALESCE(u.gmail_connected, false) AS gmail_connected,
         (SELECT status FROM mailbox_connections WHERE user_id=u.id AND provider='microsoft') AS microsoft_status,
         p.gmail_import_status, p.tracking_status, p.ongoing_tracking_consent_state,
         p.last_successful_check_at, p.last_tracking_error_code
       FROM users u LEFT JOIN user_import_preferences p ON p.user_id=u.id WHERE u.id=$1`, [userId],
    );
    const user = userResult.rows[0];
    if (!user) throw new NotFoundError('User', userId);
    const [sources, gmailRuns, microsoftRuns, audits, mailboxSecurity, testScenarios, authMethods, exports] = await Promise.all([
      this.database.query<DatabaseRow>(
        'SELECT data_source, receipt_type, COUNT(*)::int AS count FROM receipts WHERE user_id=$1 GROUP BY data_source, receipt_type ORDER BY data_source, receipt_type', [userId]),
      this.database.query<DatabaseRow>(
        `SELECT id, 'gmail' AS provider, trigger_type, outcome, started_at, completed_at,
          emails_scanned, receipts_processed, new_orders, updated_orders, rejected_messages,
          decoded_bytes_examined, error_code
         FROM gmail_sync_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 25`, [userId]),
      this.database.query<DatabaseRow>(
        `SELECT id, provider, trigger_type, outcome, started_at, completed_at,
          emails_scanned, receipts_processed, new_orders, updated_orders, rejected_messages,
          decoded_bytes_examined, error_code
         FROM mailbox_sync_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 25`, [userId]),
      this.database.query<DatabaseRow>(
        `SELECT action, reason, outcome, created_at FROM admin_audit_events
         WHERE target_type='user' AND target_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]),
      this.mailboxSecurityPolicies.get(userId),
      includeOwnerControls ? this.importTestScenarios.get(userId) : Promise.resolve(null),
      this.database.query<DatabaseRow>(
        `SELECT provider AS method, created_at AS linked_at FROM oauth_accounts WHERE user_id=$1
         UNION ALL SELECT 'password' AS method, created_at AS linked_at FROM users WHERE id=$1 AND password IS NOT NULL
         ORDER BY linked_at`, [userId]),
      this.database.query<DatabaseRow>(
        `SELECT provider,status,requested_at,updated_at,error_code FROM user_export_provider_preferences
         WHERE user_id=$1 ORDER BY provider`, [userId]),
    ]);
    const runs = [...gmailRuns.rows, ...microsoftRuns.rows]
      .map((row) => ({
        id: String(row.id), provider: String(row.provider), trigger: String(row.trigger_type),
        outcome: String(row.outcome), startedAt: asIso(row.started_at), completedAt: asIso(row.completed_at),
        emailsScanned: asNumber(row.emails_scanned), receiptsProcessed: asNumber(row.receipts_processed),
        rejectedMessages: asNumber(row.rejected_messages), decodedBytesExamined: asNumber(row.decoded_bytes_examined),
        newOrders: asNumber(row.new_orders), updatedOrders: asNumber(row.updated_orders),
        errorCode: row.error_code ? String(row.error_code) : null,
      }))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return {
      user: { id: String(user.id), email: String(user.email), emailVerified: Boolean(user.email_verified),
        timezone: String(user.timezone), createdAt: asIso(user.created_at) },
      connections: { gmail: Boolean(user.gmail_connected), microsoft: user.microsoft_status ?? 'disconnected' },
      importState: { gmail: user.gmail_import_status ?? 'never_started' },
      tracking: {
        status: user.tracking_status ?? 'inactive',
        consent: user.ongoing_tracking_consent_state ?? 'not_offered',
        lastSuccessfulCheckAt: asIso(user.last_successful_check_at),
        lastErrorCode: user.last_tracking_error_code ? String(user.last_tracking_error_code) : null,
      },
      receiptSources: sources.rows.map((row) => ({ dataSource: String(row.data_source), receiptType: String(row.receipt_type), count: asNumber(row.count) })),
      importRuns: runs.slice(0, 25),
      auditEvents: audits.rows.map((row) => ({ action: String(row.action), reason: row.reason ? String(row.reason) : null, outcome: String(row.outcome), createdAt: asIso(row.created_at) })),
      authMethods: authMethods.rows.map((row) => ({ method: String(row.method), linkedAt: asIso(row.linked_at), provenance: 'exact' as const })),
      exports: exports.rows.map((row) => ({ provider: String(row.provider), status: String(row.status), requestedAt: asIso(row.requested_at), updatedAt: asIso(row.updated_at), errorCode: row.error_code ? String(row.error_code) : null })),
      mailboxSecurity,
      ...(testScenarios ? { testScenarios } : {}),
    };
  }

  async operationalAttention(from: Date, to: Date) {
    const result = await this.database.query<DatabaseRow>(
      `SELECT
        (SELECT COUNT(DISTINCT user_id) FROM (
          SELECT user_id FROM gmail_sync_runs WHERE outcome='running' AND started_at<NOW()-INTERVAL '30 minutes'
          UNION ALL SELECT user_id FROM mailbox_sync_runs WHERE outcome='running' AND started_at<NOW()-INTERVAL '30 minutes'
        ) stuck) AS stuck_imports,
        (SELECT COUNT(DISTINCT user_id) FROM (
          SELECT user_id FROM gmail_sync_runs WHERE outcome IN ('failed','partial') AND started_at >= $1 AND started_at < $2
          UNION ALL SELECT user_id FROM mailbox_sync_runs WHERE outcome IN ('failed','partial') AND started_at >= $1 AND started_at < $2
        ) failures) AS recent_import_failures,
        (SELECT COUNT(DISTINCT user_id) FROM (
          SELECT user_id FROM user_import_preferences WHERE tracking_status='reconnect_required'
          UNION ALL SELECT user_id FROM mailbox_connections WHERE status='reconnect_required'
        ) reconnects) AS reconnect_required,
        (SELECT COUNT(*) FROM user_import_preferences WHERE tracking_status='error') AS tracking_errors`,
      [from, to],
    );
    const row = result.rows[0] ?? {};
    return {
      generatedAt: new Date().toISOString(),
      items: [
        { key: 'stuck_imports', severity: 'critical', peopleCount: asNumber(row.stuck_imports), issue: 'stuck_import' },
        { key: 'recent_import_failures', severity: 'warning', peopleCount: asNumber(row.recent_import_failures), issue: 'recent_import_failure' },
        { key: 'reconnect_required', severity: 'warning', peopleCount: asNumber(row.reconnect_required), issue: 'reconnect_required' },
        { key: 'tracking_errors', severity: 'warning', peopleCount: asNumber(row.tracking_errors), issue: 'tracking_error' },
      ],
    };
  }

  async userTimeline(userId: string, options: { cursor?: string; limit: number; category?: AdminTimelineCategory }) {
    const cursor = timelineCursor(options.cursor);
    const before = cursor?.occurredAt ?? new Date().toISOString();
    const userResult = await this.database.query<DatabaseRow>(
      `SELECT id,created_at,email_verified,password IS NOT NULL AS has_password FROM users WHERE id=$1`, [userId]);
    const user = userResult.rows[0];
    if (!user) throw new NotFoundError('User', userId);
    const fetchLimit = Math.min(options.limit * 4, 200);
    const [oauth, analytics, gmailRuns, mailboxRuns, lifecycle, audits] = await Promise.all([
      this.database.query<DatabaseRow>('SELECT id,provider,created_at FROM oauth_accounts WHERE user_id=$1 ORDER BY created_at LIMIT 10', [userId]),
      this.database.query<DatabaseRow>(
        `SELECT event_id,event_name,occurred_at,provider,properties,source FROM analytics_events
         WHERE user_id=$1 AND occurred_at<=$2 AND event_name IN ('account_authenticated','email_verified','mailbox_connected','mailbox_disconnected')
         ORDER BY occurred_at DESC,event_id DESC LIMIT $3`, [userId, before, fetchLimit]),
      this.database.query<DatabaseRow>(
        `SELECT id,trigger_type,outcome,started_at,completed_at,emails_scanned,receipts_processed,new_orders,updated_orders,error_code
         FROM gmail_sync_runs WHERE user_id=$1 AND started_at<=$2 ORDER BY started_at DESC,id DESC LIMIT $3`, [userId, before, fetchLimit]),
      this.database.query<DatabaseRow>(
        `SELECT id,provider,trigger_type,outcome,started_at,completed_at,emails_scanned,receipts_processed,new_orders,updated_orders,error_code
         FROM mailbox_sync_runs WHERE user_id=$1 AND started_at<=$2 ORDER BY started_at DESC,id DESC LIMIT $3`, [userId, before, fetchLimit]),
      this.database.query<DatabaseRow>(
        `SELECT id,event_name,metadata,created_at FROM user_import_preference_events
         WHERE user_id=$1 AND created_at<=$2 ORDER BY created_at DESC,id DESC LIMIT $3`, [userId, before, fetchLimit]),
      this.database.query<DatabaseRow>(
        `SELECT id,action,outcome,reason,created_at FROM admin_audit_events
         WHERE target_type='user' AND target_id=$1 AND created_at<=$2 ORDER BY created_at DESC,id DESC LIMIT $3`, [userId, before, fetchLimit]),
    ]);
    const events: AdminTimelineEvent[] = [];
    const createdAt = asIso(user.created_at);
    if (createdAt) {
      const earliestOAuth = oauth.rows[0];
      const oauthCreatedAt = asIso(earliestOAuth?.created_at);
      const oauthWasAtCreation = oauthCreatedAt && Math.abs(Date.parse(oauthCreatedAt) - Date.parse(createdAt)) <= 5 * 60_000;
      const method = oauthWasAtCreation ? String(earliestOAuth.provider) : user.has_password ? 'password' : 'unknown';
      events.push({ id: `account:${userId}`, kind: 'account_created', category: 'account', occurredAt: createdAt, provider: method === 'unknown' ? null : method, outcome: 'success', provenance: method === 'unknown' ? 'snapshot' : 'inferred', details: { method } });
    }
    for (const row of analytics.rows) {
      const occurredAt = asIso(row.occurred_at); if (!occurredAt) continue;
      const name = String(row.event_name);
      const rawProperties = row.properties && typeof row.properties === 'object' ? row.properties as Record<string, unknown> : {};
      events.push({ id: `analytics:${String(row.event_id)}`, kind: name, category: name === 'account_authenticated' ? 'authentication' : name === 'email_verified' ? 'account' : 'connection', occurredAt, provider: row.provider ? String(row.provider) : null, outcome: 'success', provenance: row.source === 'backfill' ? 'inferred' : 'exact', details: name === 'account_authenticated' ? { method: String(rawProperties.method ?? row.provider ?? 'unknown') } : {} });
    }
    const addRun = (row: DatabaseRow, provider: string) => {
      const startedAt = asIso(row.started_at); if (!startedAt) return;
      const trigger = String(row.trigger_type); const outcome = String(row.outcome);
      events.push({ id: `run:${provider}:${String(row.id)}`, kind: trigger === 'background' ? 'background_sync' : 'historical_import', category: 'import', occurredAt: asIso(row.completed_at) ?? startedAt, provider, outcome, provenance: 'exact', details: { startedAt, emailsScanned: asNumber(row.emails_scanned), receiptsProcessed: asNumber(row.receipts_processed), newOrders: asNumber(row.new_orders), updatedOrders: asNumber(row.updated_orders), errorCode: row.error_code ? String(row.error_code) : null } });
    };
    gmailRuns.rows.forEach((row) => addRun(row, 'gmail'));
    mailboxRuns.rows.forEach((row) => addRun(row, String(row.provider)));
    for (const row of lifecycle.rows) {
      const occurredAt = asIso(row.created_at); if (!occurredAt) continue;
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {};
      const name = String(row.event_name);
      const category: AdminTimelineCategory = name.includes('consent') ? 'tracking' : 'import';
      const details = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value === null || ['string','number','boolean'].includes(typeof value))) as Record<string, string | number | boolean | null>;
      events.push({ id: `lifecycle:${String(row.id)}`, kind: name, category, occurredAt, provider: typeof metadata.provider === 'string' ? metadata.provider : null, outcome: name.endsWith('failed') ? 'failed' : null, provenance: 'exact', details });
    }
    for (const row of audits.rows) {
      const occurredAt = asIso(row.created_at); if (!occurredAt) continue;
      events.push({ id: `audit:${String(row.id)}`, kind: String(row.action), category: 'administration', occurredAt, provider: null, outcome: String(row.outcome), provenance: 'exact', details: { reason: row.reason ? String(row.reason) : null } });
    }
    const filtered = events.filter((event) => (!options.category || event.category === options.category) && isBeforeCursor(event, cursor)).sort(timelineOrder);
    const page = filtered.slice(0, options.limit);
    return { events: page, nextCursor: filtered.length > options.limit && page.length ? encodeTimelineCursor(page[page.length - 1]) : null };
  }

  updateMailboxSecurityPolicy(input: { userId: string; allowForwardedReceipts: boolean; reason: string; actorAdminId: string; requestId?: string }) {
    return this.mailboxSecurityPolicies.set(input);
  }

  updateGmailLongRunningScenario(input: { userId: string; enabled: boolean; reason: string; actorAdminId: string; requestId?: string }) {
    return this.importTestScenarios.setGmailLongRunning(input);
  }

  async importOperations(filters: AdminImportOperationFilters) {
    const search = filters.query?.trim().toLowerCase() || null;
    const result = await this.database.query<DatabaseRow>(
      `SELECT j.*,u.email AS user_email,COUNT(*) OVER()::int AS total,
         EXTRACT(EPOCH FROM (COALESCE(j.completed_at,NOW())-j.created_at))::float AS duration_seconds,
         EXTRACT(EPOCH FROM (NOW()-j.heartbeat_at))::float AS heartbeat_age_seconds,
         (j.status='running' AND COALESCE(j.heartbeat_at,j.updated_at)<NOW()-INTERVAL '2 minutes') AS stalled
       FROM import_jobs j JOIN users u ON u.id=j.user_id
       WHERE ($1::text IS NULL OR POSITION($1 IN LOWER(u.email))>0 OR j.id::text=$1 OR j.user_id::text=$1)
         AND ($2::text IS NULL OR ($2='active' AND j.status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')) OR j.status=$2)
         AND ($3::text IS NULL OR j.kind=$3)
       ORDER BY CASE WHEN j.status IN ('running','retrying','queued','pending_dispatch','awaiting_upload') THEN 0 ELSE 1 END,
         j.updated_at DESC,j.id DESC LIMIT $4 OFFSET $5`,
      [search,filters.status ?? null,filters.kind ?? null,filters.limit,filters.offset],
    );
    return {
      operations: result.rows.map(importOperationSummary),
      pagination: { total: asNumber(result.rows[0]?.total), limit: filters.limit, offset: filters.offset },
      generatedAt: new Date().toISOString(),
    };
  }

  async importOperation(operationId: string) {
    const [operationResult, eventsResult] = await Promise.all([
      this.database.query<DatabaseRow>(
        `SELECT j.*,u.email AS user_email,
           EXTRACT(EPOCH FROM (COALESCE(j.completed_at,NOW())-j.created_at))::float AS duration_seconds,
           EXTRACT(EPOCH FROM (NOW()-j.heartbeat_at))::float AS heartbeat_age_seconds,
           (j.status='running' AND COALESCE(j.heartbeat_at,j.updated_at)<NOW()-INTERVAL '2 minutes') AS stalled
         FROM import_jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1`,
        [operationId],
      ),
      this.database.query<DatabaseRow>(
        `SELECT id,event_type,attempt,status,phase,progress,error_code,details,created_at
         FROM import_job_events WHERE job_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200`,
        [operationId],
      ),
    ]);
    const row = operationResult.rows[0];
    if (!row) throw new NotFoundError('Import operation', operationId);
    const events = eventsResult.rows.map((event) => ({
      id: String(event.id), eventType: String(event.event_type), attempt: asNumber(event.attempt),
      status: String(event.status), phase: String(event.phase), progress: asNumber(event.progress),
      errorCode: event.error_code ? String(event.error_code) : null,
      details: safeDiagnosticObject(event.details), createdAt: asIso(event.created_at),
    }));
    const retryEvent = row.status === 'retrying'
      ? events.find((event) => event.status === 'retrying' && ['attempt_failed_retrying','test_delay_started','infrastructure_wait'].includes(event.eventType))
      : undefined;
    const retryNotBefore = retryEvent && typeof retryEvent.details.retryNotBefore === 'string' ? retryEvent.details.retryNotBefore
      : retryEvent && typeof retryEvent.details.resumeAt === 'string' ? retryEvent.details.resumeAt : null;
    const retryBy = retryEvent && typeof retryEvent.details.retryBy === 'string' ? retryEvent.details.retryBy : retryNotBefore;
    return {
      operation: {
        ...importOperationSummary(row),
        originalFilename: row.original_filename ? String(row.original_filename).slice(0, 255) : null,
        contentType: row.submitted_content_type ? String(row.submitted_content_type) : row.content_type ? String(row.content_type) : null,
        contentLength: row.submitted_content_length === null || row.submitted_content_length === undefined
          ? row.content_length === null || row.content_length === undefined ? null : asNumber(row.content_length)
          : asNumber(row.submitted_content_length),
        checkpoint: safeDiagnosticObject(row.checkpoint),
        result: safeDiagnosticObject(row.result),
        retryNotBefore,
        retryBy,
      },
      events,
      generatedAt: new Date().toISOString(),
    };
  }

  async deleteUser(input: { userId: string; confirmationEmail: string; reason: string; actorAdminId: string; requestId?: string }) {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) throw new ValidationError('Must be 10–500 characters', 'reason');
    const result = await this.database.query<DatabaseRow>('SELECT email FROM users WHERE id=$1', [input.userId]);
    const email = result.rows[0]?.email;
    if (typeof email !== 'string') throw new NotFoundError('User', input.userId);
    if (email.toLowerCase() !== input.confirmationEmail.trim().toLowerCase()) {
      throw new ValidationError('Must exactly match the account email', 'confirmationEmail');
    }
    return this.accountDeletion.deleteAccount(input.userId, undefined, {
      actorAdminId: input.actorAdminId, reason, requestId: input.requestId,
    });
  }

  async imports(from: Date, to: Date, provider?: string, outcome?: string) {
    const [result, stuck, errors] = await Promise.all([this.database.query<DatabaseRow>(
      `WITH runs AS (
        SELECT 'gmail'::text AS provider, trigger_type, outcome, started_at, completed_at,
          emails_scanned, receipts_processed, new_orders, updated_orders, error_code FROM gmail_sync_runs
        UNION ALL
        SELECT provider, trigger_type, outcome, started_at, completed_at,
          emails_scanned, receipts_processed, new_orders, updated_orders, error_code FROM mailbox_sync_runs
      ) SELECT provider, outcome, COUNT(*)::int AS runs,
        AVG(EXTRACT(EPOCH FROM (completed_at-started_at))*1000)::float AS average_duration_ms,
        SUM(receipts_processed)::int AS receipts_processed, error_code
      FROM runs WHERE started_at >= $1 AND started_at < $2
        AND ($3::text IS NULL OR provider=$3) AND ($4::text IS NULL OR outcome=$4)
      GROUP BY provider, outcome, error_code ORDER BY runs DESC`, [from, to, provider ?? null, outcome ?? null]),
      this.database.query<DatabaseRow>(
        `SELECT COUNT(*)::int AS count FROM (
          SELECT id FROM gmail_sync_runs WHERE outcome='running' AND started_at < NOW()-INTERVAL '30 minutes'
          UNION ALL SELECT id FROM mailbox_sync_runs WHERE outcome='running' AND started_at < NOW()-INTERVAL '30 minutes'
        ) stuck_runs`),
      this.database.query<DatabaseRow>(
        `SELECT error_code,COUNT(*)::int AS count FROM (
          SELECT error_code,started_at FROM gmail_sync_runs WHERE error_code IS NOT NULL
          UNION ALL SELECT error_code,started_at FROM mailbox_sync_runs WHERE error_code IS NOT NULL
        ) failures WHERE started_at >= $1 AND started_at < $2
        GROUP BY error_code ORDER BY count DESC LIMIT 10`, [from, to]),
    ]);
    const groups = result.rows.map((row) => ({ provider: String(row.provider), outcome: String(row.outcome), runs: asNumber(row.runs), averageDurationMs: asNumber(row.average_duration_ms), receiptsProcessed: asNumber(row.receipts_processed), errorCode: row.error_code ? String(row.error_code) : null }));
    const totals = groups.reduce((value, group) => ({ ...value, [group.outcome]: (value[group.outcome] ?? 0) + group.runs }), {} as Record<string, number>);
    const terminal = (totals.success ?? 0) + (totals.partial ?? 0) + (totals.failed ?? 0);
    return {
      groups,
      summary: { totals, successRate: terminal ? Math.round((totals.success ?? 0) / terminal * 1000) / 10 : null, stuckRuns: asNumber(stuck.rows[0]?.count) },
      topErrorCodes: errors.rows.map((row) => ({ errorCode: String(row.error_code), count: asNumber(row.count) })),
    };
  }

  async auditEvents(limit: number, offset: number) {
    const result = await this.database.query<DatabaseRow>(
      `SELECT e.id, e.action, e.target_type, e.target_id, e.reason, e.outcome, e.created_at,
        a.email AS actor_email, COUNT(*) OVER()::int AS total
       FROM admin_audit_events e LEFT JOIN admin_users a ON a.id=e.actor_admin_id
       ORDER BY e.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset],
    );
    return { events: result.rows.map((row) => ({ id: String(row.id), action: String(row.action), targetType: String(row.target_type), targetId: row.target_id ? String(row.target_id) : null, reason: row.reason ? String(row.reason) : null, outcome: String(row.outcome), actorEmail: row.actor_email ? String(row.actor_email) : null, createdAt: asIso(row.created_at) })), pagination: { total: asNumber(result.rows[0]?.total), limit, offset } };
  }
}
