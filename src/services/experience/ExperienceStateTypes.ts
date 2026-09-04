export const FIRST_RECAP_VERSION = 'lifetime-v1' as const;
export const FIRST_RECAP_MINIMUM_ORDERS = 3 as const;

export type SetupCompletionMethod =
  | 'email_receipts'
  | 'provider_history_request'
  | 'provider_archive';

export interface ExperienceState {
  readonly setup: {
    readonly state: 'required' | 'importing' | 'complete';
    readonly completedAt: string | null;
    readonly completionMethod: SetupCompletionMethod | null;
    readonly activeOperationId: string | null;
  };
  readonly firstRecap: {
    readonly state: 'ineligible' | 'ready' | 'seen';
    readonly minimumOrderCount: typeof FIRST_RECAP_MINIMUM_ORDERS;
    readonly version: typeof FIRST_RECAP_VERSION;
    readonly seenAt: string | null;
  };
  readonly receiptCount: number;
}
