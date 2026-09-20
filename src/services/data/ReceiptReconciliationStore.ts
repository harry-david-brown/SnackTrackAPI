import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../core/errors';
import { Receipt, ReceiptWriteCommand, DataSource } from '../../models/Receipt';
import { DatabaseQueryExecutor } from '../ports/DatabasePort';
import { mapReceiptRow, ReceiptRow } from './receiptRowMapper';
import { decodeReceiptObservation } from './receiptObservationCodec';
import { databaseNonNegativeInteger, databaseString } from './DatabaseRowDecoder';
import { ACTIVE_RECEIPT_POLICY, type ReceiptPolicyVersion } from '../receipt/ReceiptPolicy';
import {
  evidenceFingerprint,
  receiptDocumentKey as documentKey,
} from '../receipt/ReceiptEvidenceFingerprint';
import { ReceiptOrderEventStore } from './ReceiptOrderEventStore';
import { ReceiptRepairSourceStore } from './ReceiptRepairSourceStore';
import { ReceiptImportOutcomeStore } from './ReceiptImportOutcomeStore';
import { loadReceiptReviews, appendReceiptReviews } from './ReceiptReviewStore';
import {
  activeReceiptReviews,
  prepareReceiptReviews,
  compensateReceiptReviews,
  decodeReceiptReview,
  decodeReceiptReviewChanges,
  type ReceiptReview,
  type ReceiptReviewChange,
} from '../receipt/ReceiptReviewDecisions';
import type { ReceiptImportAccounting } from '../import/ReceiptImportOutcome';
export { evidenceFingerprint } from '../receipt/ReceiptEvidenceFingerprint';
import {
  reconcileReceiptGroups,
  projectReconciledGroup,
  SourceObservation,
  ExportCoverage,
} from '../receipt/ReceiptGroupReconciler';
import { createUberPriceReinterpreter } from '../receipt/UberPriceReinterpretation';
import { CURRENT_UBER_EXPORT_PARSER_VERSION } from '../../models/OrderEvidence';
import { sourceDocumentIdentity } from '../receipt/ReceiptSourceInterpretations';

type Writer = (tx: DatabaseQueryExecutor, receipt: Receipt) => Promise<void>;
export interface ReconciliationSnapshot {
  reviews?: ReceiptReview[];
  receipts: Receipt[];
  observations: SourceObservation[];
  coverage: ExportCoverage[];
  timezone: string;
}
export class ReceiptReconciliationStore {
  constructor(
    private readonly write: Writer,
    private readonly policyVersion: ReceiptPolicyVersion = ACTIVE_RECEIPT_POLICY,
  ) {}
  async load(
    tx: DatabaseQueryExecutor,
    userId: string,
    lock = true,
  ): Promise<ReconciliationSnapshot> {
    const user = await tx.query<{ timezone: string }>(
      `SELECT timezone FROM users WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    if (!user.rows.length) throw new Error('Receipt account no longer exists');
    const receipts = (
      await tx.query<ReceiptRow>(
        `SELECT * FROM receipts WHERE user_id=$1 ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [userId],
      )
    ).rows.map(mapReceiptRow);
    const rows = await tx.query<{
      id: string;
      receipt_id: string | null;
      payload: unknown;
      association_enabled: boolean;
      last_receipt_id: string | null;
    }>(
      'SELECT id,receipt_id,payload,association_enabled,last_receipt_id FROM receipt_observations WHERE user_id=$1 ORDER BY id',
      [userId],
    );
    const observations: SourceObservation[] = rows.rows.map((o) => ({
      id: o.id,
      receiptId: o.receipt_id ?? undefined,
      associationEnabled: o.association_enabled === false ? false : undefined,
      lastReceiptId: o.receipt_id ? undefined : (o.last_receipt_id ?? undefined),
      receipt: decodeReceiptObservation(o.payload),
    }));
    const batches = await tx.query<{
      provider: string;
      start: Date;
      end: Date;
      quality: 'observed' | 'declared';
      incomplete: boolean;
      batch_id: string;
    }>(
      `SELECT provider,COALESCE(declared_start,observed_start) AS start,COALESCE(declared_end,observed_end) AS end,
      CASE WHEN declared_start IS NULL THEN 'observed' ELSE 'declared' END AS quality,
      (rejected_records>0 OR NOT successful_completion) AS incomplete,id AS batch_id
      FROM receipt_import_batches WHERE user_id=$1 AND association_enabled ORDER BY id`,
      [userId],
    );
    const coverage: ExportCoverage[] = batches.rows.map((b) => ({
      provider: b.provider,
      quality: b.quality,
      incomplete: b.incomplete,
      batchId: b.batch_id,
      start: new Date(b.start).toISOString(),
      end: new Date(b.end).toISOString(),
    }));
    // Existing export observations establish observed coverage only, never completeness.
    for (const provider of ['uber_eats', 'doordash'])
      if (!coverage.some((c) => c.provider === provider)) {
        const dates = receipts
          .filter(
            (r) => r.receiptType === provider && r.dataSource === DataSource.CSV && r.orderDate,
          )
          .map((r) => r.orderDate!.toISOString())
          .sort();
        if (dates.length)
          coverage.push({
            provider,
            start: dates[0],
            end: dates[dates.length - 1],
            quality: 'observed',
            incomplete: false,
          });
      }
    const reviews = await loadReceiptReviews(tx, userId);
    return {
      receipts,
      observations,
      coverage,
      timezone: user.rows[0].timezone || 'America/Toronto',
      ...(reviews.length ? { reviews } : {}),
    };
  }
  plan(snapshot: ReconciliationSnapshot): ReconciliationSnapshot {
    if (this.policyVersion !== 3 && activeReceiptReviews(snapshot.reviews ?? []).length)
      throw new ConflictError('REPAIR_POLICY_STALE', 'Published review decisions require policy 3');
    const unobservedReceipts = snapshot.receipts.filter(
      receipt => !snapshot.observations.some(observation => observation.receiptId === receipt.id),
    );
    const reinterpretPrice = createUberPriceReinterpreter([
      ...snapshot.observations.map(observation => observation.receipt),
      ...unobservedReceipts,
    ]);
    const observations = snapshot.observations.map((o) => ({ ...o }));
    const parser4Documents = new Set(
      snapshot.observations
        .filter(
          observation =>
            (observation.receipt.resolution?.orderEvidence?.parserVersion ?? 0) >=
            CURRENT_UBER_EXPORT_PARSER_VERSION,
        )
        .map(sourceDocumentIdentity),
    );
    for (const observation of snapshot.observations) {
      const parserVersion = observation.receipt.resolution?.orderEvidence?.parserVersion ?? 0;
      if (
        observation.receipt.receiptType === 'uber_eats' &&
        observation.receipt.dataSource === 'csv' &&
        observation.receipt.resolution?.rows?.length &&
        parserVersion < CURRENT_UBER_EXPORT_PARSER_VERSION &&
        !parser4Documents.has(sourceDocumentIdentity(observation))
      ) {
        const interpretation = { ...observation, id: randomUUID(), receipt: reinterpretPrice(observation.receipt) };
        observations.push(interpretation);
        parser4Documents.add(sourceDocumentIdentity(interpretation));
      }
    }
    for (const r of snapshot.receipts)
      if (!observations.some((o) => o.receiptId === r.id)) {
        observations.push({ id: randomUUID(), receiptId: r.id, receipt: reinterpretPrice(r, true) });
      }
    const groups = reconcileReceiptGroups(
      observations.filter((o) => o.associationEnabled !== false),
      snapshot.timezone,
      snapshot.coverage,
      this.policyVersion,
      snapshot.reviews,
    );
    const used = new Set<string>();
    // Established orders keep their references before a detached, unresolved source
    // can claim one. This also applies when the disputed document is an export.
    const ordered = [...groups].sort(
      (a, b) =>
        Number(Boolean(a.reason)) - Number(Boolean(b.reason)) ||
        Number(b.observations.some((o) => o.receipt.dataSource === DataSource.CSV)) -
          Number(a.observations.some((o) => o.receipt.dataSource === DataSource.CSV)),
    );
    const receipts = ordered.map((g) => {
      const members = new Set(g.observations.map((o) => o.id));
      const previous = snapshot.receipts
        .filter((r) => g.observations.some((o) => o.receiptId === r.id))
        .sort(
          (a, b) =>
            Number(b.dataSource === DataSource.EMAIL) - Number(a.dataSource === DataSource.EMAIL) ||
            a.id!.localeCompare(b.id!),
        );
      const exact = previous.find(
        (r) =>
          !used.has(r.id!) &&
          observations.filter((o) => o.receiptId === r.id).every((o) => members.has(o.id)),
      );
      const detachedId = g.observations
        .map((o) => o.lastReceiptId)
        .find(
          (id) =>
            id &&
            !used.has(id) &&
            observations.filter((o) => o.lastReceiptId === id).every((o) => members.has(o.id)),
        );
      const id =
        exact?.id ?? previous.find((r) => !used.has(r.id!))?.id ?? detachedId ?? randomUUID();
      used.add(id);
      for (const o of g.observations) {
        o.receiptId = id;
        o.lastReceiptId = undefined;
      }
      return projectReconciledGroup(g, id);
    });
    return {
      ...snapshot,
      receipts: receipts.sort((a, b) => a.id!.localeCompare(b.id!)),
      observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  /** Caller owns a repeatable-read, read-only transaction. Never prepares or publishes a manifest. */
  async preview(tx: DatabaseQueryExecutor, userId: string, stagedBatchIds: readonly string[] = []) {
    const user = (
      await tx.query(
        `SELECT import_generation,receipt_projection_revision::text AS projection_revision FROM users WHERE id=$1`,
        [userId],
      )
    ).rows[0];
    if (!user) throw new Error('Receipt account no longer exists');
    const generation = databaseNonNegativeInteger(user, 'import_generation');
    const revision = databaseString(user, 'projection_revision');
    if (!Number.isSafeInteger(generation) || !/^\d+$/.test(revision))
      throw new Error('Invalid receipt account generation/revision');
    const before = await this.load(tx, userId, false);
    const { after, staged } = await this.planRepair(tx, userId, generation, before, stagedBatchIds);
    return {
      before,
      after,
      context: {
        mode: 'read_only_preview' as const,
        servingPolicyVersion: ACTIVE_RECEIPT_POLICY,
        proposedPolicyVersion: this.policyVersion,
        importGeneration: generation,
        projectionRevision: revision,
        beforeFingerprint: evidenceFingerprint(before),
        proposedFingerprint: evidenceFingerprint(after),
        stagedFingerprint: staged.fingerprint,
        // New projection/legacy-evidence IDs are provisional until a manifest is prepared.
        provisionalIds: true,
      },
      stagedBatches: staged.batches,
    };
  }
  /** Inspect exactly the saved proposal. Caller owns a repeatable-read, read-only transaction. */
  async inspectManifest(tx: DatabaseQueryExecutor, userId: string, manifestId: string) {
    const row = (
      await tx.query<{
        id: string;
        before_state: unknown;
        after_state: unknown;
        before_fingerprint: string;
        after_fingerprint: string | null;
        import_generation: number;
        policy_version: number;
        parser_version: number;
        status: 'prepared' | 'published' | 'rolled_back';
        staged_batch_ids: string[];
        staged_fingerprint: string | null;
        expired: boolean;
        created_at: Date;
        expires_at: Date;
        published_at: Date | null;
        rolled_back_at: Date | null;
        checked_at: Date;
      }>(
        `SELECT id,before_state,after_state,before_fingerprint,after_fingerprint,
          import_generation,policy_version,parser_version,status,staged_batch_ids,staged_fingerprint,
          created_at,expires_at,published_at,rolled_back_at,expires_at<=NOW() AS expired,NOW() AS checked_at
         FROM receipt_repair_manifests WHERE user_id=$1 AND id=$2`,
        [userId, manifestId],
      )
    ).rows[0];
    if (!row) throw new NotFoundError('Receipt repair manifest');
    const before = decodeSnapshot(row.before_state);
    const after = decodeSnapshot(row.after_state);
    if (
      !['prepared', 'published', 'rolled_back'].includes(row.status) ||
      evidenceFingerprint(before) !== row.before_fingerprint ||
      [before, after].some(
        (snapshot) =>
          (snapshot.reviews ?? []).some(
            (review) =>
              review.userId !== userId || review.importGeneration !== row.import_generation,
          ) ||
          [...snapshot.receipts, ...snapshot.observations.map((o) => o.receipt)].some(
            (receipt) => receipt.userId !== userId,
          ),
      )
    )
      throw new ConflictError(
        'REPAIR_MANIFEST_INVALID',
        'Repair manifest failed its integrity check',
      );
    const user = (
      await tx.query(
        'SELECT import_generation,receipt_projection_revision::text AS projection_revision FROM users WHERE id=$1',
        [userId],
      )
    ).rows[0];
    if (!user) throw new NotFoundError('Receipt repair manifest');
    const currentGeneration = databaseNonNegativeInteger(user, 'import_generation');
    const currentRevision = databaseString(user, 'projection_revision');
    const currentFingerprint = evidenceFingerprint(await this.load(tx, userId, false));
    const sourceStore = new ReceiptRepairSourceStore();
    let staged: Awaited<ReturnType<ReceiptRepairSourceStore['inspect']>> | undefined;
    const sourceIssues: string[] = [];
    try {
      staged = await sourceStore.inspect(tx, userId, row.import_generation, row.staged_batch_ids);
      if (staged.fingerprint !== row.staged_fingerprint) sourceIssues.push('REPAIR_SOURCE_CHANGED');
      if (staged.expiredBatchIds.length) sourceIssues.push('REPAIR_SOURCE_EXPIRED');
    } catch (error) {
      // Missing retained batches must not hide the saved order evidence. Unexpected database or
      // decoding failures still fail the inspection instead of looking like a successful audit.
      if (
        !(error instanceof ConflictError) ||
        !['REPAIR_SOURCE_STALE', 'REPAIR_SOURCE_CHANGED'].includes(error.code)
      )
        throw error;
      sourceIssues.push(error.code);
    }
    const stateIssues: string[] = [];
    if (currentGeneration !== row.import_generation) stateIssues.push('REPAIR_GENERATION_STALE');
    if (
      row.policy_version !== ACTIVE_RECEIPT_POLICY ||
      row.parser_version !== CURRENT_UBER_EXPORT_PARSER_VERSION
    )
      stateIssues.push('REPAIR_POLICY_NOT_SERVING');
    const expectedCurrentFingerprint =
      row.status === 'prepared' ? row.before_fingerprint : row.after_fingerprint;
    if (currentFingerprint !== expectedCurrentFingerprint)
      stateIssues.push('REPAIR_EVIDENCE_CHANGED');
    return {
      before,
      after,
      stagedBatches: staged?.batches ?? [],
      context: {
        mode: 'saved_manifest' as const,
        manifestId: row.id,
        status: row.status,
        servingPolicyVersion: ACTIVE_RECEIPT_POLICY,
        proposedPolicyVersion: row.policy_version,
        parserVersion: row.parser_version,
        importGeneration: row.import_generation,
        currentImportGeneration: currentGeneration,
        currentProjectionRevision: currentRevision,
        beforeFingerprint: row.before_fingerprint,
        proposedFingerprint: evidenceFingerprint(after),
        currentFingerprint,
        // This is the last committed publish OR rollback fingerprint, not the saved proposal.
        lastCommittedFingerprint: row.after_fingerprint,
        stagedFingerprint: row.staged_fingerprint,
        stagedBatchIds: row.staged_batch_ids,
        stagedDetailsAvailable: staged !== undefined,
        expiredStagedBatchIds: staged?.expiredBatchIds ?? [],
        provisionalIds: false,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        publishedAt: row.published_at,
        rolledBackAt: row.rolled_back_at,
        validation: {
          checkedAt: row.checked_at,
          // Informational snapshot only; publication/rollback must revalidate under the writer lock.
          action:
            row.status === 'prepared' ? 'publish' : row.status === 'published' ? 'rollback' : null,
          issues: [
            ...stateIssues,
            ...(row.status === 'prepared'
              ? [...(row.expired ? ['REPAIR_MANIFEST_EXPIRED'] : []), ...sourceIssues]
              : []),
          ],
          sourceIssues,
        },
      },
    };
  }
  /** The shadow preview and durable manifest preparation must plan identical evidence. */
  private async planRepair(
    tx: DatabaseQueryExecutor,
    userId: string,
    generation: number,
    before: ReconciliationSnapshot,
    stagedBatchIds: readonly string[],
    reviewChanges: readonly ReceiptReviewChange[] = [],
  ) {
    if ((stagedBatchIds.length || reviewChanges.length) && this.policyVersion !== 3)
      throw new ConflictError('REPAIR_POLICY_STALE', 'Staged repairs require policy 3');
    const staged = await new ReceiptRepairSourceStore().load(
      tx,
      userId,
      generation,
      stagedBatchIds,
    );
    const observations = before.observations.map((o) => ({ ...o }));
    const byDocument = new Map(observations.map((o) => [documentKey(o.receipt), o]));
    for (const batch of staged.batches)
      for (const source of batch.observations) {
        const existing = byDocument.get(documentKey(source.receipt));
        if (existing) existing.associationEnabled = undefined;
        else {
          const added = { ...source };
          observations.push(added);
          byDocument.set(documentKey(source.receipt), added);
        }
      }
    const changes = decodeReceiptReviewChanges(reviewChanges);
    const reviews = prepareReceiptReviews(before.reviews ?? [], changes, observations, {
      userId,
      importGeneration: generation,
      createdAt: new Date().toISOString(),
    });
    const after = this.plan({
      ...before,
      ...(reviews.length ? { reviews } : {}),
      observations,
      coverage: [
        ...before.coverage.filter(
          (c) =>
            !staged.batches.some((batch) =>
              batch.coverage.some((span) => span.batchId === c.batchId),
            ),
        ),
        ...staged.batches.flatMap((batch) => batch.coverage),
      ].sort((a, b) => (a.batchId ?? '').localeCompare(b.batchId ?? '')),
    });
    const changedIds = new Set(changes.map((review) => review.id));
    if (
      after.receipts.some((receipt) =>
        receipt.resolution?.reconciliation?.invalidReviewIds?.some((id) => changedIds.has(id)),
      )
    )
      throw new ConflictError(
        'RECEIPT_REVIEW_CONFLICT',
        'Review conflicts with source identity, currency, or another decision',
      );
    return { after, staged };
  }
  async apply(
    tx: DatabaseQueryExecutor,
    userId: string,
    before: ReconciliationSnapshot,
    after: ReconciliationSnapshot,
    guard: () => Promise<void>,
  ): Promise<void> {
    await guard();
    const priorSources = new Map(before.observations.map((o) => [o.id, o]));
    const nextSourceIds = new Set(after.observations.map((o) => o.id));
    if (before.observations.some((o) => !nextSourceIds.has(o.id)))
      throw new Error('A projection change cannot discard source evidence');
    for (const source of after.observations) {
      const prior = priorSources.get(source.id);
      if (
        source.receipt.userId !== userId ||
        (prior && documentKey(prior.receipt) !== documentKey(source.receipt))
      )
        throw new Error('A projection change cannot replace source evidence');
    }
    if (after.receipts.some((r) => r.userId !== userId))
      throw new Error('Projection spans multiple accounts');
    await appendReceiptReviews(tx, userId, before.reviews ?? [], after.reviews ?? []);
    const events = new ReceiptOrderEventStore();
    await events.clear(tx, userId);
    // Clear uniqueness claims before reassigning/splitting canonical identities.
    await tx.query('UPDATE receipts SET external_id=NULL WHERE user_id=$1', [userId]);
    for (const r of after.receipts) await this.write(tx, r);
    for (const o of after.observations) {
      await tx.query(
        `INSERT INTO receipt_observations(id,user_id,receipt_id,document_key,import_generation,parser_version,payload,association_enabled,last_receipt_id)
        VALUES($1,$2,$3,$4,(SELECT import_generation FROM users WHERE id=$2),$6,$5::jsonb,$7,$8)
        ON CONFLICT(id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,association_enabled=EXCLUDED.association_enabled,
          last_receipt_id=COALESCE(EXCLUDED.last_receipt_id,receipt_observations.receipt_id,receipt_observations.last_receipt_id)`,
        [
          o.id,
          userId,
          o.receiptId ?? null,
          documentKey(o.receipt),
          JSON.stringify(o.receipt),
          o.receipt.resolution?.orderEvidence?.parserVersion ?? 2,
          o.associationEnabled !== false,
          o.receiptId ?? o.lastReceiptId ?? null,
        ],
      );
      const prior = priorSources.get(o.id);
      const old = prior?.receiptId ?? prior?.lastReceiptId;
      if (old && old !== o.receiptId && prior?.receiptId !== o.receiptId)
        await tx.query(
          `INSERT INTO receipt_reconciliation_lineage(id,user_id,old_receipt_id,new_receipt_id,policy_version,observation_ids) VALUES($1,$2,$3,$4,$5,$6::uuid[])`,
          [randomUUID(), userId, old, o.receiptId ?? null, this.policyVersion, [o.id]],
        );
    }
    const keep = after.receipts.map((r) => r.id!);
    await tx.query('DELETE FROM receipts WHERE user_id=$1 AND NOT (id=ANY($2::uuid[]))', [
      userId,
      keep,
    ]);
    await tx.query(
      'UPDATE receipt_import_batches SET association_enabled=(id=ANY($2::text[])) WHERE user_id=$1',
      [userId, after.coverage.map((c) => c.batchId).filter((id): id is string => !!id)],
    );
    await events.write(tx, userId, after.receipts, after.observations);
    await guard();
  }
  async ingest(
    tx: DatabaseQueryExecutor,
    incoming: readonly ReceiptWriteCommand[],
    guard: () => Promise<void>,
    batch?: { id: string; rejected: number },
    accounting?: ReceiptImportAccounting,
  ) {
    if (!incoming.length)
      return { newOrders: 0, updatedOrders: 0, unchangedOrders: 0, unresolvedOrders: 0 };
    const userId = incoming[0].userId;
    if (incoming.some((r) => r.userId !== userId)) throw new Error('Receipt batch spans users');
    await guard();
    const before = await this.load(tx, userId);
    // Clone membership: planning must never mutate the original snapshot used for lineage/rollback.
    const staged: ReconciliationSnapshot = {
      ...before,
      observations: before.observations.map((o) => ({ ...o })),
    };
    for (const r of before.receipts)
      if (!staged.observations.some((o) => o.receiptId === r.id))
        staged.observations.push({ id: randomUUID(), receiptId: r.id, receipt: r });
    const byDocument = new Map(staged.observations.map((o) => [documentKey(o.receipt), o]));
    const incomingIds = new Set<string>();
    for (const r of incoming) {
      const key = documentKey(r);
      const old = byDocument.get(key);
      if (old) {
        incomingIds.add(old.id);
        continue;
      }
      const observation = { id: randomUUID(), receipt: r };
      staged.observations.push(observation);
      incomingIds.add(observation.id);
      byDocument.set(key, observation);
    }
    let batchId: string | undefined;
    if (incoming[0].dataSource === DataSource.CSV) {
      const dates = incoming.map((r) => r.orderDate!.toISOString()).sort();
      batchId = batch?.id ?? evidenceFingerprint(incoming.map(documentKey).sort());
      await tx.query(
        `INSERT INTO receipt_import_batches(id,user_id,provider,observed_start,observed_end,accepted_orders,rejected_records)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,id) DO NOTHING`,
        [
          batchId,
          userId,
          incoming[0].receiptType,
          dates[0],
          dates[dates.length - 1],
          incoming.length,
          batch?.rejected ?? 0,
        ],
      );
      staged.coverage = (await this.load(tx, userId)).coverage;
    }
    const after = this.plan(staged);
    const touched = after.receipts.filter((r) =>
      r.resolution?.reconciliation?.observationIds.some((id) => incomingIds.has(id)),
    );
    const oldById = new Map(before.receipts.map((r) => [r.id, r]));
    const newOrders = touched.filter((r) => !oldById.has(r.id)).length;
    const updatedOrders = touched.filter(
      (r) => oldById.has(r.id) && evidenceFingerprint(r) !== evidenceFingerprint(oldById.get(r.id)),
    ).length;
    if (evidenceFingerprint(before) !== evidenceFingerprint(after))
      await this.apply(tx, userId, before, after, guard);
    if (batchId)
      await tx.query(
        'UPDATE receipt_observations SET batch_id=COALESCE(batch_id,$3) WHERE user_id=$1 AND id=ANY($2::uuid[])',
        [userId, [...incomingIds], batchId],
      );
    await tx.query(
      `INSERT INTO user_experience_state(user_id,setup_completed_at,setup_completion_method) VALUES($1,NOW(),$2)
      ON CONFLICT(user_id) DO UPDATE SET setup_completed_at=COALESCE(user_experience_state.setup_completed_at,NOW()),updated_at=NOW()`,
      [userId, incoming[0].dataSource === DataSource.CSV ? 'provider_archive' : 'email_receipts'],
    );
    if (accounting) {
      if (this.policyVersion !== 3)
        throw new Error('Canonical import outcomes require receipt policy 3');
      await new ReceiptImportOutcomeStore().record(
        tx,
        userId,
        accounting,
        before.receipts,
        after.receipts,
        [...incomingIds],
      );
    }
    await guard();
    return {
      newOrders,
      updatedOrders,
      unchangedOrders: touched.length - newOrders - updatedOrders,
      unresolvedOrders: after.receipts.filter(
        (r) => r.resolution?.reconciliation?.status === 'unresolved',
      ).length,
    };
  }
  async repair(
    tx: DatabaseQueryExecutor,
    userId: string,
    generation: number,
    mode: 'prepare' | 'publish' | 'rollback',
    guard: () => Promise<void>,
    manifestId?: string,
    stagedBatchIds: readonly string[] = [],
    reviewChanges: readonly ReceiptReviewChange[] = [],
  ) {
    await guard();
    if (mode !== 'prepare' && (reviewChanges.length || stagedBatchIds.length))
      throw new ConflictError(
        'REPAIR_MANIFEST_REQUIRED',
        'Publication and rollback use only saved manifest inputs',
      );
    if (mode !== 'prepare' && !manifestId)
      throw new ConflictError(
        'REPAIR_MANIFEST_REQUIRED',
        'Publication and rollback require an explicit repair manifest',
      );
    const user = await tx.query<{ import_generation: number }>(
      'SELECT import_generation FROM users WHERE id=$1 FOR UPDATE',
      [userId],
    );
    if (Number(user.rows[0]?.import_generation) !== generation)
      throw new ConflictError('REPAIR_GENERATION_STALE', 'Receipt repair generation is stale');
    const before = await this.load(tx, userId);
    const sources = new ReceiptRepairSourceStore();
    if (mode === 'prepare') {
      const { after, staged } = await this.planRepair(
        tx,
        userId,
        generation,
        before,
        stagedBatchIds,
        reviewChanges,
      );
      const id = randomUUID();
      await tx.query(
        `INSERT INTO receipt_repair_manifests(id,user_id,import_generation,policy_version,before_fingerprint,before_state,after_state,parser_version,staged_batch_ids,staged_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::uuid[],$10)`,
        [
          id,
          userId,
          generation,
          this.policyVersion,
          evidenceFingerprint(before),
          JSON.stringify(before),
          JSON.stringify(after),
          CURRENT_UBER_EXPORT_PARSER_VERSION,
          [...stagedBatchIds].sort(),
          staged.fingerprint,
        ],
      );
      await guard();
      return {
        orders: after.receipts.length,
        changed: before.receipts.length - after.receipts.length,
        legacy: before.receipts.filter(
          (r) => !before.observations.some((o) => o.receiptId === r.id),
        ).length,
        mode,
        manifestId: id,
      };
    }
    const row = (
      await tx.query<{
        id: string;
        before_state: unknown;
        after_state: unknown;
        before_fingerprint: string;
        after_fingerprint: string;
        import_generation: number;
        policy_version: number;
        status: string;
        parser_version: number;
        staged_batch_ids: string[];
        staged_fingerprint: string | null;
        expired: boolean;
      }>(
        `SELECT *,expires_at<=NOW() AS expired FROM receipt_repair_manifests WHERE user_id=$1 AND id=$2 FOR UPDATE`,
        [userId, manifestId],
      )
    ).rows[0];
    if (
      !row ||
      row.import_generation !== generation ||
      row.policy_version !== this.policyVersion ||
      row.parser_version !== CURRENT_UBER_EXPORT_PARSER_VERSION
    )
      throw new ConflictError('REPAIR_MANIFEST_INELIGIBLE', 'No eligible repair manifest');
    // A job can retry after commit but before acknowledging completion or invalidating caches.
    if (
      row.status === (mode === 'publish' ? 'published' : 'rolled_back') &&
      evidenceFingerprint(before) === row.after_fingerprint
    ) {
      return { orders: before.receipts.length, changed: 0, legacy: 0, mode, manifestId: row.id };
    }
    if (row.status !== (mode === 'publish' ? 'prepared' : 'published'))
      throw new ConflictError('REPAIR_MANIFEST_INELIGIBLE', 'No eligible repair manifest');
    if (
      evidenceFingerprint(before) !==
      (mode === 'publish' ? row.before_fingerprint : row.after_fingerprint)
    )
      throw new ConflictError(
        'REPAIR_EVIDENCE_CHANGED',
        'Receipt evidence changed; prepare a fresh repair',
      );
    if (mode === 'publish') {
      if (row.expired)
        throw new ConflictError(
          'REPAIR_MANIFEST_EXPIRED',
          'Repair manifest expired; prepare a fresh repair',
        );
      const staged = await sources.load(tx, userId, generation, row.staged_batch_ids);
      if (staged.fingerprint !== row.staged_fingerprint)
        throw new ConflictError(
          'REPAIR_SOURCE_CHANGED',
          'Staged evidence changed; prepare a fresh repair',
        );
      await sources.activateCoverage(tx, userId, staged.batches);
    }
    const target = decodeSnapshot(mode === 'publish' ? row.after_state : row.before_state);
    // Rollback retains any legacy observations introduced by publish as immutable evidence.
    if (mode === 'rollback')
      for (const o of before.observations)
        if (!target.observations.some((p) => p.id === o.id)) {
          const original = target.receipts.find((r) => documentKey(r) === documentKey(o.receipt));
          target.observations.push({
            ...o,
            receiptId: original?.id,
            associationEnabled: original ? undefined : false,
            lastReceiptId: original ? undefined : (o.receiptId ?? o.lastReceiptId),
          });
        }
    if (mode === 'rollback' && before.reviews?.length)
      target.reviews = compensateReceiptReviews(
        target.reviews ?? [],
        before.reviews,
        target.observations,
        {
          userId,
          importGeneration: generation,
          createdAt: new Date().toISOString(),
          manifestId: row.id,
          createId: randomUUID,
        },
      );
    await this.apply(tx, userId, before, target, guard);
    const after = await this.load(tx, userId);
    await tx.query(
      `UPDATE receipt_repair_manifests SET status=$2,after_fingerprint=COALESCE($3,after_fingerprint),
      published_at=CASE WHEN $2='published' THEN NOW() ELSE published_at END,rolled_back_at=CASE WHEN $2='rolled_back' THEN NOW() ELSE rolled_back_at END WHERE id=$1`,
      [row.id, mode === 'publish' ? 'published' : 'rolled_back', evidenceFingerprint(after)],
    );
    await guard();
    return {
      orders: after.receipts.length,
      changed: before.receipts.length - after.receipts.length,
      legacy: 0,
      mode,
      manifestId: row.id,
    };
  }
}
function decodeSnapshot(value: unknown): ReconciliationSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid receipt repair snapshot');
  const s = value as ReconciliationSnapshot;
  if (
    !Array.isArray(s.receipts) ||
    !Array.isArray(s.observations) ||
    !Array.isArray(s.coverage) ||
    typeof s.timezone !== 'string' ||
    (s.reviews !== undefined && !Array.isArray(s.reviews))
  )
    throw new Error('Invalid receipt repair snapshot');
  return {
    ...s,
    ...(s.reviews === undefined ? {} : { reviews: s.reviews.map(decodeReceiptReview) }),
    receipts: s.receipts.map((r) => decodeReceiptObservation(r, r.id)),
    observations: s.observations.map((o) => ({
      ...o,
      receipt: decodeReceiptObservation(o.receipt),
    })),
  };
}
