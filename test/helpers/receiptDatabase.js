const assert = require('node:assert/strict');
// Transactional SQL-port fixture. Unknown/destructive SQL fails rather than being ignored.
function database() {
  let state = {
    receipts: [],
    observations: [],
    batches: [],
    lineage: [],
    orderEvents: [],
    eventObservations: [],
  };
  const query = async (sql, p = []) => {
    // Published review mutations are covered against PostgreSQL, not emulated here.
    if (sql.startsWith('SELECT r.* FROM receipt_association_reviews')) return { rows: [] };
    if (sql.startsWith('SELECT import_generation')) return { rows: [{ import_generation: 1 }] };
    if (sql.startsWith('SELECT timezone')) return { rows: [{ timezone: 'America/Toronto' }] };
    if (sql.startsWith('SELECT id,receipt_id,payload'))
      return {
        rows: state.observations
          .filter((o) => o.user_id === p[0])
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    if (sql.startsWith('SELECT provider,COALESCE'))
      return {
        rows: state.batches
          .filter((b) => b.user_id === p[0] && b.association_enabled !== false)
          .map((b) => ({ ...b, batch_id: b.id }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    if (sql.startsWith('INSERT INTO receipt_import_batches')) {
      if (!state.batches.some((b) => b.id === p[0] && b.user_id === p[1]))
        state.batches.push({
          id: p[0],
          user_id: p[1],
          provider: p[2],
          start: p[3],
          end: p[4],
          quality: 'observed',
          incomplete: p[6] > 0,
        });
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE receipt_import_batches SET association_enabled=')) {
      for (const batch of state.batches)
        if (batch.user_id === p[0]) batch.association_enabled = p[1].includes(batch.id);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM receipt_order_events')) {
      state.orderEvents = state.orderEvents.filter((event) => event[0] !== p[0]);
      state.eventObservations = state.eventObservations.filter((event) => event[0] !== p[0]);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO receipt_order_events(')) {
      state.orderEvents.push(p);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO receipt_order_event_observations(')) {
      state.eventObservations.push(p);
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE receipt_observations SET batch_id=')) {
      for (const o of state.observations)
        if (o.user_id === p[0] && p[1].includes(o.id)) o.batch_id ??= p[2];
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE receipts SET external_id=NULL')) {
      for (const r of state.receipts) if (r.user_id === p[0]) r.external_id = null;
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO receipt_reconciliation_lineage')) {
      state.lineage.push(p);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM receipts WHERE user_id=$1 AND NOT')) {
      state.receipts = state.receipts.filter((r) => r.user_id !== p[0] || p[1].includes(r.id));
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM receipts'))
      return { rows: state.receipts.filter((r) => r.user_id === p[0]) };
    if (sql.startsWith('SELECT receipt_id FROM receipt_observations'))
      return {
        rows: state.observations.filter((o) => o.user_id === p[0] && o.document_key === p[1]),
      };
    if (sql.startsWith('SELECT payload FROM receipt_observations'))
      return { rows: state.observations.filter((o) => o.receipt_id === p[0]) };
    if (sql.startsWith('INSERT INTO receipts(')) {
      const fields = [
        'id',
        'user_id',
        'receipt_type',
        'data_source',
        'restaurant_name',
        'order_date',
        'amount_spent',
        'items',
        'delivery_time',
        'external_id',
        'currency_code',
        'subtotal_amount',
        'tax_amount',
        'tip_amount',
        'delivery_fee_amount',
        'service_fee_amount',
        'savings_amount',
        'resolution',
      ];
      const row = Object.fromEntries(
        fields.map((f, i) => [f, ['items', 'resolution'].includes(f) ? JSON.parse(p[i]) : p[i]]),
      );
      state.receipts = state.receipts.filter((r) => r.id !== row.id).concat(row);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO receipt_observations(')) {
      const old = state.observations.find((o) => o.id === p[0]);
      if (old) {
        old.receipt_id = p[2];
        old.association_enabled = p[6];
        old.last_receipt_id = p[7] ?? old.receipt_id ?? old.last_receipt_id;
      } else
        state.observations.push({
          id: p[0],
          user_id: p[1],
          receipt_id: p[2],
          document_key: p[3],
          payload: JSON.parse(p[4]),
          association_enabled: p[6],
          last_receipt_id: p[7],
        });
      return { rows: [] };
    }
    if (
      sql === 'UPDATE receipt_observations SET receipt_id=$1 WHERE receipt_id=$2 AND user_id=$3'
    ) {
      for (const o of state.observations)
        if (o.receipt_id === p[1] && o.user_id === p[2]) o.receipt_id = p[0];
      return { rows: [] };
    }
    if (sql === 'DELETE FROM receipts WHERE id=$1 AND user_id=$2') {
      assert.equal(
        state.observations.some((o) => o.receipt_id === p[0]),
        false,
        'move evidence before deleting a duplicate projection',
      );
      state.receipts = state.receipts.filter((r) => r.id !== p[0] || r.user_id !== p[1]);
      return { rows: [] };
    }
    if (
      sql.startsWith('INSERT INTO user_experience_state') ||
      sql.startsWith('DELETE FROM receipt_projection_revisions')
    )
      return { rows: [] };
    throw Error(`Unexpected SQL: ${sql}`);
  };
  return {
    query,
    withTransaction: async (fn) => {
      const before = structuredClone(state);
      try {
        return await fn({ query });
      } catch (e) {
        state = before;
        throw e;
      }
    },
    get state() {
      return state;
    },
  };
}
module.exports = { database };
