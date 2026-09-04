import { ConflictError } from '../../core/errors';
import type { AdConfiguration, AdConfigurationStore, AdConfigurationUpdate } from '../ads/AdConfigurationTypes';
import type { DatabaseQueryExecutor, DatabaseRow, DatabaseTransactionRunner } from '../ports/DatabasePort';

const CONFIG_KEY = 'launch_ads';

const decode = (row: DatabaseRow): AdConfiguration => ({
  enabled: Boolean(row.enabled),
  iosRolloutPercent: Number(row.ios_rollout_percent),
  androidRolloutPercent: Number(row.android_rollout_percent),
  placement: String(row.placement) as AdConfiguration['placement'],
  placements: Array.isArray(row.placements)
    ? row.placements.map(String) as AdConfiguration['placements']
    : ['dashboard_after_insights', 'history_after_fifth_order'],
  maxImpressionsPerSession: Number(row.max_impressions_per_session),
  maxImpressionsPerDay: row.max_impressions_per_day === null || row.max_impressions_per_day === undefined ? 2 : Number(row.max_impressions_per_day),
  minimumReceiptCount: Number(row.minimum_receipt_count),
  version: Number(row.version),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
  updatedBy: row.updated_by
    ? { id: String(row.updated_by), email: String(row.updated_by_email ?? '') }
    : null,
});

const selectConfiguration = async (database: DatabaseQueryExecutor): Promise<AdConfiguration> => {
  const result = await database.query(
    `SELECT config.enabled, config.ios_rollout_percent, config.android_rollout_percent, config.placement,
            config.placements, config.max_impressions_per_session, config.max_impressions_per_day,
            config.minimum_receipt_count, config.version,
            config.updated_at, config.updated_by, administrator.email AS updated_by_email
       FROM ad_runtime_config config
       LEFT JOIN admin_users administrator ON administrator.id = config.updated_by
      WHERE config.config_key = $1`,
    [CONFIG_KEY],
  );
  if (!result.rows[0]) throw new Error('Launch ad configuration is missing');
  return decode(result.rows[0]);
};

export class AdConfigurationRepository implements AdConfigurationStore {
  constructor(private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  get(): Promise<AdConfiguration> {
    return selectConfiguration(this.database);
  }

  update(input: AdConfigurationUpdate): Promise<AdConfiguration> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE ad_runtime_config
            SET enabled = $2, ios_rollout_percent = $3, android_rollout_percent = $4,
                placement = $5, placements = $6::jsonb, max_impressions_per_session = $7,
                max_impressions_per_day = $8, minimum_receipt_count = $9,
                version = version + 1, updated_at = NOW(), updated_by = $10
          WHERE config_key = $1 AND version = $11
          RETURNING version`,
        [CONFIG_KEY, input.enabled, input.iosRolloutPercent, input.androidRolloutPercent,
          input.placement, JSON.stringify(input.placements), input.maxImpressionsPerSession,
          input.maxImpressionsPerDay, input.minimumReceiptCount,
          input.actorAdminId, input.expectedVersion],
      );
      if (!result.rows[0]) {
        throw new ConflictError('AD_CONFIG_VERSION_CONFLICT', 'Advertising settings changed. Reload and try again.');
      }
      const next = await selectConfiguration(transaction);
      await this.appendAudit(transaction, {
        actorAdminId: input.actorAdminId,
        action: 'ads.config_updated',
        reason: input.reason,
        requestId: input.requestId,
        metadata: { version: next.version },
      });
      return next;
    });
  }

  kill(input: { actorAdminId: string; reason: string; requestId?: string }): Promise<AdConfiguration> {
    return this.database.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE ad_runtime_config
            SET enabled = FALSE, version = version + 1, updated_at = NOW(), updated_by = $2
          WHERE config_key = $1
          RETURNING version`,
        [CONFIG_KEY, input.actorAdminId],
      );
      if (!result.rows[0]) throw new Error('Launch ad configuration is missing');
      const next = await selectConfiguration(transaction);
      await this.appendAudit(transaction, {
        actorAdminId: input.actorAdminId,
        action: 'ads.killed',
        reason: input.reason,
        requestId: input.requestId,
        metadata: { version: next.version },
      });
      return next;
    });
  }

  private async appendAudit(
    transaction: DatabaseQueryExecutor,
    input: { actorAdminId: string; action: string; reason: string; requestId?: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO admin_audit_events
       (actor_admin_id, action, target_type, target_id, reason, request_id, outcome, metadata)
       VALUES ($1, $2, 'ad_configuration', $3, $4, $5, 'success', $6::JSONB)`,
      [input.actorAdminId, input.action, CONFIG_KEY, input.reason, input.requestId ?? null,
        JSON.stringify(input.metadata)],
    );
  }
}
