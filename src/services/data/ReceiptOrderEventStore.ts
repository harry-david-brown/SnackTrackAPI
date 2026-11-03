import { writeDatabaseBatches } from './DatabaseBatchWriter';
import type { Receipt } from '../../models/Receipt';
import type { DatabaseQueryExecutor } from '../ports/DatabasePort';
import type { SourceObservation } from '../receipt/ReceiptGroupReconciler';

/** Transactional read projection only. Financial decisions belong to OrderFinancialResolver. */
export class ReceiptOrderEventStore {
  async clear(tx: DatabaseQueryExecutor, userId: string): Promise<void> {
    // Remove links before observation reassociation; the full projection is rebuilt below.
    await tx.query('DELETE FROM receipt_order_events WHERE user_id=$1', [userId]);
  }

  async write(
    tx: DatabaseQueryExecutor,
    userId: string,
    receipts: readonly Receipt[],
    observations: readonly SourceObservation[],
  ): Promise<void> {
    const eventRows: unknown[][] = [];
    const sourceRows: unknown[][] = [];
    const byId = new Map(observations.map((o) => [o.id, o]));
    for (const receipt of receipts) {
      if (receipt.userId !== userId || !receipt.id)
        throw new Error('Invalid event projection owner');
      for (const event of receipt.resolution?.orderOutcome?.events ?? []) {
        const sources = [...new Set(event.observationIds)].map((id) => {
          const source = byId.get(id);
          if (
            !source ||
            source.receipt.userId !== userId ||
            source.receiptId !== receipt.id ||
            source.associationEnabled === false
          )
            throw new Error('Financial event refers to evidence outside its canonical order');
          return source;
        });
        if (!sources.length) throw new Error('Financial event is missing source evidence');
        // Updated receipts often repeat the original charge time on a refund row.
        // Preserve it in payload, but never present it as the time the refund occurred.
        const timestamp = event.timestamp;
        const occurredAt =
          timestamp?.precision !== 'day' &&
          (event.kind === 'charge' ? timestamp?.role === 'payment' : timestamp?.role === 'refund')
            ? timestamp?.instant
            : undefined;
        const reportedTimes = sources
          .map((source) => source.receipt.resolution?.sourceRevisionAt)
          .filter(
            (time): time is string => typeof time === 'string' && Number.isFinite(Date.parse(time)),
          )
          .sort((a, b) => Date.parse(a) - Date.parse(b));
        eventRows.push([
          userId,
          receipt.id,
          event.key,
          event.kind,
          event.amount,
          event.currencyCode ?? receipt.monetaryDetails?.currencyCode ?? 'UNKNOWN',
          event.confidence,
          occurredAt ?? null,
          reportedTimes[0] ?? null,
          JSON.stringify(event),
        ]);
        for (const source of sources)
          sourceRows.push([userId, receipt.id, event.key, source.id]);
      }
    }
    // Parent events precede their evidence links; the caller owns rollback.
    await writeDatabaseBatches(tx, eventRows, (parameters) =>
      `INSERT INTO receipt_order_events(user_id,receipt_id,event_key,kind,amount,currency_code,confidence,occurred_at,reported_at,payload)
       VALUES ${parameters.map((p) => `(${p.join(',')})`).join(',')}`);
    await writeDatabaseBatches(tx, sourceRows, (parameters) =>
      `INSERT INTO receipt_order_event_observations(user_id,receipt_id,event_key,observation_id)
       VALUES ${parameters.map((p) => `(${p.join(',')})`).join(',')}`);
  }
}
