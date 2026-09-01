const test = require('node:test');
const assert = require('node:assert/strict');

const { parseQueryPlanRow } = require('../dist/services/monitoring/QueryPlanParser');

test('query-plan parser validates timing and finds nested indexes', () => {
  const result = parseQueryPlanRow({
    'QUERY PLAN': [
      {
        'Planning Time': 0.4,
        'Execution Time': 1.2,
        Plan: {
          'Node Type': 'Bitmap Heap Scan',
          'Actual Rows': 12,
          Plans: [
            {
              'Node Type': 'Bitmap Index Scan',
              'Index Name': 'receipts_items_gin_idx',
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.executionTimeMs, 1.2);
  assert.equal(result.rowsReturned, 12);
  assert.equal(result.indexUsed, true);
  assert.equal(result.indexName, 'receipts_items_gin_idx');
  assert.equal(result.ginItemsIndexUsed, true);
});

test('query-plan parser rejects malformed provider/database JSON', () => {
  assert.throws(
    () => parseQueryPlanRow({ 'QUERY PLAN': [{ 'Execution Time': 1 }] }),
    (error) => error.code === 'DATABASE_ERROR',
  );
  assert.throws(
    () =>
      parseQueryPlanRow({
        'QUERY PLAN': [
          {
            'Execution Time': 'not-a-number',
            'Planning Time': 1,
            Plan: { 'Actual Rows': 0 },
          },
        ],
      }),
    (error) => error.code === 'DATABASE_ERROR',
  );
});
