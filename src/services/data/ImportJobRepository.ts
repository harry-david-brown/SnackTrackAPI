import { ConflictError, NotFoundError } from '../../core/errors';
import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';
import {
  IMPORT_JOB_KINDS,
  IMPORT_JOB_STATUSES,
  EXPORT_PROVIDERS,
  type ExportProvider,
  type ImportJob,
  type ImportJobKind,
  type ImportJobStatus,
  type ImportJobTrigger,
} from '../import/ImportJobTypes';

type Row = Record<string, unknown>;
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

const selectColumns = `id,user_id,kind,trigger_type,status,phase,progress,result,error_code,
  error_message,attempts,heartbeat_at,object_key,original_filename,content_type,content_length,
  export_provider,object_etag,submitted_content_type,submitted_content_length,
  import_generation,checkpoint,created_at,queued_at,started_at,completed_at,expires_at,updated_at`;

const decode = (row: Row): ImportJob => ({
  id: text(row, 'id'),
  userId: text(row, 'user_id'),
  kind: enumValue(row, 'kind', IMPORT_JOB_KINDS),
  trigger: enumValue(row, 'trigger_type', ['user', 'scheduler'] as const),
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
  readonly idempotencyKey?: string;
  readonly awaitingUpload?: boolean;
  readonly objectKey?: string;
  readonly originalFilename?: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly exportProvider?: ExportProvider;
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

export class ImportJobRepository {
  constructor(
    private readonly database: DatabaseTransactionRunner & DatabaseQueryExecutor,
    private readonly maximumActiveJobs = 1000,
  ) {}

  async create(input: CreateImportJobInput): Promise<ImportJob> {
    return this.database.withTransaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
      if (input.idempotencyKey) {
        const existing = await transaction.query<Row>(
          `SELECT ${selectColumns} FROM import_jobs WHERE user_id=$1 AND idempotency_key=$2`,
          [input.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const job = decode(existing.rows[0]);
          if (job.kind !== input.kind) {
            throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for another import type.');
          }
          return job;
        }
      }
      const active = await transaction.query<Row>(
        `SELECT ${selectColumns} FROM import_jobs WHERE user_id=$1
         AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')
         ORDER BY created_at DESC LIMIT 1`,
        [input.userId],
      );
      if (active.rows[0]) {
        const activeJob = decode(active.rows[0]);
        if (input.awaitingUpload && activeJob.status === 'awaiting_upload') {
          await transaction.query(
            `UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW()
             WHERE id=$1 AND status='awaiting_upload'`,
            [activeJob.id],
          );
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
      if (input.trigger === 'user') {
        const limits = await transaction.query<Row>(
          `SELECT
             COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '15 minutes') AS recent,
             COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '1 day') AS daily,
             COUNT(*) FILTER (WHERE kind='export_file' AND created_at >= NOW()-INTERVAL '1 hour') AS uploads
           FROM import_jobs WHERE user_id=$1 AND trigger_type='user'`,
          [input.userId],
        );
        const row = limits.rows[0] ?? {};
        if (Number(row.recent) >= 3 || Number(row.daily) >= 10 || (input.awaitingUpload && Number(row.uploads) >= 3)) {
          throw new ConflictError('IMPORT_RATE_LIMITED', 'Too many imports were started recently. Please try again later.');
        }
      }
      const users = await transaction.query<Row>('SELECT import_generation FROM users WHERE id=$1 FOR SHARE', [input.userId]);
      if (!users.rows[0]) throw new NotFoundError('User', input.userId);
      const status = input.awaitingUpload ? 'awaiting_upload' : 'pending_dispatch';
      const inserted = await transaction.query<Row>(
        `INSERT INTO import_jobs
         (user_id,kind,trigger_type,status,phase,progress,object_key,original_filename,content_type,content_length,export_provider,import_generation,idempotency_key,expires_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $4='awaiting_upload' THEN NOW()+INTERVAL '1 hour' ELSE NULL END)
         RETURNING ${selectColumns}`,
        [input.userId,input.kind,input.trigger,status,input.awaitingUpload ? 'awaiting_upload' : 'waiting',input.objectKey ?? null,input.originalFilename ?? null,input.contentType ?? null,input.contentLength ?? null,input.exportProvider ?? null,Number(users.rows[0].import_generation),input.idempotencyKey ?? null],
      );
      const job = decode(inserted.rows[0]);
      if (!input.awaitingUpload) await this.insertOutbox(transaction, job.id, 'dispatch');
      return job;
    });
  }

  async submitUpload(userId: string, jobId: string, input: { contentLength: number; contentType: string | null; etag: string }): Promise<ImportJob> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_jobs SET status='pending_dispatch',phase='waiting',progress=0,content_length=$3,
           submitted_content_length=$3,submitted_content_type=$4,object_etag=$5,
           queued_at=NULL,expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND status='awaiting_upload' AND expires_at>NOW()
         RETURNING ${selectColumns}`,
        [jobId,userId,input.contentLength,input.contentType,input.etag],
      );
      if (!result.rows[0]) throw new ConflictError('UPLOAD_NOT_SUBMITTABLE', 'This upload is missing, expired, or was already submitted.');
      await this.insertOutbox(transaction, jobId, 'dispatch');
      return decode(result.rows[0]);
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
       AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying') ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async listRecent(userId: string, limit = 10): Promise<ImportJob[]> {
    const result = await this.database.query<Row>(`SELECT ${selectColumns} FROM import_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, Math.max(1, Math.min(limit, 50))]);
    return result.rows.map(decode);
  }

  async markQueued(jobId: string): Promise<void> {
    await this.database.query(`UPDATE import_jobs SET status='queued',phase='waiting',queued_at=COALESCE(queued_at,NOW()),updated_at=NOW() WHERE id=$1 AND status IN ('pending_dispatch','retrying')`, [jobId]);
  }

  async claimForRun(jobId: string): Promise<ImportJob | null> {
    const result = await this.database.query<Row>(
      `UPDATE import_jobs j SET status='running',phase='starting',progress=1,attempts=attempts+1,
         started_at=COALESCE(started_at,NOW()),heartbeat_at=NOW(),updated_at=NOW()
       FROM users u WHERE j.id=$1 AND j.user_id=u.id AND j.import_generation=u.import_generation
         AND j.status IN ('pending_dispatch','queued','running','retrying') RETURNING ${selectColumns.split(',').map((c) => `j.${c.trim()}`).join(',')}`,
      [jobId],
    );
    if (result.rows[0]) return decode(result.rows[0]);
    await this.database.query(`UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('pending_dispatch','queued','retrying')`, [jobId]);
    return null;
  }

  async progress(jobId: string, phase: string, progress: number): Promise<void> {
    await this.database.query(`UPDATE import_jobs SET phase=$2,progress=$3,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, [jobId,phase,Math.max(1,Math.min(99,Math.round(progress)))]);
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
      `UPDATE import_jobs SET checkpoint=$2::jsonb,phase=$3,progress=$4,heartbeat_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND status='running'`,
      [jobId, JSON.stringify(checkpoint), phase, Math.max(1, Math.min(94, Math.round(progress)))],
    );
  }

  async succeed(job: ImportJob, result: Readonly<Record<string, unknown>>): Promise<void> {
    await this.finish(job, 'succeeded', 'completed', result, null, null);
  }

  async fail(job: ImportJob, code: string, message: string): Promise<void> {
    await this.finish(job, 'failed', 'failed', null, code, message);
  }

  async retry(jobId: string, code: string, message: string): Promise<void> {
    await this.database.query(`UPDATE import_jobs SET status='retrying',phase='retrying',error_code=$2,error_message=$3,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, [jobId,code,message.slice(0,500)]);
  }

  private async finish(job: ImportJob, status: 'succeeded'|'failed', phase: string, result: Readonly<Record<string, unknown>>|null, code: string|null, message: string|null): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE import_jobs j SET status=$2,phase=$3,progress=100,result=$4,error_code=$5,error_message=$6,
           completed_at=NOW(),heartbeat_at=NOW(),updated_at=NOW()
         FROM users u WHERE j.id=$1 AND j.user_id=u.id AND j.import_generation=u.import_generation AND j.status='running'`,
        [job.id,status,phase,result ? JSON.stringify(result) : null,code,message?.slice(0,500) ?? null],
      );
      if (!updated.rowCount) {
        await transaction.query(`UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, [job.id]);
        return;
      }
      const changes = Number(result?.newOrders ?? 0)
        + Number(result?.updatedOrders ?? 0)
        + Number(result?.importedCount ?? 0);
      if (job.trigger === 'user' || changes > 0) await this.insertOutbox(transaction, job.id, 'notify');
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
    await this.database.query(`UPDATE import_job_outbox SET last_error=$2,available_at=NOW()+(LEAST(attempts,10)*INTERVAL '15 seconds') WHERE id=$1`, [id,error.slice(0,500)]);
  }

  async supersedeActive(userId: string, executor: DatabaseQueryExecutor = this.database): Promise<void> {
    await executor.query(`UPDATE import_jobs SET status='superseded',phase='superseded',completed_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND status IN ('awaiting_upload','pending_dispatch','queued','running','retrying')`, [userId]);
  }

  async expireUploads(): Promise<number> {
    const result = await this.database.query(`UPDATE import_jobs SET status='expired',phase='expired',completed_at=NOW(),updated_at=NOW() WHERE status='awaiting_upload' AND expires_at<=NOW()`);
    return result.rowCount ?? 0;
  }

  async listObjectCleanupCandidates(limit = 100): Promise<ImportObjectCleanupCandidate[]> {
    const result = await this.database.query<Row>(
      `SELECT id,object_key FROM import_jobs
       WHERE object_key IS NOT NULL
         AND status IN ('succeeded','failed','expired','superseded')
         AND updated_at < NOW()-INTERVAL '1 hour'
       ORDER BY updated_at LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))],
    );
    return result.rows.map((row) => ({ jobId: text(row, 'id'), objectKey: text(row, 'object_key') }));
  }

  async markObjectDeleted(jobId: string, objectKey: string): Promise<void> {
    await this.database.query(
      `UPDATE import_jobs SET object_key=NULL,object_etag=NULL,updated_at=NOW()
       WHERE id=$1 AND object_key=$2 AND status IN ('succeeded','failed','expired','superseded')`,
      [jobId, objectKey],
    );
  }

  /** Re-publish work whose Redis record was lost or whose worker disappeared. */
  async recoverStaleJobs(staleMinutes = 45): Promise<number> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `UPDATE import_jobs SET status='pending_dispatch',phase='recovered',queued_at=NULL,heartbeat_at=NULL,updated_at=NOW()
         WHERE status IN ('queued','running','retrying')
           AND COALESCE(heartbeat_at,queued_at,updated_at) < NOW()-($1::integer*INTERVAL '1 minute')
         RETURNING id`,
        [Math.max(15, Math.min(staleMinutes, 240))],
      );
      for (const row of result.rows) {
        await transaction.query(
          `UPDATE import_job_outbox SET published_at=NULL,available_at=NOW(),last_error='stale job recovery'
           WHERE job_id=$1 AND event_type='dispatch'`,
          [text(row, 'id')],
        );
      }
      return result.rowCount ?? 0;
    });
  }

  private async insertOutbox(executor: DatabaseQueryExecutor, jobId: string, eventType: 'dispatch'|'notify'): Promise<void> {
    await executor.query(`INSERT INTO import_job_outbox(job_id,event_type) VALUES($1,$2) ON CONFLICT(job_id,event_type) DO NOTHING`, [jobId,eventType]);
  }
}
