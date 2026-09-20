/** Development startup convenience; production refresh remains scheduler-owned. */
export async function startDevMarketHistoryCheck(
  development: boolean,
  refreshEnabled: boolean,
  check: () => Promise<unknown>,
  log: (message: string, metadata?: Record<string, unknown>) => void,
  reportFailure: (error: unknown) => void,
): Promise<void> {
  if (!development) return;
  if (!refreshEnabled) {
    log('Market history startup check disabled');
    return;
  }
  log('Market history startup check started');
  try {
    const result = await check();
    log('Market history startup check completed', { result });
  } catch (error) {
    reportFailure(error);
  }
}
