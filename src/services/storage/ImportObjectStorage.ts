import { createWriteStream } from 'fs';
import { chmod, mkdtemp, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../../config/AppConfig';
import { AppError } from '../../core/errors';

type StorageConfig = AppConfig['objectStorage'];

const client = (options: StorageConfig, endpoint: string): S3Client =>
  new S3Client({
    region: options.region,
    endpoint,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });

export class ImportObjectStorage {
  private readonly internalClient: S3Client;
  private readonly signingClient: S3Client;

  constructor(private readonly options: StorageConfig) {
    this.internalClient = client(options, options.endpoint);
    this.signingClient = client(options, options.publicEndpoint);
  }

  async createUploadUrl(objectKey: string, contentType: string, contentLength: number): Promise<string> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    return getSignedUrl(
      this.signingClient,
      new PutObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ContentType: contentType, ContentLength: contentLength }),
      { expiresIn: this.options.uploadUrlTtlSeconds },
    );
  }

  uploadUrlExpiresAt(now = Date.now()): string {
    return new Date(now + this.options.uploadUrlTtlSeconds * 1_000).toISOString();
  }

  async head(objectKey: string): Promise<{ contentLength: number; contentType: string | null; etag: string | null }> {
    const result = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
    );
    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? null,
      etag: result.ETag?.trim() || null,
    };
  }

  async downloadToTemporaryFile(
    objectKey: string,
    expected: { contentLength: number; etag: string; maximumBytes: number },
  ): Promise<{ path: string; size: number; remove(): Promise<void> }> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 120_000);
    timeout.unref();
    const directory = await mkdtemp(join(tmpdir(), 'snacktrack-import-'));
    await chmod(directory, 0o700);
    const path = join(directory, 'upload');
    let size = 0;
    try {
      const result = await this.internalClient.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
          IfMatch: expected.etag,
        }),
        { abortSignal: abort.signal },
      );
      if (!result.Body || !('pipe' in result.Body)) throw new AppError({ code: 'UPLOAD_INTEGRITY_FAILED', message: 'Object storage returned no readable body.' });
      if (result.ContentLength !== undefined && result.ContentLength > expected.maximumBytes) {
        throw new AppError({ code: 'UPLOAD_TOO_LARGE', message: 'The uploaded file exceeds the safe size limit.' });
      }
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > expected.maximumBytes || size > expected.contentLength) {
            callback(new AppError({ code: 'UPLOAD_SIZE_MISMATCH', message: 'The uploaded file size changed during download.' }));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        result.Body as NodeJS.ReadableStream,
        limiter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal: abort.signal },
      );
      if (size !== expected.contentLength) throw new AppError({ code: 'UPLOAD_SIZE_MISMATCH', message: 'The uploaded file ended before its submitted size.' });
      return { path, size, remove: async () => void (await rm(directory, { recursive: true, force: true })) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      const statusCode = typeof error === 'object' && error !== null && '$metadata' in error
        ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)
        : 0;
      throw new AppError({
        code: statusCode === 412 ? 'UPLOAD_CHANGED' : 'UPLOAD_INTEGRITY_FAILED',
        message: statusCode === 412 ? 'The uploaded object changed after submission.' : 'The uploaded object could not be verified.',
        publicMessage: statusCode === 412 ? 'The uploaded file changed. Choose the original file again.' : 'The uploaded file could not be verified. Please try again.',
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async delete(objectKey: string): Promise<void> {
    await this.internalClient.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }));
  }

  async cleanupOrphanedTemporaryFiles(maximumAgeMs = 24 * 60 * 60 * 1_000): Promise<number> {
    const root = tmpdir();
    const now = Date.now();
    let removed = 0;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || (!entry.name.startsWith('snacktrack-import-') && !entry.name.startsWith('snacktrack-export-'))) continue;
      const directory = join(root, entry.name);
      const metadata = await stat(directory).catch(() => null);
      if (!metadata || now - metadata.mtimeMs < maximumAgeMs) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  close(): void {
    this.internalClient.destroy();
    this.signingClient.destroy();
  }
}
