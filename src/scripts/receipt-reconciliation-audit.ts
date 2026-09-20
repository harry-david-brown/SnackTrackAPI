import 'dotenv/config';
import { config } from '../config/AppConfig';
import { PostgresService } from '../services/data/PostgresService';
import { ReceiptReconciliationStore } from '../services/data/ReceiptReconciliationStore';
import { buildReceiptReconciliationAudit } from '../services/receipt/ReceiptReconciliationAudit';
import { parseReceiptAuditOptions } from './receiptReconciliationAuditOptions';

async function main() {
  const options = parseReceiptAuditOptions(process.argv.slice(2));
  const db = new PostgresService({
    connectionString: config.getDatabaseConnectionString(),
    useSsl: config.shouldUseDatabaseSSL(),
    maxConnections: 1,
    minimumConnections: 0,
  });
  try {
    const report = await db.withTransaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const store = new ReceiptReconciliationStore(async () => {
        throw new Error('Audit cannot write');
      }, options.policyVersion);
      const preview = options.manifestId
        ? await store.inspectManifest(tx, options.userId, options.manifestId)
        : await store.preview(tx, options.userId, options.stagedBatchIds);
      return {
        userId: options.userId,
        context: preview.context,
        ...buildReceiptReconciliationAudit(
          preview.before,
          preview.after,
          preview.stagedBatches,
          options.details,
          options.manifestId ? 'manifest' : 'preview',
        ),
      };
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await db.close();
  }
}
void main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : 'Audit failed'}\n`);
  process.exitCode = 1;
});
