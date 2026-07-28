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
  return values.length > 0 ? { dimensionId: group.dimensionId, mode: group.mode, values } : null;
}

function normaliseBranch(branch: BooleanFilterBranch): BooleanFilterBranch | null {
  const groups = branch.groups
    .map(normaliseGroup)
    .filter((group): group is BooleanFilterGroup => group !== null)
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
  return groups.length > 0 ? { groups } : null;
}

function normalise(config: BooleanFilterConfigV2): BooleanFilterConfigV2 {
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
  return normalise({
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
  const value = normalise(config);
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
  const value = normalise(config);
  return { ...value, branches: value.branches.filter((_, index) => index !== branchIndex) };
}

export function removeGroup(config: BooleanFilterConfigV2, branchIndex: number, groupIndex: number): BooleanFilterConfigV2 {
  const value = normalise(config);
  if (!Number.isInteger(branchIndex) || !Number.isInteger(groupIndex) || !value.branches[branchIndex]) return value;
  const branches = value.branches.map((branch, index) => index === branchIndex
    ? { groups: branch.groups.filter((_, currentGroupIndex) => currentGroupIndex !== groupIndex) }
    : branch);
  return normalise({ ...value, branches });
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
    return normalise({
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

  return normalise({
    ...cleared,
    branches: branches.map((currentBranch, index) => index === branchIndex ? { groups } : currentBranch),
  });
}
