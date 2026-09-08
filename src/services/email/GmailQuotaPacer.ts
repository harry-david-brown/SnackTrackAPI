const GMAIL_QUOTA_WINDOW_MS = 60_000;

export const GMAIL_MESSAGE_LIST_QUERY_UNITS = 5;
export const GMAIL_MESSAGE_GET_QUERY_UNITS = 20;
export const DEFAULT_GMAIL_IMPORT_QUERY_UNITS_PER_MINUTE = 1_600;

type Clock = () => number;
type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Spaces Gmail requests by query cost so one import cannot exhaust Google's
 * per-user, per-project minute allowance. The reserved headroom covers small
 * requests outside the import worker, such as connection-health checks.
 */
export class GmailQuotaPacer {
  private nextRequestAt: number | null = null;

  constructor(
    private readonly queryUnitsPerMinute = DEFAULT_GMAIL_IMPORT_QUERY_UNITS_PER_MINUTE,
    private readonly clock: Clock = Date.now,
    private readonly sleep: Sleep = defaultSleep,
  ) {
    if (!Number.isFinite(queryUnitsPerMinute) || queryUnitsPerMinute <= 0) {
      throw new Error('Gmail query-unit budget must be positive');
    }
  }

  async waitFor(queryUnits: number): Promise<void> {
    if (!Number.isFinite(queryUnits) || queryUnits <= 0) {
      throw new Error('Gmail request query cost must be positive');
    }

    const now = this.clock();
    const requestAt = Math.max(now, this.nextRequestAt ?? now);
    const spacingMs = Math.ceil(
      (queryUnits * GMAIL_QUOTA_WINDOW_MS) / this.queryUnitsPerMinute,
    );
    this.nextRequestAt = requestAt + spacingMs;

    const delayMs = requestAt - now;
    if (delayMs > 0) await this.sleep(delayMs);
  }
}
