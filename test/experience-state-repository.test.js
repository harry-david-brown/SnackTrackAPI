const test = require('node:test');
const assert = require('node:assert/strict');
const { ExperienceStateRepository } = require('../dist/services/data/ExperienceStateRepository');

test('experience state uses the canonical import_jobs trigger_type column', async () => {
  const calls = [];
  const repository = new ExperienceStateRepository({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [{
          receipt_count: 0,
          setup_completed_at: null,
          setup_completion_method: null,
          first_recap_seen_at: null,
          active_operation_id: null,
        }],
        rowCount: 1,
      };
    },
  });

  const state = await repository.get('00000000-0000-4000-8000-000000000001');
  assert.equal(state.setup.state, 'required');
  assert.match(calls[0].sql, /trigger_type='user'/);
  assert.doesNotMatch(calls[0].sql, /\btrigger='user'/);
});
