const test = require('node:test');
const assert = require('node:assert/strict');
const { gatheringSources } = require('./gatheringSources');

test('returns only active-source mappings for authorized gatherings in the current church', async () => {
  const result = await gatheringSources('test_church', [7], {
    authority: { getAuthority: async (id) => { assert.equal(id, 'test_church'); return { active: 'planning_center' }; } },
    batches: { listBatches: async (id, provider) => {
      assert.equal(id, 'test_church');
      assert.equal(provider, 'planning_center');
      const base = { enabled: true, gatheringTypeId: 7, source: { kind: 'planning_center_list', name: 'Youth' }, gatheringAutoRemoveEnabled: true };
      return [base, { ...base, gatheringTypeId: 9 }, { ...base, enabled: false }, { ...base, source: null }, { ...base, gatheringAutoRemoveEnabled: false }];
    } },
  });
  assert.equal(result.size, 1);
  assert.deepEqual(result.get(7).map((source) => source.membershipMode), ['aligned', 'add_only']);
  assert.equal(result.get(7)[0].sourceName, 'Youth');
});

test('does not label a gathering provider-managed before authority activation', async () => {
  const result = await gatheringSources('test_church', [7], {
    authority: { getAuthority: async () => ({ active: 'none' }) },
    batches: { listBatches: async () => { throw new Error('Must not read inactive provider'); } },
  });
  assert.equal(result.size, 0);
});
