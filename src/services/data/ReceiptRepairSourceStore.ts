import { randomUUID } from 'crypto';
import { ConflictError, ValidationError } from '../../core/errors';
import { DataSource, ReceiptType, type ReceiptWriteCommand } from '../../models/Receipt';
import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import { decodeRetainedEmailDiagnostics, type RepairSourceProvenance } from '../receipt/ReceiptRepairSources';
import { evidenceFingerprint, receiptDocumentKey } from '../receipt/ReceiptEvidenceFingerprint';
import type { ExportCoverage, SourceObservation } from '../receipt/ReceiptGroupReconciler';
import { decodeReceiptObservation } from './receiptObservationCodec';
import { getDefaultTimezone, isValidTimezone } from '../../utils/timezone';
import { isOrderEvidenceParserVersion } from '../../models/OrderEvidence';

interface SourceBatch {
  id: string;
  parserVersion: number;
  provenance: RepairSourceProvenance;
  observations: SourceObservation[];
  coverage: ExportCoverage[];
}

function decodeProvenance(value: unknown): RepairSourceProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError('Invalid repair provenance');
  const o = value as Record<string, unknown>;
  if (
    (o.sourceKind !== 'provider_export' && o.sourceKind !== 'retained_email') ||
    (o.provider !== ReceiptType.UBER_EATS && o.provider !== ReceiptType.DOORDASH) ||
    typeof o.sourceLabel !== 'string' ||
    !o.sourceLabel.trim() ||
    o.sourceLabel.length > 256 ||
    typeof o.acquiredAt !== 'string' ||
    !Number.isFinite(Date.parse(o.acquiredAt)) ||
    typeof o.successfulCompletion !== 'boolean' ||
    !Number.isSafeInteger(o.rejectedRecords) ||
    typeof o.rejectedRecords !== 'number' ||
    o.rejectedRecords < 0
  )
    throw new ValidationError('Invalid repair provenance');
  const result: RepairSourceProvenance = {
    sourceKind: o.sourceKind,
    provider: o.provider,
    sourceLabel: o.sourceLabel.trim(),
    acquiredAt: new Date(o.acquiredAt).toISOString(),
    successfulCompletion: o.successfulCompletion,
    rejectedRecords: o.rejectedRecords,
  };
  if (o.parsingTimezone !== undefined) {
    if (!isValidTimezone(o.parsingTimezone)) throw new ValidationError('Invalid parsing timezone');
    result.parsingTimezone = o.parsingTimezone;
  }
  if (o.emailDiagnostics !== undefined) {
    if (o.sourceKind !== 'retained_email') throw new ValidationError('Email diagnostics require retained email evidence');
    result.emailDiagnostics = decodeRetainedEmailDiagnostics(o.emailDiagnostics);
  }
  if (o.artifact !== undefined) {
    if (!o.artifact || typeof o.artifact !== 'object' || Array.isArray(o.artifact))
      throw new ValidationError('Invalid retained export identity');
    const artifact = o.artifact as Record<string, unknown>;
    if (
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      typeof artifact.sizeBytes !== 'number' ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0
    )
      throw new ValidationError('Invalid retained export identity');
    result.artifact = { sha256: artifact.sha256, sizeBytes: artifact.sizeBytes };
  }
  if (o.declaredCoverage !== undefined) {
    if (
      !Array.isArray(o.declaredCoverage) ||
      o.declaredCoverage.length > 100 ||
      o.sourceKind !== 'provider_export'
    )
      throw new ValidationError('Invalid declared export coverage');
    result.declaredCoverage = o.declaredCoverage
      .map((interval: unknown) => {
        if (!interval || typeof interval !== 'object')
          throw new ValidationError('Invalid coverage interval');
        const span = interval as Record<string, unknown>;
        if (
          typeof span.start !== 'string' ||
          typeof span.end !== 'string' ||
          !Number.isFinite(Date.parse(span.start)) ||
          !Number.isFinite(Date.parse(span.end)) ||
          Date.parse(span.start) > Date.parse(span.end)
        )
          throw new ValidationError('Invalid coverage interval');
        return { start: new Date(span.start).toISOString(), end: new Date(span.end).toISOString() };
      })
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  }
  return result;
}

function coverageFor(batch: Omit<SourceBatch, 'coverage'>): ExportCoverage[] {
  if (batch.provenance.sourceKind !== 'provider_export') return [];
  const dates = batch.observations
    .map((o) => o.receipt.orderDate?.toISOString())
    .filter((v): v is string => !!v)
    .sort();
  if (!dates.length) return [];
  const declared = batch.provenance.declaredCoverage;
  // A separate row per declared interval prevents manufacturing coverage across gaps.
  return (declared?.length ? declared : [{ start: dates[0], end: dates[dates.length - 1] }]).map(
    (span, index) => ({
      ...span,
      batchId: `repair:${batch.id}:${index}`,
      provider: batch.provenance.provider,
      quality: declared?.length ? 'declared' : 'observed',
      incomplete: !batch.provenance.successfulCompletion || batch.provenance.rejectedRecords > 0,
    }),
  );
}

/** Acquired sources are staged without modifying canonical receipts or coverage. */
export class ReceiptRepairSourceStore {
  async stage(
    tx: DatabaseQueryExecutor,
    userId: string,
    generation: number,
    incoming: readonly ReceiptWriteCommand[],
    provenanceInput: RepairSourceProvenance,
    guard: () => Promise<void>,
  ) {
    await guard();
    const current = await tx.query<{ import_generation: number; timezone: string | null }>(
      'SELECT import_generation,timezone FROM users WHERE id=$1 FOR UPDATE',
      [userId],
    );
    if (Number(current.rows[0]?.import_generation) !== generation)
      throw new ConflictError('REPAIR_GENERATION_STALE', 'Receipt repair generation is stale');
    const provenance = decodeProvenance(provenanceInput);
    if (
      provenance.parsingTimezone &&
      provenance.parsingTimezone !== (current.rows[0]?.timezone ?? getDefaultTimezone())
    )
      throw new ConflictError(
        'REPAIR_TIMEZONE_CHANGED',
        'Account timezone changed; preview the source again',
      );
    if (!incoming.length || incoming.length > 100000)
      throw new ValidationError('Repair source batch must contain 1–100000 observations');
    const byDocument = new Map<string, ReceiptWriteCommand>();
    const parserVersions = new Set<number>();
    for (const input of incoming) {
      const receipt = decodeReceiptObservation(input);
      const parserVersion = receipt.resolution?.orderEvidence?.parserVersion;
      if (
        receipt.userId !== userId ||
        receipt.receiptType !== provenance.provider ||
        (receipt.dataSource === DataSource.CSV) !== (provenance.sourceKind === 'provider_export') ||
        !isOrderEvidenceParserVersion(parserVersion)
      )
        throw new ValidationError(
          'Repair evidence must belong to this account, provider and parser version',
        );
      byDocument.set(receiptDocumentKey(receipt), receipt);
      parserVersions.add(parserVersion);
    }
    if (parserVersions.size !== 1)
      throw new ValidationError('Repair evidence must use one parser version per source batch');
    const parserVersion = [...parserVersions][0];
    const documents = [...byDocument].sort(([a], [b]) => a.localeCompare(b));
    if (provenance.emailDiagnostics && (provenance.emailDiagnostics.acceptedMessages !== documents.length ||
      Object.values(provenance.emailDiagnostics.rejected).reduce((a,b)=>a+b,0) !== provenance.rejectedRecords ||
      documents.some(([,r])=>!r.resolution?.sourceMessageId?.startsWith(`${provenance.emailDiagnostics?.mailboxProvider}:`))))
      throw new ValidationError('Retained email evidence does not match its acquisition provenance');
    const fingerprint = evidenceFingerprint({ provenance, documents });
    const id = randomUUID();
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO receipt_repair_source_batches(id,user_id,import_generation,parser_version,fingerprint,provenance)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(user_id,import_generation,fingerprint) DO NOTHING RETURNING id`,
      [id, userId, generation, parserVersion, fingerprint, JSON.stringify(provenance)],
    );
    let batchId: string = id;
    if (inserted.rows.length) {
      for (const [key, receipt] of documents)
        await tx.query(
          `INSERT INTO receipt_repair_source_observations(id,user_id,batch_id,document_key,payload) VALUES($1,$2,$3,$4,$5::jsonb)`,
          [randomUUID(), userId, id, key, JSON.stringify(receipt)],
        );
    } else {
      const existing = await tx.query<{ id: string; expired: boolean }>(
        `SELECT id,expires_at<=NOW() AS expired FROM receipt_repair_source_batches WHERE user_id=$1 AND import_generation=$2 AND fingerprint=$3`,
        [userId, generation, fingerprint],
      );
      if (!existing.rows[0] || existing.rows[0].expired)
        throw new ConflictError(
          'REPAIR_SOURCE_EXPIRED',
          'Staged source batch expired; acquire a fresh source batch',
        );
      batchId = existing.rows[0].id;
    }
    await guard();
    return { batchId, observations: documents.length, fingerprint };
  }

  async load(
    tx: DatabaseQueryExecutor,
    userId: string,
    generation: number,
    ids: readonly string[],
  ) {
    return this.read(tx, userId, generation, ids, false);
  }

  /** Expiry prevents publication, not inspection of retained immutable evidence. */
  async inspect(
    tx: DatabaseQueryExecutor,
    userId: string,
    generation: number,
    ids: readonly string[],
  ) {
    return this.read(tx, userId, generation, ids, true);
  }

  private async read(
    tx: DatabaseQueryExecutor,
    userId: string,
    generation: number,
    ids: readonly string[],
    allowExpired: boolean,
  ) {
    if (
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    )
      throw new ValidationError('Invalid staged repair batch selection');
    const batches: SourceBatch[] = [];
    const expiredBatchIds: string[] = [];
    for (const id of [...ids].sort()) {
      const result = await tx.query<{
        id: string;
        provenance: unknown;
        parser_version: number;
        import_generation: number;
        fingerprint: string;
        expired: boolean;
      }>(
        `SELECT id,provenance,parser_version,import_generation,fingerprint,expires_at<=NOW() AS expired FROM receipt_repair_source_batches WHERE user_id=$1 AND id=$2`,
        [userId, id],
      );
      const row = result.rows[0];
      if (!row || row.import_generation !== generation || !isOrderEvidenceParserVersion(row.parser_version))
        throw new ConflictError(
          'REPAIR_SOURCE_STALE',
          'Staged repair source is missing or has a different generation/version',
        );
      if (row.expired && !allowExpired)
        throw new ConflictError(
          'REPAIR_SOURCE_EXPIRED',
          'Staged repair source expired; prepare a fresh repair',
        );
      if (row.expired) expiredBatchIds.push(id);
      const sources = await tx.query<{ id: string; document_key: string; payload: unknown }>(
        'SELECT id,document_key,payload FROM receipt_repair_source_observations WHERE user_id=$1 AND batch_id=$2 ORDER BY id',
        [userId, id],
      );
      const observations = sources.rows.map((o) => {
        const receipt = decodeReceiptObservation(o.payload);
        if (receipt.userId !== userId || receiptDocumentKey(receipt) !== o.document_key)
          throw new Error('Staged receipt evidence failed its integrity check');
        return { id: o.id, receipt };
      });
      if (!observations.length)
        throw new ConflictError(
          'REPAIR_SOURCE_CHANGED',
          'Staged repair source has no observations',
        );
      const batch = {
        id,
        parserVersion: row.parser_version,
        provenance: decodeProvenance(row.provenance),
        observations,
      };
      const documents = observations
        .map((o) => [receiptDocumentKey(o.receipt), o.receipt] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      if (evidenceFingerprint({ provenance: batch.provenance, documents }) !== row.fingerprint)
        throw new ConflictError(
          'REPAIR_SOURCE_CHANGED',
          'Staged evidence changed; acquire a fresh source batch',
        );
      batches.push({ ...batch, coverage: coverageFor(batch) });
    }
    return { batches, fingerprint: evidenceFingerprint(batches), expiredBatchIds };
  }

  async activateCoverage(
    tx: DatabaseQueryExecutor,
    userId: string,
    batches: readonly SourceBatch[],
  ): Promise<void> {
    for (const batch of batches) {
      const dates = batch.observations
        .map((o) => o.receipt.orderDate?.toISOString())
        .filter((v): v is string => !!v)
        .sort();
      for (const coverage of batch.coverage)
        await tx.query(
          `INSERT INTO receipt_import_batches(id,user_id,provider,observed_start,observed_end,accepted_orders,rejected_records,declared_start,declared_end,successful_completion)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,id) DO NOTHING`,
          [
            coverage.batchId,
            userId,
            coverage.provider,
            dates[0],
            dates[dates.length - 1],
            batch.observations.length,
            batch.provenance.rejectedRecords,
            coverage.quality === 'declared' ? coverage.start : null,
            coverage.quality === 'declared' ? coverage.end : null,
            batch.provenance.successfulCompletion,
          ],
        );
    }
  }
}
