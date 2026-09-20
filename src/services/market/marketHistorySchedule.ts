import { setTimeout as wait } from 'node:timers/promises';

/** Matches the production Railway cron: 08:00 UTC, independent of host timezone. */
export function nextMarketHistoryCheck(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(8, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Compose keeps a process alive; Railway invokes the same job with its cron. */
export async function runMarketHistorySchedule(
  check: () => Promise<void>,
  onFailure: (error: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await check();
    } catch (error) {
      onFailure(error);
    }
    if (signal.aborted) return;
    const now = new Date();
    try {
      await wait(nextMarketHistoryCheck(now).getTime() - now.getTime(), undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
}
