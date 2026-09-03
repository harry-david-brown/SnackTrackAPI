import { Migration } from './Migration';

export const adminAnalyticsCaptureMigration: Migration = {
  version: 11,
  name: 'admin_analytics_capture',
  statements: [
    'ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS environment VARCHAR(24)',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_single_activation
      ON analytics_events(user_id, event_name)
      WHERE user_id IS NOT NULL AND event_name = 'user_activated'`,
    `CREATE OR REPLACE FUNCTION snacktrack_protect_admin_audit() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP='DELETE' AND OLD.created_at < NOW()-INTERVAL '2 years' THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'admin audit events are immutable';
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_protect_admin_audit ON admin_audit_events',
    `CREATE TRIGGER trg_protect_admin_audit BEFORE UPDATE OR DELETE ON admin_audit_events
      FOR EACH ROW EXECUTE FUNCTION snacktrack_protect_admin_audit()`,
    `CREATE OR REPLACE FUNCTION snacktrack_track_user_analytics() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,properties)
          VALUES (gen_random_uuid(),'account_registered',1,COALESCE(NEW.created_at,NOW()),NEW.id,'server','server','{}');
        ELSE
          IF COALESCE(OLD.email_verified,FALSE) = FALSE AND NEW.email_verified = TRUE THEN
            INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,properties)
            VALUES (gen_random_uuid(),'email_verified',1,NOW(),NEW.id,'server','server','{}');
          END IF;
          IF COALESCE(OLD.gmail_connected,FALSE) <> COALESCE(NEW.gmail_connected,FALSE) THEN
            INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
            VALUES (gen_random_uuid(),CASE WHEN NEW.gmail_connected THEN 'mailbox_connected' ELSE 'mailbox_disconnected' END,
              1,NOW(),NEW.id,'server','server','gmail','{}');
          END IF;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_users_admin_analytics ON users',
    `CREATE TRIGGER trg_users_admin_analytics AFTER INSERT OR UPDATE OF email_verified, gmail_connected ON users
      FOR EACH ROW EXECUTE FUNCTION snacktrack_track_user_analytics()`,
    `CREATE OR REPLACE FUNCTION snacktrack_track_mailbox_connection() RETURNS TRIGGER AS $$
      DECLARE event_user_id UUID; event_provider TEXT; event_name_value TEXT;
      BEGIN
        IF TG_OP='DELETE' THEN
          event_user_id := OLD.user_id; event_provider := OLD.provider; event_name_value := 'mailbox_disconnected';
        ELSE
          event_user_id := NEW.user_id; event_provider := NEW.provider;
          IF TG_OP='INSERT' AND NEW.status='connected' THEN event_name_value := 'mailbox_connected';
          ELSIF TG_OP='UPDATE' AND OLD.status <> NEW.status THEN
            event_name_value := CASE WHEN NEW.status='connected' THEN 'mailbox_connected' ELSE 'mailbox_disconnected' END;
          ELSE RETURN NEW; END IF;
        END IF;
        INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
        VALUES (gen_random_uuid(),event_name_value,1,NOW(),event_user_id,'server','server',event_provider,'{}');
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_mailbox_connection_analytics ON mailbox_connections',
    `CREATE TRIGGER trg_mailbox_connection_analytics AFTER INSERT OR UPDATE OF status OR DELETE ON mailbox_connections
      FOR EACH ROW EXECUTE FUNCTION snacktrack_track_mailbox_connection()`,
    `CREATE OR REPLACE FUNCTION snacktrack_track_activation() RETURNS TRIGGER AS $$
      BEGIN
        INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,properties)
        VALUES (gen_random_uuid(),'user_activated',1,NOW(),NEW.user_id,'server','server','{}')
        ON CONFLICT (user_id,event_name) WHERE user_id IS NOT NULL AND event_name='user_activated' DO NOTHING;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_receipt_activation ON receipts',
    `CREATE TRIGGER trg_receipt_activation AFTER INSERT ON receipts
      FOR EACH ROW EXECUTE FUNCTION snacktrack_track_activation()`,
    `CREATE OR REPLACE FUNCTION snacktrack_track_import_event() RETURNS TRIGGER AS $$
      DECLARE mapped_name TEXT;
      BEGIN
        mapped_name := CASE NEW.event_name
          WHEN 'export_completed' THEN 'export_import_completed'
          WHEN 'export_failed' THEN 'export_import_failed'
          WHEN 'export_import_processing' THEN 'export_import_started'
          WHEN 'ongoing_tracking_consent_granted' THEN 'ongoing_tracking_consent_changed'
          WHEN 'ongoing_tracking_consent_declined' THEN 'ongoing_tracking_consent_changed'
          WHEN 'ongoing_tracking_consent_revoked' THEN 'ongoing_tracking_consent_changed'
          ELSE NEW.event_name END;
        INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
        VALUES (gen_random_uuid(),mapped_name,1,NEW.created_at,NEW.user_id,'server','server',NEW.metadata->>'provider',
          CASE WHEN NEW.event_name LIKE 'ongoing_tracking_consent_%'
            THEN jsonb_build_object('decision',replace(NEW.event_name,'ongoing_tracking_consent_',''))
            ELSE NEW.metadata END);
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_import_event_analytics ON user_import_preference_events',
    `CREATE TRIGGER trg_import_event_analytics AFTER INSERT ON user_import_preference_events
      FOR EACH ROW EXECUTE FUNCTION snacktrack_track_import_event()`,
    `CREATE OR REPLACE FUNCTION snacktrack_track_gmail_run() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP='INSERT' AND NEW.outcome='running' AND NEW.trigger_type <> 'background' THEN
          INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
          VALUES (gen_random_uuid(),'historical_import_started',1,NEW.started_at,NEW.user_id,'server','server','gmail','{}');
        ELSIF TG_OP='UPDATE' AND OLD.outcome = 'running' AND NEW.outcome <> 'running' THEN
          INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
          VALUES (gen_random_uuid(),
            CASE WHEN NEW.trigger_type='background' THEN 'background_sync_' || CASE WHEN NEW.outcome='failed' THEN 'failed' ELSE 'completed' END
                 ELSE 'historical_import_' || CASE WHEN NEW.outcome='failed' THEN 'failed' ELSE 'completed' END END,
            1,COALESCE(NEW.completed_at,NOW()),NEW.user_id,'server','server','gmail',
            jsonb_build_object('outcome',NEW.outcome,'newOrders',NEW.new_orders,'errorCode',NEW.error_code));
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_gmail_run_analytics ON gmail_sync_runs',
    `CREATE TRIGGER trg_gmail_run_analytics AFTER INSERT OR UPDATE OF outcome ON gmail_sync_runs
      FOR EACH ROW EXECUTE FUNCTION snacktrack_track_gmail_run()`,
    `CREATE OR REPLACE FUNCTION snacktrack_track_mailbox_run() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP='INSERT' AND NEW.outcome='running' AND NEW.trigger_type <> 'background' THEN
          INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
          VALUES (gen_random_uuid(),'historical_import_started',1,NEW.started_at,NEW.user_id,'server','server',NEW.provider,'{}');
        ELSIF TG_OP='UPDATE' AND OLD.outcome = 'running' AND NEW.outcome <> 'running' THEN
          INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
          VALUES (gen_random_uuid(),
            CASE WHEN NEW.trigger_type='background' THEN 'background_sync_' || CASE WHEN NEW.outcome='failed' THEN 'failed' ELSE 'completed' END
                 ELSE 'historical_import_' || CASE WHEN NEW.outcome='failed' THEN 'failed' ELSE 'completed' END END,
            1,COALESCE(NEW.completed_at,NOW()),NEW.user_id,'server','server',NEW.provider,
            jsonb_build_object('outcome',NEW.outcome,'newOrders',NEW.new_orders,'errorCode',NEW.error_code));
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    'DROP TRIGGER IF EXISTS trg_mailbox_run_analytics ON mailbox_sync_runs',
    `CREATE TRIGGER trg_mailbox_run_analytics AFTER INSERT OR UPDATE OF outcome ON mailbox_sync_runs
      FOR EACH ROW EXECUTE FUNCTION snacktrack_track_mailbox_run()`,
    `INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,properties)
      SELECT gen_random_uuid(),'account_registered',1,u.created_at,u.id,'backfill','server','{"backfilled":true}'::jsonb
      FROM users u WHERE NOT EXISTS (
        SELECT 1 FROM analytics_events e WHERE e.user_id=u.id AND e.event_name='account_registered'
      )`,
    `INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,properties)
      SELECT gen_random_uuid(),'user_activated',1,MIN(r.created_at),r.user_id,'backfill','server','{"backfilled":true}'::jsonb
      FROM receipts r GROUP BY r.user_id ON CONFLICT (user_id,event_name)
      WHERE user_id IS NOT NULL AND event_name='user_activated' DO NOTHING`,
    `INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
      SELECT gen_random_uuid(),'mailbox_connected',1,NOW(),u.id,'backfill','server','gmail','{"backfilled":true}'::jsonb
      FROM users u WHERE COALESCE(u.gmail_connected,FALSE) AND NOT EXISTS (
        SELECT 1 FROM analytics_events e WHERE e.user_id=u.id AND e.event_name='mailbox_connected' AND e.provider='gmail')`,
    `INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
      SELECT gen_random_uuid(),'mailbox_connected',1,mc.created_at,mc.user_id,'backfill','server',mc.provider,'{"backfilled":true}'::jsonb
      FROM mailbox_connections mc WHERE NOT EXISTS (
        SELECT 1 FROM analytics_events e WHERE e.user_id=mc.user_id AND e.event_name='mailbox_connected' AND e.provider=mc.provider)`,
    `INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
      SELECT gen_random_uuid(),
        CASE WHEN r.trigger_type='background' THEN 'background_sync_' ELSE 'historical_import_' END ||
          CASE WHEN r.outcome='failed' THEN 'failed' ELSE 'completed' END,
        1,COALESCE(r.completed_at,r.started_at),r.user_id,'backfill','server',r.provider,
        jsonb_build_object('backfilled',true,'outcome',r.outcome,'runId',r.id)
      FROM (SELECT id,user_id,'gmail'::text provider,trigger_type,outcome,started_at,completed_at FROM gmail_sync_runs WHERE outcome<>'running'
        UNION ALL SELECT id,user_id,provider,trigger_type,outcome,started_at,completed_at FROM mailbox_sync_runs WHERE outcome<>'running') r
      WHERE NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.properties->>'runId'=r.id::text)`,
    `INSERT INTO analytics_events(event_id,event_name,schema_version,occurred_at,user_id,source,platform,provider,properties)
      SELECT gen_random_uuid(),CASE WHEN p.status='completed' THEN 'export_import_completed' ELSE 'export_import_failed' END,
        1,p.updated_at,p.user_id,'backfill','server',p.provider,'{"backfilled":true}'::jsonb
      FROM user_export_provider_preferences p WHERE p.status IN ('completed','failed') AND NOT EXISTS (
        SELECT 1 FROM analytics_events e WHERE e.user_id=p.user_id AND e.provider=p.provider
          AND e.event_name=CASE WHEN p.status='completed' THEN 'export_import_completed' ELSE 'export_import_failed' END)`,
  ],
};
