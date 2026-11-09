import { AppError, ConflictError, NotFoundError } from '../../core/errors';
import { importCompletionResult } from '../import/ImportCompletionResult';
import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';
import {
  IMPORT_JOB_KINDS,
  IMPORT_JOB_STATUSES,
  IMPORT_JOURNEY_CONTEXTS,
  EXPORT_PROVIDERS,
  type ExportProvider,
  type ImportJob,
  type ImportJobKind,
  type ImportJobStatus,
  type ImportJobTrigger,
  type ImportJourneyContext,
} from '../import/ImportJobTypes';

type Row = Record<string, unknown>;
const MAX_SUBMITTED_EXPORTS_PER_PROVIDER_PER_DAY = 3;
const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new Error(`Invalid import job ${key}`);
  return value;
};
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null || row[key] === undefined ? null : text(row, key);
const number = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`Invalid import job ${key}`);
  return value;
};
const timestamp = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid import job ${key}`);
  return date.toISOString();
};
const enumValue = <T extends string>(row: Row, key: string, allowed: readonly T[]): T => {
  const value = text(row, key);
  if (!allowed.includes(value as T)) throw new Error(`Invalid import job ${key}`);
  return value as T;
};
const jsonObject = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const blockedEventDetailKey = /(?:token|cursor|authorization|cookie|body|subject|headers?|object_?key|etag|email_?content)/i;
const redactEventText = (value: string): string => value
  .replace(/[\w.+-]+@[\w.-]+/g, '[address]')
  .replace(/https?:\/\/[^\s"<>]+/gi, '[url]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/(?:ya29\.|1\/\/|GOCSPX-)[A-Za-z0-9_.\/-]+/g, '[redacted]')
  .slice(0, 1_500);
const safeEventDetailValue = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactEventText(value);
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => safeEventDetailValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !blockedEventDetailKey.test(key))
    .slice(0, 100)
    .map(([key, item]) => [key, safeEventDetailValue(item, depth + 1)]));
  return redactEventText(String(value));
};
const safeEventDetails = (value?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const safe = safeEventDetailValue(value ?? {});
  return safe && typeof safe === 'object' && !Array.isArray(safe) ? safe as Readonly<Record<string, unknown>> : {};
};

const selectColumns = `id,user_id,kind,trigger_type,journey_context,status,phase,progress,result,error_code,
  error_message,attempts,heartbeat_at,object_key,original_filename,content_type,content_length,
  export_provider,object_etag,submitted_content_type,submitted_content_length,
  import_generation,checkpoint,created_at,queued_at,started_at,completed_at,expires_at,updated_at`;

const decode = (row: Row): ImportJob => ({
  id: text(row, 'id'),
  userId: text(row, 'user_id'),
  kind: enumValue(row, 'kind', IMPORT_JOB_KINDS),
  trigger: enumValue(row, 'trigger_type', ['user', 'scheduler'] as const),
  journeyContext: enumValue(row, 'journey_context', IMPORT_JOURNEY_CONTEXTS),
  status: enumValue(row, 'status', IMPORT_JOB_STATUSES),
  phase: text(row, 'phase'),
  progress: number(row, 'progress'),
  result: jsonObject(row.result),
  errorCode: nullableText(row, 'error_code'),
  errorMessage: nullableText(row, 'error_message'),
  attempts: number(row, 'attempts'),
  heartbeatAt: timestamp(row, 'heartbeat_at'),
  objectKey: nullableText(row, 'object_key'),
  originalFilename: nullableText(row, 'original_filename'),
  contentType: nullableText(row, 'content_type'),
  contentLength: row.content_length === null || row.content_length === undefined ? null : number(row, 'content_length'),
  exportProvider: row.export_provider === null || row.export_provider === undefined
    ? null
    : enumValue(row, 'export_provider', EXPORT_PROVIDERS),
  objectEtag: nullableText(row, 'object_etag'),
  submittedContentType: nullableText(row, 'submitted_content_type'),
  submittedContentLength: row.submitted_content_length === null || row.submitted_content_length === undefined
    ? null
    : number(row, 'submitted_content_length'),
  importGeneration: number(row, 'import_generation'),
  checkpoint: jsonObject(row.checkpoint) ?? {},
  createdAt: timestamp(row, 'created_at')!,
  queuedAt: timestamp(row, 'queued_at'),
  startedAt: timestamp(row, 'started_at'),
  completedAt: timestamp(row, 'completed_at'),
  expiresAt: timestamp(row, 'expires_at'),
  updatedAt: timestamp(row, 'updated_at')!,
});

export interface CreateImportJobInput {
  readonly userId: string;
  readonly kind: ImportJobKind;
  readonly trigger: ImportJobTrigger;
  readonly journeyContext?: ImportJourneyContext;
  readonly automaticUpdates?: boolean;
  readonly idempotencyKey?: string;
  readonly awaitingUpload?: boolean;
  readonly objectKey?: string;
  readonly originalFilename?: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly exportProvider?: ExportProvider;
  readonly initialCheckpoint?: Readonly<Record<string, unknown>>;
}

export interface OutboxEvent {
  readonly id: number;
  readonly jobId: string;
  readonly eventType: 'dispatch' | 'notify';
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ImportObjectCleanupCandidate {
  readonly jobId: string;
  readonly objectKey: string;
}

export interface DurableQueueSnapshot {
  readonly statuses: Readonly<Record<string, number>>;
  readonly unpublishedOutboxCount: number;
  readonly oldestUnpublishedOutboxAgeSeconds: number | null;
}

export interface CancelledImportJob {
  readonly id: string;
  readonly kind: ImportJobKind;
}

export class ImportJobRepository {
  constructor(
    private readonly database: DatabaseTransactionRunner & DatabaseQueryExecutor,
    private readonly maximumActiveJobs = 1000,
  ) {}

  async create(input: CreateImportJobInput): Promise<ImportJob> {
    return this.database.withTransaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
      const account = await transaction.query<Row>('SELECT deletion_requested_at FROM users WHERE id=$1 FOR SHARE', [input.userId]);
      if (!account.rows[0]) throw new NotFoundError('User', input.userId);
      if (account.rows[0].deletion_requested_at) throw new ConflictError('ACCOUNT_DELETION_PENDING', 'Your account is being deleted. New imports cannot be started.');
      if (input.idempotencyKey) {
        const existing = await transaction.query<Row>(
          `SELECT ${selectColumns} FROM import_jobs WHERE user_id=$1 AND idempotency_key=$2`,
          [input.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const job = decode(existing.rows[0]);
          if (job.kind !== input.kind || job.journeyContext !== (input.journeyContext ?? 'legacy')) {
            throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different import journey.');
          }
          return job;
        }
      }
      const active = await transaction.query<Row>(
        `SELECT ${selectColumns} FROM import_jobs WHERE user_id=$1
         AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')
         AND ((kind<>'export_ready_check' AND $2<>'export_ready_check') OR (kind='export_ready_check' AND $2='export_ready_check' AND export_provider=$3))
         ORDER BY created_at DESC LIMIT 1`,
        [input.userId, input.kind, input.exportProvider ?? null],
      );
      if (active.rows[0]) {
        const activeJob = decode(active.rows[0]);
        if (input.awaitingUpload && activeJob.status === 'awaiting_upload') {
          const superseded = await transaction.query<Row>(
            `UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW()
             WHERE id=$1 AND status='awaiting_upload' RETURNING ${selectColumns}`,
            [activeJob.id],
          );
          if (superseded.rows[0]) await this.insertEvent(transaction, decode(superseded.rows[0]), 'superseded');
        } else {
          throw new ConflictError('IMPORT_IN_PROGRESS', 'Another import is already active for this account.');
        }
      }
      const globalCapacity = await transaction.query<Row>(
        `SELECT COUNT(*) AS count FROM import_jobs WHERE status IN ('pending_dispatch','queued','running','retrying')`,
      );
      if (Number(globalCapacity.rows[0]?.count ?? 0) >= this.maximumActiveJobs) {
        throw new ConflictError('IMPORT_QUEUE_FULL', 'Imports are temporarily at capacity. Please try again shortly.');
      }
      if (input.trigger === 'user' && input.kind === 'export_file' && input.awaitingUpload && input.exportProvider) {
        const limits = await transaction.query<Row>(
          `WITH submitted AS (
             SELECT created_at
             FROM import_jobs
             WHERE user_id=$1
               AND trigger_type='user'
               AND kind='export_file'
               AND export_provider=$2
               AND submitted_content_length IS NOT NULL
               AND status IN ('pending_dispatch','queued','running','retrying','succeeded')
               AND created_at >= NOW()-INTERVAL '1 day'
             ORDER BY created_at DESC
           )
           SELECT COUNT(*) AS submitted_daily,
             (SELECT created_at + INTERVAL '1 day' FROM submitted OFFSET ($3 - 1) LIMIT 1) AS retry_at
           FROM submitted`,
          [input.userId, input.exportProvider, MAX_SUBMITTED_EXPORTS_PER_PROVIDER_PER_DAY],
        );
        const row = limits.rows[0] ?? {};
        if (Number(row.submitted_daily) >= MAX_SUBMITTED_EXPORTS_PER_PROVIDER_PER_DAY) {
          const providerName = input.exportProvider === 'uber_eats' ? 'Uber Eats' : 'DoorDash';
          throw new AppError({
            code: 'EXPORT_UPLOAD_RATE_LIMITED',
            message: `${providerName} import limit reached for this account.`,
            publicMessage: `You’ve started several ${providerName} imports recently. Come back tomorrow to try again.`,
            details: {
              provider: input.exportProvider,
              retryAt: timestamp(row, 'retry_at'),
            },
          });
        }
      } else if (input.trigger === 'user') {
        const limits = await transaction.query<Row>(
          `SELECT
             COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '15 minutes') AS recent,
             COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '1 day') AS daily
           FROM import_jobs
           WHERE user_id=$1 AND trigger_type='user' AND kind<>'export_file'`,
          [input.userId],
        );
        const row = limits.rows[0] ?? {};
        if (Number(row.recent) >= 3 || Number(row.daily) >= 10) {
          throw new ConflictError('IMPORT_RATE_LIMITED', 'Too many imports were started recently. Please try again later.');
        }
      }
      const users = await transaction.query<Row>('SELECT import_generation FROM users WHERE id=$1 FOR SHARE', [input.userId]);
      if (!users.rows[0]) throw new NotFoundError('User', input.userId);
      const status = input.awaitingUpload ? 'awaiting_upload' : 'pending_dispatch';
      const inserted = await transaction.query<Row>(
        `INSERT INTO import_jobs
         (user_id,kind,trigger_type,journey_context,status,phase,progress,object_key,original_filename,content_type,content_length,export_provider,import_generation,idempotency_key,expires_at,checkpoint)
         VALUES ($1,$2,$3,$4,$5::VARCHAR(24),$6,0,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $5::VARCHAR(24)='awaiting_upload' THEN NOW()+INTERVAL '1 hour' ELSE NULL END,$14::JSONB)
         RETURNING ${selectColumns}`,
        [input.userId,input.kind,input.trigger,input.journeyContext ?? 'legacy',status,input.awaitingUpload ? 'awaiting_upload' : 'waiting_for_queue',input.objectKey ?? null,input.originalFilename ?? null,input.contentType ?? null,input.contentLength ?? null,input.exportProvider ?? null,Number(users.rows[0].import_generation),input.idempotencyKey ?? null,JSON.stringify(input.initialCheckpoint ?? {})],
      );
      const job = decode(inserted.rows[0]);
      await this.insertEvent(transaction, job, 'accepted');
      // The reviewed first-email UI discloses this choice before import. Older clients omit it.
      // Keep consent and job acceptance atomic; never overwrite a Settings opt-out.
      // The scheduler still requires a completed historical baseline before checking receipts.
      if (input.automaticUpdates && input.trigger === 'user' && (input.journeyContext === 'onboarding' || input.journeyContext === 'post_onboarding') && ['gmail_historical', 'outlook_historical'].includes(input.kind)) {
        await transaction.query(`INSERT INTO user_import_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [input.userId]);
        await transaction.query(
          `UPDATE user_import_preferences SET ongoing_tracking_consent_state='granted',
             ongoing_tracking_consent_version=$2, ongoing_tracking_consented_at=NOW(),
             ongoing_tracking_revoked_at=NULL, tracking_status='setting_up', updated_at=NOW()
           WHERE user_id=$1 AND ongoing_tracking_consent_state='not_offered'`,
          [input.userId, input.journeyContext === 'onboarding' ? 'onboarding-email-updates-v1' : 'post-onboarding-email-updates-v1'],
        );
      }
      if (!input.awaitingUpload) await this.insertOutbox(transaction, job.id, 'dispatch');
      return job;
    });
  }

  async submitUpload(userId: string, jobId: string, input: { contentLength: number; contentType: string | null; etag: string }): Promise<ImportJob> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_jobs SET status='pending_dispatch',phase='waiting_for_queue',progress=0,content_length=$3,
           submitted_content_length=$3,submitted_content_type=$4,object_etag=$5,
           queued_at=NULL,expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND status='awaiting_upload' AND expires_at>NOW()
         RETURNING ${selectColumns}`,
        [jobId,userId,input.contentLength,input.contentType,input.etag],
      );
      if (!result.rows[0]) throw new ConflictError('UPLOAD_NOT_SUBMITTABLE', 'This upload is missing, expired, or was already submitted.');
      await this.insertOutbox(transaction, jobId, 'dispatch');
      const job = decode(result.rows[0]);
      await this.insertEvent(transaction, job, 'upload_submitted');
      return job;
    });
  }

  async findForUser(userId: string, jobId: string): Promise<ImportJob> {
    const result = await this.database.query<Row>(`SELECT ${selectColumns} FROM import_jobs WHERE id=$1 AND user_id=$2`, [jobId,userId]);
    if (!result.rows[0]) throw new NotFoundError('Import operation', jobId);
    return decode(result.rows[0]);
  }

  async findById(jobId: string): Promise<ImportJob | null> {
    const result = await this.database.query<Row>(`SELECT ${selectColumns} FROM import_jobs WHERE id=$1`, [jobId]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async findActive(userId: string): Promise<ImportJob | null> {
    const result = await this.database.query<Row>(
      `SELECT ${selectColumns} FROM import_jobs WHERE user_id=$1
       AND kind<>'export_ready_check'
       AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying') ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async listRecent(userId: string, limit = 10): Promise<ImportJob[]> {
    const result = await this.database.query<Row>(`SELECT ${selectColumns} FROM import_jobs WHERE user_id=$1 AND kind<>'export_ready_check' ORDER BY created_at DESC LIMIT $2`, [userId, Math.max(1, Math.min(limit, 50))]);
    return result.rows.map(decode);
  }

  async markQueued(jobId: string): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(`UPDATE import_jobs SET status='queued',phase='waiting',queued_at=COALESCE(queued_at,NOW()),updated_at=NOW() WHERE id=$1 AND status IN ('pending_dispatch','retrying') RETURNING ${selectColumns}`, [jobId]);
      if (result.rows[0]) await this.insertEvent(transaction, decode(result.rows[0]), 'queued');
    });
  }

  async claimForRun(jobId: string): Promise<ImportJob | null> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_jobs j SET status='running',phase='starting',progress=1,attempts=attempts+1,
           error_code=NULL,error_message=NULL,completed_at=NULL,
           started_at=COALESCE(started_at,NOW()),heartbeat_at=NOW(),updated_at=NOW()
         FROM users u WHERE j.id=$1 AND j.user_id=u.id AND j.import_generation=u.import_generation AND u.deletion_requested_at IS NULL
           AND j.status IN ('pending_dispatch','queued','running','retrying') RETURNING ${selectColumns.split(',').map((c) => `j.${c.trim()}`).join(',')}`,
        [jobId],
      );
      if (result.rows[0]) {
        const job = decode(result.rows[0]);
        await this.insertEvent(transaction, job, 'attempt_started');
        return job;
      }
      const superseded = await transaction.query<Row>(`UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('pending_dispatch','queued','retrying') RETURNING ${selectColumns}`, [jobId]);
      if (superseded.rows[0]) await this.insertEvent(transaction, decode(superseded.rows[0]), 'superseded');
      return null;
    });
  }

  async progress(jobId: string, phase: string, progress: number): Promise<void> {
    await this.database.query(`UPDATE import_jobs SET phase=$2,progress=GREATEST(progress,$3),heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, [jobId,phase,Math.max(1,Math.min(99,Math.round(progress)))]);
  }

  async heartbeat(jobId: string): Promise<void> {
    await this.database.query(
      `UPDATE import_jobs SET heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`,
      [jobId],
    );
  }

  async saveCheckpoint(
    jobId: string,
    checkpoint: Readonly<Record<string, unknown>>,
    phase: string,
    progress: number,
  ): Promise<void> {
    await this.database.query(
      `UPDATE import_jobs SET checkpoint=$2::jsonb,phase=$3,progress=GREATEST(progress,$4),heartbeat_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND status='running'`,
      [jobId, JSON.stringify(checkpoint), phase, Math.max(1, Math.min(94, Math.round(progress)))],
    );
  }

  async succeed(job: ImportJob, result: Readonly<Record<string, unknown>>): Promise<void> {
    await this.finish(job, 'succeeded', 'completed', result, null, null);
  }

  async fail(job: ImportJob, code: string, message: string, details?: Readonly<Record<string, unknown>>): Promise<void> {
    // Preserve committed mailbox work without changing failure/retry semantics.
    const partial = details?.partialResult;
    const result = partial && typeof partial === 'object' && !Array.isArray(partial)
      ? partial as Readonly<Record<string, unknown>> : null;
    await this.finish(job, 'failed', 'failed', result, code, message, details);
  }

  async retry(jobId: string, code: string, message: string, details?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_jobs SET status='retrying',phase='retrying',error_code=$2,error_message=$3,
           heartbeat_at=NULL,updated_at=NOW() WHERE id=$1 AND status='running' RETURNING ${selectColumns}`,
        [jobId,code,message.slice(0,500)],
      );
      if (!result.rows[0]) {
        throw new AppError({
          code: 'IMPORT_RETRY_STATE_CONFLICT',
          message: `Import job ${jobId} could not transition from running to retrying`,
          publicMessage: 'The import retry could not be scheduled safely.',
        });
      }
      await this.insertEvent(transaction, decode(result.rows[0]), 'attempt_failed_retrying', details);
    });
  }

  async delayForInfrastructure(jobId: string, code: string, message: string, details?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_jobs SET status='retrying',phase='waiting_for_infrastructure',
           attempts=GREATEST(0,attempts-1),error_code=$2,error_message=$3,heartbeat_at=NULL,updated_at=NOW()
         WHERE id=$1 AND status='running' RETURNING ${selectColumns}`,
        [jobId, code, message.slice(0, 500)],
      );
      if (result.rows[0]) await this.insertEvent(transaction, decode(result.rows[0]), 'infrastructure_wait', details);
    });
  }

  private async finish(job: ImportJob, status: 'succeeded'|'failed', phase: string, result: Readonly<Record<string, unknown>>|null, code: string|null, message: string|null, details?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      if (job.kind === 'export_ready_check') {
        let detected = false;
        await transaction.query(`UPDATE user_export_provider_preferences p
          SET alert_last_checked_at=CASE WHEN $5='succeeded' THEN NOW() ELSE alert_last_checked_at END,
              alert_last_error_code=$6
          FROM users u
          WHERE p.user_id=$1 AND p.provider=$2 AND p.request_id=$3::uuid
            AND p.alert_consent='granted' AND u.id=p.user_id AND u.import_generation=$4`,
          [job.userId,job.exportProvider,job.checkpoint.requestId,job.importGeneration,status,code]);

        if (status === 'succeeded' && result?.exportReadyDetected === true) {
          const ready = await transaction.query(`UPDATE user_export_provider_preferences p
            SET status='file_ready',ready_source='detected_email',updated_at=NOW(),alert_last_checked_at=NOW(),alert_next_check_at=NULL
            FROM users u, import_jobs j
            WHERE p.user_id=$1 AND p.provider=$2 AND p.request_id=$3::uuid
              AND p.status='requested' AND p.alert_consent='granted'
              AND p.alert_consent_version='export-ready-background-v1'
              AND u.id=p.user_id AND u.import_generation=$4
              AND ((u.gmail_connected=TRUE AND u.gmail_connection_mode='offline' AND u.gmail_refresh_token IS NOT NULL)
                OR EXISTS(SELECT 1 FROM mailbox_connections m WHERE m.user_id=p.user_id AND m.status='connected' AND m.connection_mode='offline'))
              AND j.id=$5 AND j.status='running' AND j.import_generation=u.import_generation
            RETURNING p.request_id`, [job.userId,job.exportProvider,job.checkpoint.requestId,job.importGeneration,job.id]);
          detected = (ready.rowCount ?? 0)>0;
        }
        result = {...result, exportReadyDetected:detected};
      }
      const updated = await transaction.query(
        `UPDATE import_jobs j SET status=$2,phase=$3,progress=100,result=$4,error_code=$5,error_message=$6,
           completed_at=NOW(),heartbeat_at=NOW(),updated_at=NOW()
         FROM users u WHERE j.id=$1 AND j.user_id=u.id AND j.import_generation=u.import_generation AND j.status='running'
         RETURNING ${selectColumns.split(',').map((c) => `j.${c.trim()}`).join(',')}`,
        [job.id,status,phase,result ? JSON.stringify(result) : null,code,message?.slice(0,500) ?? null],
      );
      if (!updated.rows[0]) {
        const superseded = await transaction.query<Row>(`UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running' RETURNING ${selectColumns}`, [job.id]);
        if (superseded.rows[0]) await this.insertEvent(transaction, decode(superseded.rows[0]), 'superseded');
        return;
      }
      await this.insertEvent(transaction, decode(updated.rows[0]), status === 'succeeded' ? 'completed' : 'attempt_failed_terminal', details);
      if (job.trigger === 'user' || importCompletionResult(result).hasChanges || result?.exportReadyDetected === true) {
        await this.insertOutbox(transaction, job.id, 'notify');
      }
    });
  }

  async claimOutbox(limit = 50): Promise<OutboxEvent[]> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `WITH claimed AS (
           SELECT id FROM import_job_outbox WHERE published_at IS NULL AND available_at<=NOW()
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE import_job_outbox o SET attempts=o.attempts+1,available_at=NOW()+INTERVAL '30 seconds'
         FROM claimed WHERE o.id=claimed.id RETURNING o.id,o.job_id,o.event_type,o.payload`,
        [Math.max(1,Math.min(limit,100))],
      );
      return result.rows.map((row) => ({id:number(row,'id'),jobId:text(row,'job_id'),eventType:enumValue(row,'event_type',['dispatch','notify'] as const),payload:jsonObject(row.payload) ?? {}}));
    });
  }

  async markOutboxPublished(id: number): Promise<void> {
    await this.database.query('UPDATE import_job_outbox SET published_at=NOW(),last_error=NULL WHERE id=$1', [id]);
  }

  async markOutboxFailed(id: number, error: string): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_job_outbox SET last_error=$2,available_at=NOW()+(LEAST(attempts,10)*INTERVAL '15 seconds')
         WHERE id=$1 RETURNING job_id,event_type`, [id,error.slice(0,500)],
      );
      const event = result.rows[0];
      if (event && event.event_type === 'dispatch') {
        const waiting = await transaction.query<Row>(
          `UPDATE import_jobs SET phase='waiting_for_queue',updated_at=NOW()
           WHERE id=$1 AND status IN ('pending_dispatch','queued','retrying') RETURNING ${selectColumns}`, [text(event, 'job_id')],
        );
        if (waiting.rows[0]) await this.insertEvent(transaction, decode(waiting.rows[0]), 'queue_publication_failed', { message: error.slice(0, 500) });
      }
    });
  }

  async supersedeActive(userId: string, executor: DatabaseQueryExecutor = this.database): Promise<void> {
    await executor.query(`UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')`, [userId]);
  }

  async expireUploads(): Promise<number> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(`UPDATE import_jobs SET status='expired',phase='expired',completed_at=NOW(),updated_at=NOW() WHERE status='awaiting_upload' AND expires_at<=NOW() RETURNING ${selectColumns}`);
      for (const row of result.rows) await this.insertEvent(transaction, decode(row), 'expired');
      return result.rowCount ?? 0;
    });
  }

  async listObjectCleanupCandidates(limit = 100): Promise<ImportObjectCleanupCandidate[]> {
    const result = await this.database.query<Row>(
      `SELECT id,object_key FROM import_jobs
       WHERE object_key IS NOT NULL
         AND status IN ('succeeded','failed','expired','superseded','cancelled')
         AND updated_at < NOW()-INTERVAL '1 hour'
       ORDER BY updated_at LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))],
    );
    return result.rows.map((row) => ({ jobId: text(row, 'id'), objectKey: text(row, 'object_key') }));
  }

  async markObjectDeleted(jobId: string, objectKey: string): Promise<void> {
    await this.database.query(
      `UPDATE import_jobs SET object_key=NULL,object_etag=NULL,updated_at=NOW()
       WHERE id=$1 AND object_key=$2 AND status IN ('succeeded','failed','expired','superseded','cancelled')`,
      [jobId, objectKey],
    );
  }

  async operationalSnapshot(): Promise<DurableQueueSnapshot> {
    const [statuses, outbox] = await Promise.all([
      this.database.query<Row>(`SELECT status,COUNT(*)::int AS count FROM import_jobs GROUP BY status`),
      this.database.query<Row>(`SELECT COUNT(*)::int AS count,
        EXTRACT(EPOCH FROM (NOW()-MIN(created_at)))::float AS oldest_age_seconds
        FROM import_job_outbox WHERE published_at IS NULL`),
    ]);
    return {
      statuses: Object.fromEntries(statuses.rows.map((row) => [text(row, 'status'), number(row, 'count')])),
      unpublishedOutboxCount: number(outbox.rows[0] ?? { count: 0 }, 'count'),
      oldestUnpublishedOutboxAgeSeconds: outbox.rows[0]?.oldest_age_seconds === null || outbox.rows[0]?.oldest_age_seconds === undefined
        ? null : Math.max(0, number(outbox.rows[0], 'oldest_age_seconds')),
    };
  }

  async getP75DurationSeconds(queue: 'mailbox-imports' | 'export-imports'): Promise<number | null> {
    const result = await this.database.query<Row>(
      `SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (completed_at-started_at))
       ) AS duration_seconds
       FROM (
         SELECT started_at,completed_at FROM import_jobs
         WHERE status='succeeded' AND started_at IS NOT NULL AND completed_at IS NOT NULL
           AND completed_at>=NOW()-INTERVAL '7 days'
           AND CASE WHEN $1::text='export-imports' THEN kind='export_file' ELSE kind<>'export_file' END
         ORDER BY completed_at DESC LIMIT 100
       ) recent`,
      [queue],
    );
    const value = result.rows[0]?.duration_seconds;
    if (value === null || value === undefined) return null;
    return Math.max(1, number(result.rows[0], 'duration_seconds'));
  }

  async cancelPending(input: { actorAdminId: string; reason: string; requestId?: string }): Promise<CancelledImportJob[]> {
    return this.database.withTransaction(async (transaction) => {
      const selected = await transaction.query<Row>(
        `SELECT id,kind FROM import_jobs
         WHERE status IN ('pending_dispatch','queued','retrying') FOR UPDATE`,
      );
      const jobs = selected.rows.map((row) => ({ id: text(row, 'id'), kind: enumValue(row, 'kind', IMPORT_JOB_KINDS) }));
      if (jobs.length > 0) {
        const ids = jobs.map((job) => job.id);
        const cancelled = await transaction.query<Row>(
          `UPDATE import_jobs SET status='cancelled',phase='cancelled',completed_at=NOW(),heartbeat_at=NULL,updated_at=NOW()
           WHERE id=ANY($1::uuid[]) AND status IN ('pending_dispatch','queued','retrying') RETURNING ${selectColumns}`, [ids],
        );
        for (const row of cancelled.rows) await this.insertEvent(transaction, decode(row), 'cancelled_by_admin', { reason: input.reason });
        await transaction.query(
          `UPDATE import_job_outbox SET published_at=COALESCE(published_at,NOW()),last_error='cancelled by administrator'
           WHERE event_type='dispatch' AND job_id=ANY($1::uuid[])`, [ids],
        );
      }
      await transaction.query(
        `INSERT INTO admin_audit_events
         (actor_admin_id,action,target_type,target_id,reason,request_id,outcome,metadata)
         VALUES($1,'cancel_pending_imports','import_queue',NULL,$2,$3,'success',$4::jsonb)`,
        [input.actorAdminId, input.reason, input.requestId ?? null, JSON.stringify({ cancelledCount: jobs.length })],
      );
      return jobs;
    });
  }

  /** Re-publish work whose Redis record was lost or whose worker disappeared. */
  async recoverStaleJobs(staleMinutes = 45): Promise<number> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_jobs SET status='pending_dispatch',phase='recovered',queued_at=NULL,heartbeat_at=NULL,updated_at=NOW()
         WHERE status IN ('queued','running','retrying')
           AND COALESCE(heartbeat_at,queued_at,updated_at) < NOW()-($1::integer*INTERVAL '1 minute')
         RETURNING ${selectColumns}`,
        [Math.max(15, Math.min(staleMinutes, 240))],
      );
      for (const row of result.rows) {
        const job = decode(row);
        await this.insertEvent(transaction, job, 'stale_job_recovered');
        await transaction.query(
          `UPDATE import_job_outbox SET published_at=NULL,available_at=NOW(),last_error='stale job recovery'
           WHERE job_id=$1 AND event_type='dispatch'`,
          [job.id],
        );
      }
      return result.rowCount ?? 0;
    });
  }

  private async insertOutbox(executor: DatabaseQueryExecutor, jobId: string, eventType: 'dispatch'|'notify'): Promise<void> {
    await executor.query(`INSERT INTO import_job_outbox(job_id,event_type) VALUES($1,$2) ON CONFLICT(job_id,event_type) DO NOTHING`, [jobId,eventType]);
  }

  private async insertEvent(
    executor: DatabaseQueryExecutor,
    job: ImportJob,
    eventType: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO import_job_events(job_id,event_type,attempt,status,phase,progress,error_code,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [job.id,eventType,job.attempts,job.status,job.phase,job.progress,job.errorCode,JSON.stringify(safeEventDetails(details))],
    );
  }
}
