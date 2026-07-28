'use strict';

// Preview calculations deliberately operate only on a caller-supplied complete
// facts-cache entry. They must remain free of provider clients, credentials,
// and network access: a stale cache is useful, a missing/incompatible cache is
// unavailable rather than an excuse to make a best-effort count.

const { evaluateFilterV2, selectedDimensionIds } = require('./filterEngine');

function compareBatchIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right));
}

function sameBatchId(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right);
}

function validCacheEntry(cacheEntry, churchId, provider) {
  if (!cacheEntry || cacheEntry.churchId !== churchId || cacheEntry.provider !== provider || !Array.isArray(cacheEntry.facts)) {
    return false;
  }
  const expiresAt = Date.parse(cacheEntry.expiresAt);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function snapshotFor(cacheEntry) {
  return {
    id: cacheEntry.snapshotId,
    capturedAt: cacheEntry.capturedAt,
    fresh: Boolean(cacheEntry.fresh),
    expiresAt: cacheEntry.expiresAt,
    coveredDimensionIds: [...new Set(cacheEntry.coveredDimensionIds || [])].sort(),
  };
}

function legacySelectedDimensionIds(batch, adapter) {
  if (Array.isArray(batch.selectedDimensionIds)) return batch.selectedDimensionIds;
  if (adapter && typeof adapter.selectedDimensionIdsForFilter === 'function') {
    return adapter.selectedDimensionIdsForFilter(batch.filterConfig, batch.filterSchemaVersion) || [];
  }
  if (adapter && typeof adapter.selectedDimensionIds === 'function') {
    return adapter.selectedDimensionIds(batch.filterConfig, batch.filterSchemaVersion) || [];
  }
  return [];
}

function selectedDimensionsForBatch(batch, adapter) {
  const dimensions = Number(batch && batch.filterSchemaVersion) === 2
    ? selectedDimensionIds(batch && batch.filterConfig)
    : legacySelectedDimensionIds(batch || {}, adapter);
  return [...new Set(dimensions.filter((dimensionId) => typeof dimensionId === 'string' && dimensionId))].sort();
}

function missingDimensions(batches, cacheEntry, adapter) {
  const covered = new Set(Array.isArray(cacheEntry && cacheEntry.coveredDimensionIds) ? cacheEntry.coveredDimensionIds : []);
  return [...new Set(batches.flatMap((batch) => selectedDimensionsForBatch(batch, adapter))
    .filter((dimensionId) => !covered.has(dimensionId)))].sort();
}

function eligibleIdsForBatch(batch, cacheEntry, adapter, { evaluateLegacy } = {}) {
  const facts = Array.isArray(cacheEntry && cacheEntry.facts) ? cacheEntry.facts : [];
  const schemaVersion = Number(batch && batch.filterSchemaVersion);
  if (schemaVersion === 1 && typeof evaluateLegacy !== 'function') {
    throw new TypeError('Schema-1 preview requires an evaluateLegacy collaborator.');
  }
  if (schemaVersion !== 1 && schemaVersion !== 2) return new Set();
  const ids = new Set();
  for (const factsForPerson of facts) {
    const externalPersonId = factsForPerson && factsForPerson.externalPersonId;
    if (typeof externalPersonId !== 'string' || !externalPersonId) continue;
    const eligible = schemaVersion === 2
      ? evaluateFilterV2(factsForPerson, batch.filterConfig)
      : evaluateLegacy(batch.provider || cacheEntry?.provider, factsForPerson, batch.filterConfig, adapter, batch);
    if (eligible === true) ids.add(externalPersonId);
  }
  return ids;
}

function intersectionCount(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function isNotOnlyFilter(batch) {
  const config = batch && batch.filterConfig;
  return Number(batch && batch.filterSchemaVersion) === 2
    && Array.isArray(config && config.branches) && config.branches.length === 0
    && Array.isArray(config && config.exclusions) && config.exclusions.length > 0;
}

function withinScope(batch, churchId, provider) {
  return batch && (!batch.provider || batch.provider === provider) && (!batch.churchId || batch.churchId === churchId);
}

function previewFilter({
  churchId, provider, batchId, proposed = {}, cacheEntry, batches = [], metadata, populationGateDigest,
  adapter = null, evaluateLegacy,
} = {}) {
  // `metadata` is intentionally accepted as a preview input so the route can
  // share one provider-neutral DTO. Count evaluation uses cache facts only.
  void metadata;
  const scopedBatches = (Array.isArray(batches) ? batches : [])
    .filter((batch) => withinScope(batch, churchId, provider));
  const active = batchId === null || batchId === undefined
    ? null
    : scopedBatches.find((batch) => sameBatchId(batch.id, batchId)) || null;
  const target = { ...active, ...proposed, id: proposed.id ?? active?.id ?? batchId, provider };
  const targetId = target.id;
  const otherBatches = scopedBatches.filter((batch) => !sameBatchId(batch.id, targetId));
  const unionBatches = [
    ...otherBatches.filter((batch) => batch.enabled),
    ...(target.enabled ? [target] : []),
  ];
  const cacheUsable = validCacheEntry(cacheEntry, churchId, provider)
    && cacheEntry.populationGateDigest === populationGateDigest;
  const targetMissingDimensionIds = missingDimensions([target], cacheEntry, adapter);
  const unionMissingDimensionIds = missingDimensions(unionBatches, cacheEntry, adapter);
  const missingDimensionIds = [...new Set([...targetMissingDimensionIds, ...unionMissingDimensionIds])].sort();
  const result = {
    matchCount: null,
    snapshot: cacheUsable ? snapshotFor(cacheEntry) : null,
    overlaps: [],
    uniqueEnabledPopulationCount: null,
    missingDimensionIds,
    warnings: [],
  };

  if (!cacheUsable || targetMissingDimensionIds.length > 0) {
    if (isNotOnlyFilter(target)) result.warnings.push('BROAD_FILTER');
    result.warnings.sort();
    return result;
  }

  const targetIds = eligibleIdsForBatch(target, cacheEntry, adapter, { evaluateLegacy });
  result.matchCount = targetIds.size;
  const otherEnabled = otherBatches.filter((batch) => batch.enabled);
  if (unionMissingDimensionIds.length === 0) {
    const union = new Set();
    for (const batch of unionBatches) {
      for (const externalPersonId of eligibleIdsForBatch(batch, cacheEntry, adapter, { evaluateLegacy })) union.add(externalPersonId);
    }
    result.uniqueEnabledPopulationCount = union.size;
  }

  for (const batch of otherEnabled) {
    const overlapMissing = missingDimensions([batch], cacheEntry, adapter);
    if (overlapMissing.length > 0) continue;
    const count = intersectionCount(targetIds, eligibleIdsForBatch(batch, cacheEntry, adapter, { evaluateLegacy }));
    result.overlaps.push({ batchId: batch.id, batchName: batch.name, count });
    if (count > 0 && target.gatheringTypeId !== batch.gatheringTypeId) result.warnings.push('OVERLAP_GATHERING_TYPE');
    if (count > 0 && target.defaultPeopleType !== batch.defaultPeopleType) result.warnings.push('OVERLAP_DEFAULT_PEOPLE_TYPE');
  }
  result.overlaps.sort((left, right) => compareBatchIds(left.batchId, right.batchId));
  if (isNotOnlyFilter(target) || (cacheEntry.facts.length > 0 && targetIds.size === cacheEntry.facts.length)) {
    result.warnings.push('BROAD_FILTER');
  }
  result.warnings = [...new Set(result.warnings)].sort();
  return result;
}

module.exports = { previewFilter, eligibleIdsForBatch };
