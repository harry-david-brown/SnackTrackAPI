import type { DatabaseQueryExecutor, DatabaseTransactionRunner } from '../ports/DatabasePort';

export interface PushDevice {
  readonly id: string;
  readonly token: string;
  readonly platform: 'ios'|'android';
}
export interface PendingPushReceipt { readonly deliveryId: string; readonly deviceId: string; readonly ticketId: string }

export class PushDeviceRepository {
  constructor(private readonly database: DatabaseQueryExecutor & DatabaseTransactionRunner) {}

  async upsert(userId: string, installationId: string, token: string, platform: 'ios'|'android'): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      // Expo tokens identify an app installation and can move when a shared
      // device signs into another SnackTrack account. Preserve delivery rows
      // while releasing the unique live token from the prior owner.
      await transaction.query(
        `UPDATE push_devices SET expo_push_token='disabled:'||id::text,enabled=FALSE,disabled_at=NOW(),updated_at=NOW()
         WHERE expo_push_token=$3 AND (user_id<>$1 OR installation_id<>$2)`,
        [userId,installationId,token],
      );
      await transaction.query(
        `INSERT INTO push_devices(user_id,installation_id,expo_push_token,platform)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(user_id,installation_id) DO UPDATE SET expo_push_token=EXCLUDED.expo_push_token,
           platform=EXCLUDED.platform,enabled=TRUE,disabled_at=NULL,last_registered_at=NOW(),updated_at=NOW()`,
        [userId,installationId,token,platform],
      );
    });
  }

  async disableInstallation(userId: string, installationId: string): Promise<void> {
    await this.database.query(`UPDATE push_devices SET enabled=FALSE,disabled_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND installation_id=$2`, [userId,installationId]);
  }

  async listEnabled(userId: string): Promise<PushDevice[]> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT id,expo_push_token,platform FROM push_devices WHERE user_id=$1 AND enabled`, [userId]);
    return result.rows.flatMap((row) =>
      typeof row.id === 'string' && typeof row.expo_push_token === 'string' && (row.platform === 'ios' || row.platform === 'android')
        ? [{ id: row.id, token: row.expo_push_token, platform: row.platform }]
        : [],
    );
  }

  async listPendingForJob(userId: string, jobId: string): Promise<PushDevice[]> {
    const result=await this.database.query<{id:string;expo_push_token:string;platform:'ios'|'android'}>(
      `SELECT d.id,d.expo_push_token,d.platform FROM push_devices d
       JOIN import_jobs j ON j.id=$2 JOIN users u ON u.id=j.user_id AND u.import_generation=j.import_generation
       WHERE d.user_id=$1 AND j.user_id=$1 AND d.enabled
         AND NOT EXISTS(SELECT 1 FROM push_deliveries delivery WHERE delivery.job_id=j.id AND delivery.push_device_id=d.id AND delivery.status IN ('sent','delivered','device_disabled'))
         AND (j.kind<>'export_ready_check' OR EXISTS(SELECT 1 FROM user_export_provider_preferences p
           WHERE p.user_id=j.user_id AND p.provider=j.export_provider AND p.request_id::text=j.checkpoint->>'requestId'
             AND p.status='file_ready' AND p.alert_consent='granted'))`,[userId,jobId]);
    return result.rows.map(row=>({id:row.id,token:row.expo_push_token,platform:row.platform}));
  }

  async markDisabled(deviceId: string): Promise<void> {
    await this.database.query(`UPDATE push_devices SET enabled=FALSE,disabled_at=NOW(),updated_at=NOW() WHERE id=$1`, [deviceId]);
  }

  async recordDelivery(jobId: string, deviceId: string, status: 'sent'|'failed'|'device_disabled', ticketId?: string, errorCode?: string): Promise<void> {
    await this.database.query(
      `INSERT INTO push_deliveries(job_id,push_device_id,status,expo_ticket_id,error_code,attempts)
       VALUES($1,$2,$3,$4,$5,1)
       ON CONFLICT(job_id,push_device_id) DO UPDATE SET status=EXCLUDED.status,expo_ticket_id=EXCLUDED.expo_ticket_id,
         error_code=EXCLUDED.error_code,attempts=push_deliveries.attempts+1,updated_at=NOW()`,
      [jobId,deviceId,status,ticketId ?? null,errorCode ?? null],
    );
  }

  async listPendingReceipts(limit = 500): Promise<PendingPushReceipt[]> {
    const result = await this.database.query<Record<string,unknown>>(
      `SELECT id,push_device_id,expo_ticket_id FROM push_deliveries
       WHERE status='sent' AND expo_ticket_id IS NOT NULL AND updated_at<NOW()-INTERVAL '15 minutes'
         AND updated_at>NOW()-INTERVAL '24 hours' ORDER BY updated_at LIMIT $1`,
      [Math.max(1,Math.min(limit,1000))],
    );
    return result.rows.flatMap((row) => typeof row.id === 'string' && typeof row.push_device_id === 'string' && typeof row.expo_ticket_id === 'string'
      ? [{ deliveryId: row.id, deviceId: row.push_device_id, ticketId: row.expo_ticket_id }] : []);
  }

  async recordReceipt(deliveryId: string, status: 'delivered'|'failed'|'device_disabled', errorCode?: string): Promise<void> {
    await this.database.query(`UPDATE push_deliveries SET status=$2,error_code=$3,updated_at=NOW() WHERE id=$1`, [deliveryId,status,errorCode ?? null]);
  }
}
