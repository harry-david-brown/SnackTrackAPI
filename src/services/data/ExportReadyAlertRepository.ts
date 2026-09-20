import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import type { ConsentDecision, ExportProvider } from '../import/ImportLifecycleTypes';

export const BACKGROUND_ALERT_CONSENT_VERSION = 'export-ready-background-v1';
export interface ExportAlertCandidate { userId: string; provider: ExportProvider; requestId: string }

export class ExportReadyAlertRepository {
  constructor(private readonly database: DatabaseQueryExecutor) {}

  async setConsent(userId: string, provider: ExportProvider, decision: ConsentDecision): Promise<void> {
    await this.database.query(`INSERT INTO user_export_provider_preferences(user_id,provider) VALUES($1,$2) ON CONFLICT DO NOTHING`, [userId,provider]);
    await this.database.query(`UPDATE user_export_provider_preferences SET alert_consent=$3,
      alert_consent_version=CASE WHEN $3='granted' THEN $4 ELSE alert_consent_version END,
      alert_consented_at=CASE WHEN $3='granted' THEN NOW() ELSE alert_consented_at END,
      alert_revoked_at=CASE WHEN $3='revoked' THEN NOW() ELSE NULL END,
      alert_next_check_at=CASE WHEN $3='granted' THEN NOW() ELSE NULL END
      WHERE user_id=$1 AND provider=$2`, [userId,provider,decision,BACKGROUND_ALERT_CONSENT_VERSION]);
  }

  async due(limit: number, userId?: string): Promise<ExportAlertCandidate[]> {
    const result = await this.database.query<{user_id:string;provider:ExportProvider;request_id:string}>(
      `SELECT p.user_id,p.provider,p.request_id FROM user_export_provider_preferences p
       JOIN users u ON u.id=p.user_id
       WHERE p.status='requested' AND p.requested_at IS NOT NULL AND p.alert_consent='granted'
         AND p.alert_consent_version=$1 AND ($2::uuid IS NULL OR p.user_id=$2)
         AND ($2::uuid IS NOT NULL OR COALESCE(p.alert_next_check_at,NOW())<=NOW())
         AND (u.gmail_connected=TRUE OR EXISTS(SELECT 1 FROM mailbox_connections m WHERE m.user_id=p.user_id AND m.state='connected'))
       ORDER BY p.alert_next_check_at NULLS FIRST LIMIT $3`, [BACKGROUND_ALERT_CONSENT_VERSION,userId ?? null,limit]);
    return result.rows.map(r=>({userId:r.user_id,provider:r.provider,requestId:r.request_id}));
  }

  async scheduled(candidate: ExportAlertCandidate): Promise<void> {
    await this.database.query(`UPDATE user_export_provider_preferences SET alert_next_check_at=NOW()+INTERVAL '15 minutes'
      WHERE user_id=$1 AND provider=$2 AND request_id=$3 AND alert_consent='granted'`, [candidate.userId,candidate.provider,candidate.requestId]);
  }
}
