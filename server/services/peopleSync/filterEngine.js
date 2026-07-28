'use strict';

// The provider-neutral, schema-v2 filter authority. Provider adapters are
// responsible for projecting their records into the metadata/facts shapes
// consumed here; this module deliberately has no database or provider calls.

const EMPTY_V2_FILTER = Object.freeze({ branches: Object.freeze([]), exclusions: Object.freeze([]) });

const ROOT_KEYS = new Set(['branches', 'exclusions']);
const BRANCH_KEYS = new Set(['groups']);
const GROUP_KEYS = new Set(['dimensionId', 'mode', 'values']);
const EXCLUSION_KEYS = new Set(['dimensionId', 'values']);
const MODES = new Set(['any', 'all']);
const NOT_SET = '$not_set';
const LIMITS = Object.freeze({ branches: 20, groups: 50, values: 500 });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addError(errors, code, path, message) {
  errors.push({ code, path, message });
}

function pairKey(dimensionId, valueId) {
  return `${dimensionId}:${valueId}`;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalGroup(group) {
  return {
    dimensionId: group.dimensionId,
    mode: group.mode,
    values: [...group.values].sort(compareStrings),
  };
}

function canonicalExclusion(group) {
  return {
    dimensionId: group.dimensionId,
    values: [...group.values].sort(compareStrings),
  };
}

function groupSortKey(group) {
  return JSON.stringify([group.dimensionId, group.mode, group.values]);
}

function exclusionSortKey(group) {
  return JSON.stringify([group.dimensionId, group.values]);
}

function canonicalConfig(config) {
  const branches = config.branches
    .map((branch) => ({ groups: branch.groups.map(canonicalGroup).sort((a, b) => compareStrings(groupSortKey(a), groupSortKey(b))) }))
    .sort((a, b) => compareStrings(JSON.stringify(a.groups), JSON.stringify(b.groups)));
  const exclusions = config.exclusions.map(canonicalExclusion).sort((a, b) => compareStrings(exclusionSortKey(a), exclusionSortKey(b)));
  return { branches, exclusions };
}

function metadataIndex(metadata) {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.dimensions)) return null;
  const dimensions = new Map();
  for (const dimension of metadata.dimensions) {
    if (!isPlainObject(dimension) || typeof dimension.id !== 'string' || !Array.isArray(dimension.values)) return null;
    dimensions.set(dimension.id, {
      ...dimension,
      valuesById: new Map(dimension.values.filter(isPlainObject).filter((value) => typeof value.id === 'string').map((value) => [value.id, value])),
    });
  }
  return dimensions;
}

function allowedUnresolved(allowedPairs, dimensionId, valueId) {
  // The stable public representation is `${dimensionId}:${valueId}`. Also
  // accept pair objects/tuples to keep callers from having to encode IDs.
  const key = pairKey(dimensionId, valueId);
  if (allowedPairs.has(key)) return true;
  for (const pair of allowedPairs) {
    if (Array.isArray(pair) && pair[0] === dimensionId && pair[1] === valueId) return true;
    if (isPlainObject(pair) && pair.dimensionId === dimensionId && (pair.valueId === valueId || pair.value === valueId)) return true;
  }
  return false;
}

function validateKeys(value, allowedKeys, path, errors, code = 'UNKNOWN_KEY') {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) addError(errors, code, `${path}.${key}`, `Unknown filter key: ${key}`);
  }
}

function validateValues(values, path, errors) {
  if (!Array.isArray(values)) {
    addError(errors, 'MALFORMED_VALUE', path, 'Values must be an array of strings.');
    return null;
  }
  if (values.length === 0) addError(errors, 'EMPTY_GROUP', path, 'Groups must select at least one value.');
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string') {
      addError(errors, 'MALFORMED_VALUE', `${path}[${index}]`, 'Values must be strings.');
      continue;
    }
    if (seen.has(value)) addError(errors, 'DUPLICATE_VALUE', `${path}[${index}]`, 'Values may not contain duplicates.');
    seen.add(value);
  }
  return values.every((value) => typeof value === 'string') ? values : null;
}

function validateDimensionValues({ dimensionId, values, mode, path, index, allowedPairs, unresolved, errors }) {
  if (typeof dimensionId !== 'string' || dimensionId.length === 0) {
    addError(errors, 'MALFORMED_DIMENSION', `${path}.dimensionId`, 'dimensionId must be a non-empty string.');
    return;
  }
  const dimension = index.get(dimensionId);
  if (!dimension) {
    addError(errors, 'UNKNOWN_DIMENSION', `${path}.dimensionId`, `Unknown dimension: ${dimensionId}`);
    return;
  }
  if (mode === 'all' && dimension.cardinality === 'single') {
    addError(errors, 'SINGLE_DIMENSION_ALL', `${path}.mode`, 'Single-valued dimensions cannot use all.');
  }
  if (mode === 'all' && values && values.includes(NOT_SET) && values.length > 1) {
    addError(errors, 'NOT_SET_ALL_CONFLICT', `${path}.values`, '$not_set cannot be combined with another all value.');
  }
  for (const valueId of values || []) {
    if (!dimension.valuesById.has(valueId)) {
      if (allowedUnresolved(allowedPairs, dimensionId, valueId)) {
        unresolved.push({ dimensionId, valueId });
      } else {
        addError(errors, 'UNKNOWN_VALUE', `${path}.values`, `Unknown value ${valueId} for ${dimensionId}.`);
      }
    }
  }
}

function validateFilterV2(config, metadata, { allowedUnresolvedPairs = new Set() } = {}) {
  const errors = [];
  const unresolved = [];
  if (!isPlainObject(config)) {
    addError(errors, 'MALFORMED_FILTER', '', 'Filter config must be an object.');
    return { ok: false, value: null, errors, unresolved };
  }
  validateKeys(config, ROOT_KEYS, '', errors, 'UNKNOWN_ROOT_KEY');
  if (!Array.isArray(config.branches)) addError(errors, 'MALFORMED_BRANCHES', 'branches', 'branches must be an array.');
  if (!Array.isArray(config.exclusions)) addError(errors, 'MALFORMED_EXCLUSIONS', 'exclusions', 'exclusions must be an array.');
  if (!Array.isArray(config.branches) || !Array.isArray(config.exclusions)) return { ok: false, value: null, errors, unresolved };

  if (config.branches.length > LIMITS.branches) addError(errors, 'TOO_MANY_BRANCHES', 'branches', 'At most 20 branches are allowed.');
  const index = metadataIndex(metadata);
  if (!index) addError(errors, 'MALFORMED_METADATA', 'metadata', 'Filter metadata must contain dimensions and values.');
  const allowedPairs = allowedUnresolvedPairs instanceof Set ? allowedUnresolvedPairs : new Set();
  let groupCount = 0;
  let valueCount = 0;
  const positivePairs = new Set();
  const exclusionPairs = new Set();

  for (const [branchIndex, branch] of config.branches.entries()) {
    const branchPath = `branches[${branchIndex}]`;
    if (!isPlainObject(branch)) {
      addError(errors, 'MALFORMED_BRANCH', branchPath, 'Each branch must be an object.');
      continue;
    }
    validateKeys(branch, BRANCH_KEYS, branchPath, errors);
    if (!Array.isArray(branch.groups)) {
      addError(errors, 'MALFORMED_GROUPS', `${branchPath}.groups`, 'groups must be an array.');
      continue;
    }
    if (branch.groups.length === 0) addError(errors, 'EMPTY_BRANCH', `${branchPath}.groups`, 'Stored branches must not be empty.');
    groupCount += branch.groups.length;
    const seenDimensions = new Set();
    for (const [groupIndex, group] of branch.groups.entries()) {
      const path = `${branchPath}.groups[${groupIndex}]`;
      if (!isPlainObject(group)) {
        addError(errors, 'MALFORMED_GROUP', path, 'Each group must be an object.');
        continue;
      }
      validateKeys(group, GROUP_KEYS, path, errors);
      const values = validateValues(group.values, `${path}.values`, errors);
      valueCount += Array.isArray(group.values) ? group.values.length : 0;
      if (!MODES.has(group.mode)) addError(errors, 'MALFORMED_MODE', `${path}.mode`, 'mode must be any or all.');
      if (typeof group.dimensionId === 'string' && seenDimensions.has(group.dimensionId)) addError(errors, 'DUPLICATE_BRANCH_DIMENSION', `${path}.dimensionId`, 'A dimension may appear only once per branch.');
      seenDimensions.add(group.dimensionId);
      if (index) validateDimensionValues({ dimensionId: group.dimensionId, values, mode: group.mode, path, index, allowedPairs, unresolved, errors });
      if (typeof group.dimensionId === 'string' && values) for (const valueId of values) positivePairs.add(pairKey(group.dimensionId, valueId));
    }
  }

  const seenExclusionDimensions = new Set();
  for (const [exclusionIndex, exclusion] of config.exclusions.entries()) {
    const path = `exclusions[${exclusionIndex}]`;
    if (!isPlainObject(exclusion)) {
      addError(errors, 'MALFORMED_EXCLUSION', path, 'Each exclusion must be an object.');
      continue;
    }
    validateKeys(exclusion, EXCLUSION_KEYS, path, errors);
    const values = validateValues(exclusion.values, `${path}.values`, errors);
    valueCount += Array.isArray(exclusion.values) ? exclusion.values.length : 0;
    if (typeof exclusion.dimensionId === 'string' && seenExclusionDimensions.has(exclusion.dimensionId)) addError(errors, 'DUPLICATE_EXCLUSION_DIMENSION', `${path}.dimensionId`, 'A dimension may appear only once in exclusions.');
    seenExclusionDimensions.add(exclusion.dimensionId);
    if (index) validateDimensionValues({ dimensionId: exclusion.dimensionId, values, mode: 'any', path, index, allowedPairs, unresolved, errors });
    if (typeof exclusion.dimensionId === 'string' && values) for (const valueId of values) exclusionPairs.add(pairKey(exclusion.dimensionId, valueId));
  }
  if (groupCount > LIMITS.groups) addError(errors, 'TOO_MANY_GROUPS', 'branches', 'At most 50 groups are allowed.');
  if (valueCount > LIMITS.values) addError(errors, 'TOO_MANY_VALUES', '', 'At most 500 selected values are allowed.');
  for (const pair of positivePairs) if (exclusionPairs.has(pair)) addError(errors, 'INCLUDE_EXCLUDE_CONFLICT', '', `A value cannot be both included and excluded: ${pair}`);

  if (errors.length > 0) return { ok: false, value: null, errors, unresolved: canonicalPairs(unresolved) };
  return { ok: true, value: canonicalConfig(config), errors: [], unresolved: canonicalPairs(unresolved) };
}

function factHas(facts, dimensionId, value) {
  const values = facts && facts.dimensions && Array.isArray(facts.dimensions[dimensionId]) ? facts.dimensions[dimensionId] : [];
  return value === NOT_SET ? values.length === 0 : values.includes(value);
}

function matchesGroup(facts, group) {
  return group.mode === 'all'
    ? group.values.every((value) => factHas(facts, group.dimensionId, value))
    : group.values.some((value) => factHas(facts, group.dimensionId, value));
}

function evaluateFilterV2(facts, config) {
  const safeConfig = config || EMPTY_V2_FILTER;
  const exclusions = Array.isArray(safeConfig.exclusions) ? safeConfig.exclusions : [];
  const branches = Array.isArray(safeConfig.branches) ? safeConfig.branches : [];
  const excluded = exclusions.some((group) => Array.isArray(group.values) && group.values.some((value) => factHas(facts, group.dimensionId, value)));
  const positive = branches.length > 0
    ? branches.some((branch) => Array.isArray(branch.groups) && branch.groups.every((group) => matchesGroup(facts, group)))
    : exclusions.length > 0;
  return positive && !excluded;
}

function canonicalPairs(pairs) {
  const unique = new Map(pairs.map((pair) => [pairKey(pair.dimensionId, pair.valueId), pair]));
  return [...unique.values()].sort((left, right) => compareStrings(pairKey(left.dimensionId, left.valueId), pairKey(right.dimensionId, right.valueId)));
}

function selectedPairs(config) {
  if (!isPlainObject(config)) return [];
  const pairs = [];
  for (const branch of Array.isArray(config.branches) ? config.branches : []) {
    for (const group of Array.isArray(branch && branch.groups) ? branch.groups : []) {
      for (const valueId of Array.isArray(group && group.values) ? group.values : []) {
        if (typeof group.dimensionId === 'string' && typeof valueId === 'string') pairs.push({ dimensionId: group.dimensionId, valueId });
      }
    }
  }
  for (const group of Array.isArray(config.exclusions) ? config.exclusions : []) {
    for (const valueId of Array.isArray(group && group.values) ? group.values : []) {
      if (typeof group.dimensionId === 'string' && typeof valueId === 'string') pairs.push({ dimensionId: group.dimensionId, valueId });
    }
  }
  return canonicalPairs(pairs);
}

function selectedDimensionIds(config) {
  return [...new Set(selectedPairs(config).map((pair) => pair.dimensionId))].sort(compareStrings);
}

function summarizeFilter(config, metadata) {
  const dimensions = metadataIndex(metadata) || new Map();
  const normalized = validateFilterV2(config, metadata).ok ? validateFilterV2(config, metadata).value : config;
  const labelFor = (dimensionId, valueId) => ({
    dimensionId,
    dimensionLabel: dimensions.get(dimensionId)?.label || dimensionId,
    valueId,
    valueLabel: valueId === NOT_SET ? 'Not set' : dimensions.get(dimensionId)?.valuesById.get(valueId)?.label || valueId,
  });
  const branches = Array.isArray(normalized && normalized.branches) ? normalized.branches : [];
  const exclusions = Array.isArray(normalized && normalized.exclusions) ? normalized.exclusions : [];
  return {
    branches: branches.map((branch) => (Array.isArray(branch.groups) ? branch.groups : []).map((group) => ({
      dimensionId: group.dimensionId,
      dimensionLabel: dimensions.get(group.dimensionId)?.label || group.dimensionId,
      mode: group.mode,
      values: (Array.isArray(group.values) ? [...group.values].sort(compareStrings) : []).map((valueId) => labelFor(group.dimensionId, valueId)),
    }))),
    exclusions: exclusions.map((group) => ({
      dimensionId: group.dimensionId,
      dimensionLabel: dimensions.get(group.dimensionId)?.label || group.dimensionId,
      values: (Array.isArray(group.values) ? [...group.values].sort(compareStrings) : []).map((valueId) => labelFor(group.dimensionId, valueId)),
    })),
  };
}

module.exports = {
  EMPTY_V2_FILTER,
  validateFilterV2,
  evaluateFilterV2,
  selectedDimensionIds,
  selectedPairs,
  summarizeFilter,
};
