const authority = require('./authority');
const batches = require('./batchRepository');

// Presentation only: expose mappings solely for gatherings the caller may see.
async function gatheringSources(churchId, gatheringIds, deps = { authority, batches }) {
  const result = new Map();
  const { active } = await deps.authority.getAuthority(churchId);
  if (!['planning_center', 'elvanto'].includes(active)) return result;
  const allowed = new Set(gatheringIds.map(Number));
  for (const batch of await deps.batches.listBatches(churchId, active)) {
    if (!batch.enabled || !batch.source || !allowed.has(Number(batch.gatheringTypeId))) continue;
    const id = Number(batch.gatheringTypeId);
    const sources = result.get(id) || [];
    sources.push({
      provider: active,
      sourceName: batch.source.name || batch.name,
      sourceKind: batch.source.kind,
      membershipMode: batch.gatheringAutoRemoveEnabled ? 'aligned' : 'add_only',
    });
    result.set(id, sources);
  }
  return result;
}

module.exports = { gatheringSources };
