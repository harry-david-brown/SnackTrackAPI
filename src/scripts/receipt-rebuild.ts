import 'dotenv/config';
import { open } from 'fs/promises';
import { config } from '../config/AppConfig';
import { PostgresService } from '../services/data/PostgresService';
import { ImportJobRepository } from '../services/data/ImportJobRepository';
import { decodeReceiptReviewChanges } from '../services/receipt/ReceiptReviewDecisions';
import { receiptRebuildOptions } from './receiptRebuildOptions';

/** Explicit operator action only: writes a durable job, never runs at deployment/startup. */
async function main(): Promise<void> {
  const { mode, userId, idempotencyKey, manifestId, stagedBatchIds, reviewFile } =
    receiptRebuildOptions(process.argv.slice(2));
  let reviewChanges = decodeReceiptReviewChanges([]);
  if (reviewFile) {
    const file = await open(reviewFile, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 512_000)
        throw new Error('Review input must be a JSON file of at most 512 KB');
      const buffer = Buffer.alloc(512_001);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 512_000) throw new Error('Review input exceeds 512 KB');
      let decoded: unknown;
      try {
        decoded = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } catch {
        throw new Error('Review input is not valid JSON');
      }
      reviewChanges = decodeReceiptReviewChanges(decoded);
    } finally {
      await file.close();
    }
  }
  const db = new PostgresService({
    connectionString: config.getDatabaseConnectionString(),
    useSsl: config.shouldUseDatabaseSSL(),
    maxConnections: 2,
    minimumConnections: 0,
  });
  try {
    const kind =
      mode === 'prepare'
        ? 'receipt_rebuild'
        : mode === 'publish'
          ? 'receipt_publish'
          : 'receipt_rollback';
    const job = await new ImportJobRepository(db).create({
      userId,
      kind,
      trigger: 'scheduler',
      journeyContext: 'routine',
      idempotencyKey,
      initialCheckpoint: manifestId
        ? { manifestId }
        : { stagedBatchIds, ...(reviewChanges.length ? { reviewChanges } : {}) },
    });
    process.stdout.write(JSON.stringify({ jobId: job.id, status: job.status, mode }) + '\n');
  } finally {
    await db.close();
  }
}
void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Rebuild enqueue failed'}\n`);
  process.exitCode = 1;
});
