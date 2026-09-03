import { DatabaseQueryExecutor } from '../ports/DatabasePort';

export type ImportEventName =
  | `monitoring_consent_${'granted' | 'declined' | 'revoked'}`
  | `ongoing_tracking_consent_${'granted' | 'declined' | 'revoked'}`
  | 'export_requested'
  | 'export_file_ready'
  | 'export_import_processing'
  | 'export_completed'
  | 'export_failed'
  | 'gmail_import_reset';

export type ImportEventMetadata = Readonly<Record<string, string | number | boolean | null>>;

/** Persists the append-only audit trail for import lifecycle changes. */
export class ImportEventRepository {
  constructor(private readonly database: DatabaseQueryExecutor) {}

  async record(
    userId: string,
    eventName: ImportEventName,
    metadata: ImportEventMetadata = {},
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO user_import_preference_events (user_id, event_name, metadata)
       VALUES ($1, $2, $3::JSONB)`,
      [userId, eventName, JSON.stringify(metadata)],
    );
  }
}
