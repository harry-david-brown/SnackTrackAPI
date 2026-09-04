export const AD_PLACEMENTS = ['dashboard_after_insights', 'dashboard_footer'] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];
export const AD_PLACEMENTS_V2 = ['dashboard_after_insights', 'history_after_fifth_order'] as const;
export type AdPlacementV2 = (typeof AD_PLACEMENTS_V2)[number];
export type AdPlatform = 'ios' | 'android';

export interface AdConfiguration {
  readonly enabled: boolean;
  readonly iosRolloutPercent: number;
  readonly androidRolloutPercent: number;
  readonly placement: AdPlacement;
  readonly placements: readonly AdPlacementV2[];
  readonly maxImpressionsPerSession: number;
  readonly maxImpressionsPerDay: number;
  readonly minimumReceiptCount: number;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: { readonly id: string; readonly email: string } | null;
}

export interface AdConfigurationUpdate {
  readonly enabled: boolean;
  readonly iosRolloutPercent: number;
  readonly androidRolloutPercent: number;
  readonly placement: AdPlacement;
  readonly placements: readonly AdPlacementV2[];
  readonly maxImpressionsPerSession: number;
  readonly maxImpressionsPerDay: number;
  readonly minimumReceiptCount: number;
  readonly expectedVersion: number;
  readonly actorAdminId: string;
  readonly reason: string;
  readonly requestId?: string;
}

export interface AdConfigurationStore {
  get(): Promise<AdConfiguration>;
  update(input: AdConfigurationUpdate): Promise<AdConfiguration>;
  kill(input: { actorAdminId: string; reason: string; requestId?: string }): Promise<AdConfiguration>;
}
