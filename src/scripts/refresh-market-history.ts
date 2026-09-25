import { runMarketHistorySchedule } from '../services/market/marketHistorySchedule';
import 'dotenv/config';
import { config } from '../config/AppConfig';
import logger from '../config/logger';
import { PostgresService } from '../services/data/PostgresService';
import { MarketHistoryRepository } from '../services/data/MarketHistoryRepository';
import { FinazonMarketHistory } from '../services/market/FinazonMarketHistory';
import { RefreshMarketHistoryService } from '../services/market/RefreshMarketHistoryService';
async function run(): Promise<void> {
  const settings = config.getMarketHistoryConfig();
  if (!settings.refreshEnabled) {
    logger.info('Market history refresh disabled');
    return;
  }
  const db = new PostgresService({
    connectionString: config.getDatabaseConnectionString(),
    useSsl: config.shouldUseDatabaseSSL(),
    sslCa: config.getDatabaseSslCa(),
    maxConnections: 2,
    minimumConnections: 0,
  });
  try {
    const result = await new RefreshMarketHistoryService(
      new MarketHistoryRepository(db),
      new FinazonMarketHistory(settings.apiKey),
    ).execute();
    logger.info('Market history refresh completed', {
      operation: 'market_history_refresh',
      ...result,
    });
  } finally {
    await db.close();
  }
}
const reportFailure = (error: unknown): void => {
  logger.error('Market history refresh failed', {
    operation: 'market_history_refresh',
    error: error instanceof Error ? error.message : 'Unknown failure',
  });
};

if (process.argv.includes('--watch')) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  logger.info('Market history scheduler started', {
    operation: 'market_history_scheduler',
    schedule: 'startup and daily at 08:00 UTC',
  });
  void runMarketHistorySchedule(run, reportFailure, controller.signal)
    .catch((error) => {
      reportFailure(error);
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    });
} else {
  void run().catch((error) => {
    reportFailure(error);
    process.exitCode = 1;
  });
}
