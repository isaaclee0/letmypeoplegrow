'use strict';

// Preview calculations deliberately operate only on a caller-supplied complete
// facts-cache entry. They must remain free of provider clients, credentials,
// and network access: a stale cache is useful, a missing/incompatible cache is
// unavailable rather than an excuse to make a best-effort count.

const { evaluateFilterV2, selectedDimensionIds } = require('./filterEngine');
const { validatePcoFilter } = require('./pcoAdapter');
const { validateElvantoFilter } = require('../elvanto/filter');

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

function selection(values, dimensionId) {
  return Array.isArray(values) && values.length > 0 ? [dimensionId] : [];
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasExactElvantoV1Envelope(config) {
  if (!hasExactKeys(config, [
    'statuses', 'categoryIds', 'groups', 'demographics', 'departments', 'serviceTypes', 'locations', 'customFields',
  ])) return false;
  const selections = [
    ['groups', 'ids'],
    ['demographics', 'values'],
    ['departments', 'values'],
    ['serviceTypes', 'ids'],
    ['locations', 'ids'],
  ];
  if (!selections.every(([property, valuesProperty]) => hasExactKeys(config[property], [valuesProperty, 'operator']))) {
    return false;
  }
  return Array.isArray(config.customFields) && config.customFields.every((field) =>
    hasExactKeys(field, ['fieldId', 'values', 'operator']));
}

function hasExactPlanningCenterV1Envelope(config) {
  return hasExactKeys(config, [
    'membershipFilterEnabled', 'membershipAllowlist', 'fieldFilterEnabled', 'fieldFilters',
  ]) && Array.isArray(config.fieldFilters) && config.fieldFilters.every((field) =>
    hasExactKeys(field, ['fieldDefinitionId', 'values']));
}

function elvantoV1SelectedDimensionIds(config) {
  if (!hasExactElvantoV1Envelope(config)) return null;
  const validation = validateElvantoFilter(config);
  if (!validation.ok) return null;
  const valid = validation.value;
  const selections = [
    ['groups', 'ids', 'groups'],
    ['demographics', 'values', 'demographics'],
    ['departments', 'values', 'departments'],
    ['serviceTypes', 'ids', 'service_types'],
    ['locations', 'ids', 'locations'],
  ];
  const dimensions = ['status', ...selection(valid.categoryIds, 'category')];
  for (const [property, valuesProperty, dimensionId] of selections) {
    const selected = valid[property];
    dimensions.push(...selection(selected[valuesProperty], dimensionId));
  }
  for (const field of valid.customFields) {
    dimensions.push(...selection(field.values, `custom_field:${field.fieldId}`));
  }
  return dimensions;
}

function planningCenterV1SelectedDimensionIds(config) {
  if (!hasExactPlanningCenterV1Envelope(config)) return null;
  const validation = validatePcoFilter(config);
  if (!validation.ok) return null;
  const valid = validation.value;
  const dimensions = valid.membershipFilterEnabled ? selection(valid.membershipAllowlist, 'membership') : [];
  if (!valid.fieldFilterEnabled) return dimensions;
  for (const field of valid.fieldFilters) {
    if (!field || typeof field !== 'object' || Array.isArray(field) ||
        typeof field.fieldDefinitionId !== 'string' || !field.fieldDefinitionId || !Array.isArray(field.values)) return null;
    dimensions.push(...selection(field.values, `custom_field:${field.fieldDefinitionId}`));
  }
  return dimensions;
}

function coverageForBatch(batch) {
  const schemaVersion = Number(batch && batch.filterSchemaVersion);
  if (schemaVersion === 2) return { known: true, dimensionIds: selectedDimensionIds(batch && batch.filterConfig) };
  if (schemaVersion !== 1) return { known: false, dimensionIds: [] };
  const dimensionIds = batch.provider === 'elvanto'
    ? elvantoV1SelectedDimensionIds(batch.filterConfig)
    : batch.provider === 'planning_center'
      ? planningCenterV1SelectedDimensionIds(batch.filterConfig)
      : null;
  return dimensionIds === null ? { known: false, dimensionIds: [] } : { known: true, dimensionIds };
}

function coverageForBatches(batches, cacheEntry) {
  const covered = new Set(Array.isArray(cacheEntry && cacheEntry.coveredDimensionIds) ? cacheEntry.coveredDimensionIds : []);
  const coverage = batches.map(coverageForBatch);
  return {
    known: coverage.every((item) => item.known),
    missingDimensionIds: [...new Set(coverage.flatMap((item) => item.dimensionIds)
      .filter((dimensionId) => !covered.has(dimensionId)))].sort(),
  };
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
    .filter((batch) => withinScope(batch, churchId, provider))
    .map((batch) => ({ ...batch, provider: batch.provider || provider }));
  const editing = batchId !== null && batchId !== undefined;
  const active = !editing
    ? null
    : scopedBatches.find((batch) => sameBatchId(batch.id, batchId)) || null;
  const { id: ignoredProposedId, ...proposedFields } = proposed;
  void ignoredProposedId;
  const targetId = editing ? active?.id ?? batchId : Symbol('new-filter-preview');
  const target = { ...active, ...proposedFields, id: targetId, provider };
  const otherBatches = editing
    ? scopedBatches.filter((batch) => !sameBatchId(batch.id, targetId))
    : scopedBatches;
  const unionBatches = [
    ...otherBatches.filter((batch) => batch.enabled),
    ...(target.enabled ? [target] : []),
  ];
  const cacheUsable = validCacheEntry(cacheEntry, churchId, provider)
    && cacheEntry.populationGateDigest === populationGateDigest;
  const targetCoverage = coverageForBatches([target], cacheEntry);
  const unionCoverage = coverageForBatches(unionBatches, cacheEntry);
  const missingDimensionIds = [...new Set([
    ...targetCoverage.missingDimensionIds,
    ...unionCoverage.missingDimensionIds,
  ])].sort();
  const result = {
    matchCount: null,
    snapshot: cacheUsable ? snapshotFor(cacheEntry) : null,
    overlaps: [],
    uniqueEnabledPopulationCount: null,
    missingDimensionIds,
    warnings: [],
  };

  if (!cacheUsable || !targetCoverage.known || targetCoverage.missingDimensionIds.length > 0) {
    if (isNotOnlyFilter(target)) result.warnings.push('BROAD_FILTER');
    result.warnings.sort();
    return result;
  }

  const targetIds = eligibleIdsForBatch(target, cacheEntry, adapter, { evaluateLegacy });
  result.matchCount = targetIds.size;
  const otherEnabled = otherBatches.filter((batch) => batch.enabled);
  if (unionCoverage.known && unionCoverage.missingDimensionIds.length === 0) {
    const union = new Set();
    for (const batch of unionBatches) {
      for (const externalPersonId of eligibleIdsForBatch(batch, cacheEntry, adapter, { evaluateLegacy })) union.add(externalPersonId);
    }
    result.uniqueEnabledPopulationCount = union.size;
  }

  for (const batch of otherEnabled) {
    const overlapCoverage = coverageForBatches([batch], cacheEntry);
    if (!overlapCoverage.known || overlapCoverage.missingDimensionIds.length > 0) continue;
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
