import { randomUUID } from 'crypto';
import { AppError, ValidationError } from '../../core/errors';
import type { ImportJobRepository } from '../data/ImportJobRepository';
import type { ImportObjectStorage } from '../storage/ImportObjectStorage';
import type { ImportJob, ImportJobKind, ImportJobTrigger, ImportJourneyContext } from './ImportJobTypes';
import type { ExportProvider } from './ImportJobTypes';

const CSV_LIMIT = 10 * 1024 * 1024;
const ZIP_LIMIT = 50 * 1024 * 1024;
const supportedContentTypes = new Set([
  'text/csv',
  'application/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);
const zipContentTypes = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
const csvContentTypes = new Set(['text/csv', 'application/csv', 'application/octet-stream']);

const cleanFilename = (filename: string): string => {
  const value = filename.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!value || (!value.toLowerCase().endsWith('.csv') && !value.toLowerCase().endsWith('.zip'))) {
    throw new ValidationError('Only CSV and ZIP exports are supported.', 'filename');
  }
  return value;
};

export class ImportJobService {
  constructor(
    private readonly jobs: ImportJobRepository,
    private readonly storage: ImportObjectStorage,
  ) {}

  start(userId: string, kind: Exclude<ImportJobKind, 'export_file'>, trigger: ImportJobTrigger, idempotencyKey?: string, journeyContext: ImportJourneyContext = 'legacy', automaticUpdates = false): Promise<ImportJob> {
    if (automaticUpdates && (!['onboarding', 'post_onboarding'].includes(journeyContext) || trigger !== 'user' || !['gmail_historical', 'outlook_historical'].includes(kind))) {
      throw new ValidationError('Automatic updates can only be included in a reviewed email import.', 'automaticUpdates');
    }
    return this.jobs.create({ userId, kind, trigger, idempotencyKey, journeyContext, automaticUpdates });
  }

  createUberEatsUploadIntent(input: Omit<UploadIntentInput, 'provider'>) {
    return this.createUploadIntent({ ...input, provider: 'uber_eats' });
  }

  createDoorDashUploadIntent(input: Omit<UploadIntentInput, 'provider'>) {
    return this.createUploadIntent({ ...input, provider: 'doordash' });
  }

  private async createUploadIntent(input: UploadIntentInput): Promise<{ operation: ImportJob; uploadUrl: string; headers: Readonly<Record<string,string>>; expiresAt: string }> {
    const filename = cleanFilename(input.filename);
    const contentType = input.contentType.toLowerCase().split(';', 1)[0].trim();
    if (!supportedContentTypes.has(contentType)) throw new ValidationError('Unsupported upload content type.', 'contentType');
    const isZip = filename.toLowerCase().endsWith('.zip');
    if (!(isZip ? zipContentTypes : csvContentTypes).has(contentType)) {
      throw new ValidationError(`The content type does not match the ${isZip ? 'ZIP' : 'CSV'} filename.`, 'contentType');
    }
    const maximum = isZip ? ZIP_LIMIT : CSV_LIMIT;
    if (!Number.isInteger(input.contentLength) || input.contentLength <= 0) {
      throw new ValidationError('Content length must be a positive integer.', 'contentLength');
    }
    if (input.contentLength > maximum) {
      throw new AppError({ code: 'PAYLOAD_TOO_LARGE', message: `The selected ${isZip ? 'ZIP' : 'CSV'} exceeds the ${maximum / 1024 / 1024} MB limit.` });
    }
    const objectKey = `imports/${input.userId}/${randomUUID()}/${filename}`;
    const operation = await this.jobs.create({
      userId: input.userId,
      kind: 'export_file',
      trigger: 'user',
      journeyContext: input.journeyContext,
      idempotencyKey: input.idempotencyKey,
      awaitingUpload: true,
      objectKey,
      originalFilename: filename,
      contentType,
      contentLength: input.contentLength,
      exportProvider: input.provider,
    });
    if (
      operation.exportProvider !== input.provider ||
      operation.originalFilename !== filename ||
      operation.contentType !== contentType ||
      operation.contentLength !== input.contentLength
    ) {
      throw new AppError({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'The idempotency key was already used for a different upload.',
        publicMessage: 'Please choose the file again and retry the upload.',
      });
    }
    if (!operation.objectKey || !operation.contentType) throw new Error('Upload operation metadata was not persisted');
    if (!operation.contentLength) throw new Error('Upload operation content length was not persisted');
    const uploadUrl = await this.storage.createUploadUrl(operation.objectKey, operation.contentType, operation.contentLength);
    return {
      operation,
      uploadUrl,
      headers: { 'Content-Type': operation.contentType, 'Content-Length': String(operation.contentLength) },
      expiresAt: this.storage.uploadUrlExpiresAt(),
    };
  }

  async refreshUploadUrl(userId: string, jobId: string): Promise<{ operation: ImportJob; uploadUrl: string; headers: Readonly<Record<string,string>>; expiresAt: string }> {
    const job = await this.jobs.findForUser(userId, jobId);
    if (job.status !== 'awaiting_upload' || !job.objectKey || !job.contentType || !job.contentLength || !job.expiresAt || new Date(job.expiresAt).getTime() <= Date.now()) {
      throw new AppError({ code: 'UPLOAD_NOT_SUBMITTABLE', message: 'This import is no longer waiting for an upload.' });
    }
    return {
      operation: job,
      uploadUrl: await this.storage.createUploadUrl(job.objectKey, job.contentType, job.contentLength),
      headers: { 'Content-Type': job.contentType, 'Content-Length': String(job.contentLength) },
      expiresAt: this.storage.uploadUrlExpiresAt(),
    };
  }

  async submitUpload(userId: string, jobId: string): Promise<ImportJob> {
    const job = await this.jobs.findForUser(userId, jobId);
    if (!job.objectKey || !job.originalFilename) throw new ValidationError('Upload metadata is missing.');
    const stored = await this.storage.head(job.objectKey).catch((cause) => {
      throw new AppError({ code: 'UPLOAD_NOT_FOUND', message: 'The uploaded file could not be found.', cause });
    });
    const maximum = job.originalFilename.toLowerCase().endsWith('.zip') ? ZIP_LIMIT : CSV_LIMIT;
    if (stored.contentLength <= 0 || stored.contentLength > maximum || (job.contentLength && stored.contentLength !== job.contentLength)) {
      throw new ValidationError('The uploaded file size does not match the upload request.', 'contentLength');
    }
    if (!job.exportProvider) {
      throw new AppError({ code: 'UPLOAD_PROVIDER_REQUIRED', message: 'The upload provider is missing.' });
    }
    if (!stored.etag) {
      throw new AppError({ code: 'UPLOAD_INTEGRITY_FAILED', message: 'Object storage did not provide an integrity identifier.' });
    }
    if (stored.contentType && job.contentType && stored.contentType !== job.contentType) {
      throw new AppError({ code: 'UNSUPPORTED_UPLOAD_TYPE', message: 'The stored content type does not match the upload request.' });
    }
    return this.jobs.submitUpload(userId, jobId, {
      contentLength: stored.contentLength,
      contentType: stored.contentType,
      etag: stored.etag,
    });
  }
}

interface UploadIntentInput {
  readonly userId: string;
  readonly provider: ExportProvider;
  readonly journeyContext: ImportJourneyContext;
  readonly filename: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly idempotencyKey?: string;
}
