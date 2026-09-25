interface CleanupRecords {
  listDue(): Promise<string[]>;
  recordAttempt(key: string, deleted: boolean): Promise<void>;
}

export class ImportObjectCleanupService {
  constructor(private readonly records: CleanupRecords, private readonly storage: { delete(key: string): Promise<void> }) {}

  async run(): Promise<{ deleted: number; failed: number }> {
    const summary = { deleted: 0, failed: 0 };
    for (const key of await this.records.listDue()) {
      let deleted = false;
      try { await this.storage.delete(key); deleted = true; } catch { /* Durable retry; do not log filenames. */ }
      await this.records.recordAttempt(key, deleted);
      summary[deleted ? 'deleted' : 'failed'] += 1;
    }
    return summary;
  }
}
