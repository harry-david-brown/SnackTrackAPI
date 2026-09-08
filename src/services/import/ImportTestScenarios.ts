export const GMAIL_LONG_RUNNING_SCENARIO = 'gmail_long_running';
export const GMAIL_LONG_RUNNING_DELAY_MS = 6 * 60 * 1000;
export const SIMULATED_LONG_RUNNING_ERROR_CODE = 'ADMIN_SIMULATED_LONG_RUNNING';

export interface ImportTestScenarios {
  readonly gmailLongRunning: boolean;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}
