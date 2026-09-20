import 'dotenv/config';
import winston from 'winston';
import { config } from '../config/AppConfig';
import { redisConfig } from '../config/redis';
import logger from '../config/logger';
import { AppError } from '../core/errors';
import { PostgresService } from '../services/data/PostgresService';
import { ReceiptRepository } from '../services/data/ReceiptRepository';
import { ReceiptRepairAccountRepository } from '../services/data/ReceiptRepairAccountRepository';
import { CsvImportService } from '../services/import/CsvImportService';
import { ZipExtractor } from '../services/import/ZipExtractor';
import { RetainedExportReader } from '../services/import/RetainedExportReader';
import { ImportLockService } from '../services/import/ImportLockService';
import { ReceiptRepairSourceAcquisition, type ReceiptRepairSourceCommand } from '../services/receipt/ReceiptRepairSourceAcquisition';
import { RetainedEmailReader } from '../services/import/RetainedEmailReader';
import { ReceiptEmailBatchExtractor } from '../services/import/ReceiptEmailBatchExtractor';
import { ReceiptExtractor } from '../services/extraction/ReceiptExtractor';

/** Standalone operator entry point. Preview is read-only; --stage never publishes a repair. */
async function main(commandFactory: () => ReceiptRepairSourceCommand) {
  const command = commandFactory();
  // Keep stdout machine-readable even when normal infrastructure logging is enabled.
  for (const transport of [...logger.transports])
    if (transport instanceof winston.transports.Console) logger.remove(transport);
  logger.add(new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'debug'] }));
  const db = new PostgresService({
    connectionString: config.getDatabaseConnectionString(),
    useSsl: config.shouldUseDatabaseSSL(),
    maxConnections: 2,
    minimumConnections: 0,
  });
  const locks = {
    acquireLock: async (userId: string) => {
      if (!redisConfig.isEnabled())
        throw new AppError({
          code: 'REPAIR_DISTRIBUTED_LOCK_REQUIRED',
          message: 'Staging requires the configured shared Redis writer lock',
        });
      await redisConfig.initialize();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          redisConfig.waitUntilReady(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new AppError({
                    code: 'LOCK_BACKEND_UNAVAILABLE',
                    message: 'The shared writer lock is unavailable; no evidence was staged',
                  }),
                ),
              10000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return ImportLockService.acquireLock(userId);
    },
    assertLockOwned: ImportLockService.assertLockOwned.bind(ImportLockService),
    releaseLock: ImportLockService.releaseLock.bind(ImportLockService),
  };
  try {
    const service = new ReceiptRepairSourceAcquisition(
      new ReceiptRepairAccountRepository(db),
      command.sourceKind === 'provider_export'
        ? new RetainedExportReader(new CsvImportService(), new ZipExtractor())
        : new RetainedEmailReader(new ReceiptEmailBatchExtractor(new ReceiptExtractor({},3), {capture:async()=>{}}, 2, Date.now, 3)),
      new ReceiptRepository(db, 3),
      locks,
    );
    const result = await service.execute(command);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    try {
      await db.close();
    } finally {
      await redisConfig.close();
    }
  }
}

export async function runReceiptRepairAcquisition(commandFactory: () => ReceiptRepairSourceCommand): Promise<void> {
  await main(commandFactory).catch((error: unknown) => {
  // Avoid exposing file paths, SQL, environment values or provider payloads in operator errors.
  process.stderr.write(
    JSON.stringify(
      error instanceof AppError
        ? { code: error.code, message: error.publicMessage ?? error.message }
        : {
            code: 'REPAIR_ACQUISITION_FAILED',
            message:
              'Could not preview or stage retained evidence. Check the command arguments, file access and local service configuration.',
          },
    ) + '\n',
  );
  process.exitCode = 1;
  });
}
