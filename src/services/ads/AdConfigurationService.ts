import { createHash } from 'crypto';
import { ValidationError } from '../../core/errors';
import {
  AD_PLACEMENTS,
  AD_PLACEMENTS_V2,
  type AdConfiguration,
  type AdConfigurationStore,
  type AdConfigurationUpdate,
  type AdPlatform,
} from './AdConfigurationTypes';

const boundedInteger = (value: number, field: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError(`Must be an integer between ${minimum} and ${maximum}`, field);
  }
  return value;
};

const reason = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length < 10 || normalized.length > 500) {
    throw new ValidationError('Must be 10–500 characters', 'reason');
  }
  return normalized;
};

export class AdConfigurationService {
  constructor(private readonly store: AdConfigurationStore) {}

  get(): Promise<AdConfiguration> {
    return this.store.get();
  }

  async runtime(userId: string, platform: AdPlatform) {
    const configuration = await this.store.get();
    const rolloutPercent = platform === 'ios'
      ? configuration.iosRolloutPercent
      : configuration.androidRolloutPercent;
    const digest = createHash('sha256').update(`launch_ads:${userId}:${platform}`).digest();
    const rolloutBucket = digest.readUInt32BE(0) % 100;
    return {
      enabled: configuration.enabled && rolloutBucket < rolloutPercent,
      placement: configuration.placement,
      placements: configuration.placements ?? ['dashboard_after_insights'],
      selectionStrategy: 'first_eligible' as const,
      maxImpressionsPerSession: configuration.maxImpressionsPerSession,
      maxImpressionsPerDay: configuration.maxImpressionsPerDay ?? 2,
      minimumReceiptCount: configuration.minimumReceiptCount,
      configurationVersion: configuration.version,
      refreshAfterSeconds: 60,
    };
  }

  update(input: AdConfigurationUpdate): Promise<AdConfiguration> {
    if (!AD_PLACEMENTS.includes(input.placement)) throw new ValidationError('Invalid placement', 'placement');
    const placements = input.placements ?? ['dashboard_after_insights'];
    if (
      placements.length === 0 ||
      new Set(placements).size !== placements.length ||
      placements.some((placement) => !AD_PLACEMENTS_V2.includes(placement))
    ) throw new ValidationError('Invalid placements', 'placements');
    return this.store.update({
      ...input,
      placements,
      iosRolloutPercent: boundedInteger(input.iosRolloutPercent, 'iosRolloutPercent', 0, 100),
      androidRolloutPercent: boundedInteger(input.androidRolloutPercent, 'androidRolloutPercent', 0, 100),
      maxImpressionsPerSession: boundedInteger(input.maxImpressionsPerSession, 'maxImpressionsPerSession', 1, 3),
      maxImpressionsPerDay: boundedInteger(input.maxImpressionsPerDay ?? 2, 'maxImpressionsPerDay', 1, 10),
      minimumReceiptCount: boundedInteger(input.minimumReceiptCount, 'minimumReceiptCount', 1, 100),
      expectedVersion: boundedInteger(input.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER),
      reason: reason(input.reason),
    });
  }

  kill(input: { actorAdminId: string; reason: string; requestId?: string }): Promise<AdConfiguration> {
    return this.store.kill({ ...input, reason: reason(input.reason) });
  }
}
