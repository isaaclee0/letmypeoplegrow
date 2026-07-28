import type {
  BooleanFilterBranch,
  BooleanFilterConfigV2,
  BooleanFilterGroup,
  FilterDimension,
  FilterDimensionCardinality,
  FilterGroupMode,
  FilterValueState,
} from '../components/peopleSync/types';

type DimensionReference = FilterDimension | string;

function dimensionDetails(dimension: DimensionReference, cardinality: FilterDimensionCardinality): {
  id: string;
  cardinality: FilterDimensionCardinality;
} {
  return typeof dimension === 'string'
    ? { id: dimension, cardinality }
    : { id: dimension.id, cardinality: dimension.cardinality };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))].sort();
}

function normaliseGroup(group: BooleanFilterGroup): BooleanFilterGroup | null {
  const values = uniqueSorted(group.values);
  // `$not_set` means a dimension has no values. It cannot be combined with
  // another value under `all`, so keep the draft valid while preserving both
  // user choices by falling back to `any`.
  const mode = group.mode === 'all' && values.includes('$not_set') && values.length > 1 ? 'any' : group.mode;
  return values.length > 0 ? { dimensionId: group.dimensionId, mode, values } : null;
}

function normaliseBranch(branch: BooleanFilterBranch): BooleanFilterBranch | null {
  const groups = branch.groups
    .map(normaliseGroup)
    .filter((group): group is BooleanFilterGroup => group !== null)
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
  return groups.length > 0 ? { groups } : null;
}

export function normaliseFilterConfig(config: BooleanFilterConfigV2): BooleanFilterConfigV2 {
  const branches = config.branches
    .map(normaliseBranch)
    .filter((branch): branch is BooleanFilterBranch => branch !== null);
  const exclusionValuesByDimension = new Map<string, string[]>();
  for (const exclusion of config.exclusions) {
    const values = exclusionValuesByDimension.get(exclusion.dimensionId) || [];
    exclusionValuesByDimension.set(exclusion.dimensionId, [...values, ...exclusion.values]);
  }
  const exclusions = [...exclusionValuesByDimension.entries()]
    .map(([dimensionId, values]) => ({ dimensionId, values: uniqueSorted(values) }))
    .filter((exclusion) => exclusion.values.length > 0)
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
  return { branches, exclusions };
}

function withoutValue(config: BooleanFilterConfigV2, dimensionId: string, valueId: string): BooleanFilterConfigV2 {
  return normaliseFilterConfig({
    branches: config.branches.map((branch) => ({
      groups: branch.groups.map((group) => group.dimensionId === dimensionId
        ? { ...group, values: group.values.filter((value) => value !== valueId) }
        : { ...group, values: [...group.values] }),
    })),
    exclusions: config.exclusions.map((exclusion) => exclusion.dimensionId === dimensionId
      ? { ...exclusion, values: exclusion.values.filter((value) => value !== valueId) }
      : { ...exclusion, values: [...exclusion.values] }),
  });
}

export function emptyBooleanFilter(): BooleanFilterConfigV2 {
  return { branches: [], exclusions: [] };
}

export function addBranch(config: BooleanFilterConfigV2): BooleanFilterConfigV2 {
  const value = normaliseFilterConfig(config);
  return { ...value, branches: [...value.branches, { groups: [] }] };
}

export function addGroup(
  config: BooleanFilterConfigV2,
  branchIndex: number,
  dimension: DimensionReference,
  cardinality: FilterDimensionCardinality = 'multi',
): BooleanFilterConfigV2 {
  const { id, cardinality: resolvedCardinality } = dimensionDetails(dimension, cardinality);
  if (!Number.isInteger(branchIndex) || branchIndex < 0 || branchIndex >= config.branches.length ||
      config.branches[branchIndex].groups.some((group) => group.dimensionId === id)) return config;
  const mode: FilterGroupMode = resolvedCardinality === 'single' ? 'any' : 'all';
  return {
    branches: config.branches.map((branch, index) => index === branchIndex
      ? { groups: [...branch.groups, { dimensionId: id, mode, values: [] }] }
      : { groups: branch.groups.map((group) => ({ ...group, values: [...group.values] })) }),
    exclusions: config.exclusions.map((exclusion) => ({ ...exclusion, values: [...exclusion.values] })),
  };
}

export function removeBranch(config: BooleanFilterConfigV2, branchIndex: number): BooleanFilterConfigV2 {
  const value = normaliseFilterConfig(config);
  return { ...value, branches: value.branches.filter((_, index) => index !== branchIndex) };
}

export function removeGroup(config: BooleanFilterConfigV2, branchIndex: number, groupIndex: number): BooleanFilterConfigV2 {
  const value = normaliseFilterConfig(config);
  if (!Number.isInteger(branchIndex) || !Number.isInteger(groupIndex) || !value.branches[branchIndex]) return value;
  const branches = value.branches.map((branch, index) => index === branchIndex
    ? { groups: branch.groups.filter((_, currentGroupIndex) => currentGroupIndex !== groupIndex) }
    : branch);
  return normaliseFilterConfig({ ...value, branches });
}

export function setValueState(
  config: BooleanFilterConfigV2,
  dimension: DimensionReference,
  valueId: string,
  state: FilterValueState,
  cardinality: FilterDimensionCardinality = 'multi',
): BooleanFilterConfigV2 {
  const { id: dimensionId, cardinality: resolvedCardinality } = dimensionDetails(dimension, cardinality);
  const cleared = withoutValue(config, dimensionId, valueId);
  if (state === 'off') return cleared;
  if (state === 'not') {
    return normaliseFilterConfig({
      ...cleared,
      exclusions: [...cleared.exclusions, { dimensionId, values: [valueId] }],
    });
  }

  const mode: FilterGroupMode = resolvedCardinality === 'single' ? 'any' : 'all';
  const branches = cleared.branches.length > 0 ? cleared.branches : [{ groups: [] }];
  const firstGroupBranchIndex = branches.findIndex((branch) => branch.groups.some((group) => group.dimensionId === dimensionId));
  const branchIndex = firstGroupBranchIndex >= 0 ? firstGroupBranchIndex : 0;
  const branch = branches[branchIndex];
  const groupIndex = branch.groups.findIndex((group) => group.dimensionId === dimensionId);
  const groups = groupIndex >= 0
    ? branch.groups.map((group, index) => index === groupIndex ? { ...group, values: [...group.values, valueId] } : group)
    : [...branch.groups, { dimensionId, mode, values: [valueId] }];

  return normaliseFilterConfig({
    ...cleared,
    branches: branches.map((currentBranch, index) => index === branchIndex ? { groups } : currentBranch),
  });
}

/**
 * Applies a value action to the bracket in one branch. Unlike the original
 * convenience helper, positive values can legitimately recur in a separate
 * OR branch, so only the requested branch is changed. Every exit path passes
 * through `normalise` to prevent transient empty groups/branches and duplicate
 * exclusions from reaching the server.
 */
export function setBranchValueState(
  config: BooleanFilterConfigV2,
  branchIndex: number,
  dimension: DimensionReference,
  valueId: string,
  state: FilterValueState,
  cardinality: FilterDimensionCardinality = 'multi',
): BooleanFilterConfigV2 {
  const { id: dimensionId, cardinality: resolvedCardinality } = dimensionDetails(dimension, cardinality);
  const next: BooleanFilterConfigV2 = {
    branches: config.branches.map((branch) => ({ groups: branch.groups.map((group) => ({ ...group, values: [...group.values] })) })),
    exclusions: config.exclusions.map((exclusion) => ({ ...exclusion, values: [...exclusion.values] })),
  };
  const removeFromExclusions = (source: BooleanFilterConfigV2): BooleanFilterConfigV2 => ({
    ...source,
    exclusions: source.exclusions.map((exclusion) => exclusion.dimensionId === dimensionId
      ? { ...exclusion, values: exclusion.values.filter((value) => value !== valueId) }
      : exclusion),
  });

  if (state === 'not') {
  const withoutPositive = normaliseFilterConfig({
      ...next,
      branches: next.branches.map((branch) => ({ groups: branch.groups.map((group) => group.dimensionId === dimensionId
        ? { ...group, values: group.values.filter((value) => value !== valueId) }
        : group) })),
    });
    const withoutExclusion = removeFromExclusions(withoutPositive);
    return normaliseFilterConfig({ ...withoutExclusion, exclusions: [...withoutExclusion.exclusions, { dimensionId, values: [valueId] }] });
  }

  const withoutExclusion = removeFromExclusions(next);
  if (state === 'off') {
    return normaliseFilterConfig({
      ...withoutExclusion,
      branches: withoutExclusion.branches.map((branch, index) => index === branchIndex
        ? { groups: branch.groups.map((group) => group.dimensionId === dimensionId
          ? { ...group, values: group.values.filter((value) => value !== valueId) }
          : group) }
        : branch),
    });
  }

  if (!Number.isInteger(branchIndex) || branchIndex < 0 || branchIndex > withoutExclusion.branches.length) return normaliseFilterConfig(withoutExclusion);
  if (branchIndex === withoutExclusion.branches.length) {
    const mode: FilterGroupMode = resolvedCardinality === 'single' ? 'any' : 'all';
    return normaliseFilterConfig({ ...withoutExclusion, branches: [...withoutExclusion.branches, { groups: [{ dimensionId, mode, values: [valueId] }] }] });
  }
  return normaliseFilterConfig({
    ...withoutExclusion,
    branches: withoutExclusion.branches.map((branch, index) => {
      if (index !== branchIndex) return branch;
      const group = branch.groups.find((candidate) => candidate.dimensionId === dimensionId);
      const mode: FilterGroupMode = resolvedCardinality === 'single' ? 'any' : 'all';
      return { groups: group
        ? branch.groups.map((candidate) => candidate.dimensionId === dimensionId ? { ...candidate, values: [...candidate.values, valueId] } : candidate)
        : [...branch.groups, { dimensionId, mode, values: [valueId] }] };
    }),
  });
}

export function removeExclusionValue(config: BooleanFilterConfigV2, dimensionId: string, valueId: string): BooleanFilterConfigV2 {
  return normaliseFilterConfig({
    ...config,
    exclusions: config.exclusions.map((exclusion) => exclusion.dimensionId === dimensionId
      ? { ...exclusion, values: exclusion.values.filter((value) => value !== valueId) }
      : exclusion),
  });
}

export function setGroupMode(config: BooleanFilterConfigV2, branchIndex: number, groupIndex: number, mode: FilterGroupMode): BooleanFilterConfigV2 {
  return normaliseFilterConfig({
    ...config,
    branches: config.branches.map((branch, currentBranchIndex) => currentBranchIndex === branchIndex
      ? { groups: branch.groups.map((group, currentGroupIndex) => currentGroupIndex === groupIndex ? { ...group, mode } : group) }
      : branch),
  });
}
