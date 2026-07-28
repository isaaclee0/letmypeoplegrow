import { describe, expect, it } from 'vitest';
import type { BooleanFilterConfigV2, FilterDimension } from '../components/peopleSync/types';
import { addBranch, addGroup, emptyBooleanFilter, normaliseFilterConfig, removeBranch, removeGroup, removeExclusionValue, setBranchValueState, setValueState } from './filterConfig';

const multiGroups: FilterDimension = {
  id: 'groups',
  label: 'Groups',
  cardinality: 'multi',
  category: 'Groups',
  values: [{ id: 'music', label: 'Music', count: 4 }],
};

const singleStatus: FilterDimension = {
  id: 'status',
  label: 'Status',
  cardinality: 'single',
  category: 'People',
  values: [{ id: 'active', label: 'Active', count: 4 }],
};

describe('filterConfig', () => {
  it('creates the first positive selection in an all group for a multi-valued dimension', () => {
    expect(setValueState(emptyBooleanFilter(), multiGroups, 'music', 'include')).toEqual({
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['music'] }] }],
      exclusions: [],
    });
  });

  it('creates the first positive selection in an any group for a single-valued dimension', () => {
    expect(setValueState(emptyBooleanFilter(), singleStatus, 'active', 'include')).toEqual({
      branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }],
      exclusions: [],
    });
  });

  it('moves a NOT selection out of every positive branch into one global exclusion', () => {
    const config = {
      branches: [
        { groups: [{ dimensionId: 'groups', mode: 'all' as const, values: ['music', 'youth'] }] },
        { groups: [{ dimensionId: 'groups', mode: 'all' as const, values: ['music'] }] },
      ],
      exclusions: [],
    };

    expect(setValueState(config, multiGroups, 'music', 'not')).toEqual({
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth'] }] }],
      exclusions: [{ dimensionId: 'groups', values: ['music'] }],
    });
  });

  it('moves an included value out of the global exclusion without duplicates', () => {
    const config = {
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all' as const, values: ['music'] }] }],
      exclusions: [{ dimensionId: 'groups', values: ['music', 'youth', 'youth'] }],
    };

    expect(setValueState(config, multiGroups, 'youth', 'include')).toEqual({
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['music', 'youth'] }] }],
      exclusions: [{ dimensionId: 'groups', values: ['music'] }],
    });
  });

  it('coalesces multiple NOT values per dimension and preserves the remaining exclusion through transitions', () => {
    const withTwoExclusions = setValueState(
      setValueState(emptyBooleanFilter(), multiGroups, 'music', 'not'),
      multiGroups,
      'youth',
      'not',
    );

    expect(withTwoExclusions).toEqual({
      branches: [],
      exclusions: [{ dimensionId: 'groups', values: ['music', 'youth'] }],
    });
    expect(setValueState(withTwoExclusions, multiGroups, 'music', 'include')).toEqual({
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['music'] }] }],
      exclusions: [{ dimensionId: 'groups', values: ['youth'] }],
    });
    expect(setValueState(withTwoExclusions, multiGroups, 'music', 'off')).toEqual({
      branches: [],
      exclusions: [{ dimensionId: 'groups', values: ['youth'] }],
    });
  });

  it('removes the empty group and branch when its final value is turned off', () => {
    const config = {
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all' as const, values: ['music'] }] }],
      exclusions: [],
    };

    expect(setValueState(config, multiGroups, 'music', 'off')).toEqual(emptyBooleanFilter());
  });

  it('adds a dimension once to a selected branch and cascades group removal to the branch', () => {
    const withBranch = addBranch(emptyBooleanFilter());
    const withGroup = addGroup(withBranch, 0, multiGroups);

    expect(withGroup).toEqual({
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: [] }] }],
      exclusions: [],
    });
    expect(addGroup(withGroup, 0, multiGroups)).toEqual(withGroup);
    expect(removeGroup(withGroup, 0, 0)).toEqual(emptyBooleanFilter());
    expect(removeBranch(withBranch, 0)).toEqual(emptyBooleanFilter());
  });

  it('updates a specific branch without retaining empty groups or duplicate exclusions', () => {
    const config = {
      branches: [
        { groups: [{ dimensionId: 'groups', mode: 'all' as const, values: ['music'] }] },
        { groups: [{ dimensionId: 'groups', mode: 'all' as const, values: ['youth'] }] },
      ],
      exclusions: [{ dimensionId: 'groups', values: ['seniors', 'seniors'] }],
    };

    expect(setBranchValueState(config, 1, multiGroups, 'youth', 'off')).toEqual({
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['music'] }] }],
      exclusions: [{ dimensionId: 'groups', values: ['seniors'] }],
    });
    expect(setBranchValueState(config, 1, multiGroups, 'music', 'not')).toEqual({
      branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth'] }] }],
      exclusions: [{ dimensionId: 'groups', values: ['music', 'seniors'] }],
    });
  });

  it('removes one exclusion pair and leaves a server-valid filter', () => {
    expect(removeExclusionValue({ branches: [], exclusions: [{ dimensionId: 'groups', values: ['music', 'youth'] }] }, 'groups', 'music')).toEqual({
      branches: [], exclusions: [{ dimensionId: 'groups', values: ['youth'] }],
    });
  });

  it('canonicalizes equivalent permutations with the server ordering', () => {
    const first: BooleanFilterConfigV2 = {
      branches: [
        { groups: [{ dimensionId: 'status', mode: 'any', values: ['inactive', 'active'] }] },
        { groups: [
          { dimensionId: 'status', mode: 'any', values: ['visitor', 'member'] },
          { dimensionId: 'groups', mode: 'all', values: ['music', 'choir'] },
        ] },
      ],
      exclusions: [
        { dimensionId: 'status', values: ['inactive', 'active'] },
        { dimensionId: 'groups', values: ['music', 'choir'] },
      ],
    };
    const equivalent: BooleanFilterConfigV2 = {
      branches: [
        { groups: [
          { dimensionId: 'groups', mode: 'all', values: ['choir', 'music'] },
          { dimensionId: 'status', mode: 'any', values: ['member', 'visitor'] },
        ] },
        { groups: [{ dimensionId: 'status', mode: 'any', values: ['active', 'inactive'] }] },
      ],
      exclusions: [
        { dimensionId: 'groups', values: ['choir', 'music'] },
        { dimensionId: 'status', values: ['active', 'inactive'] },
      ],
    };

    expect(normaliseFilterConfig(first)).toEqual(normaliseFilterConfig(equivalent));
    expect(normaliseFilterConfig(first)).toEqual({
      branches: [
        { groups: [
          { dimensionId: 'groups', mode: 'all', values: ['choir', 'music'] },
          { dimensionId: 'status', mode: 'any', values: ['member', 'visitor'] },
        ] },
        { groups: [{ dimensionId: 'status', mode: 'any', values: ['active', 'inactive'] }] },
      ],
      exclusions: [
        { dimensionId: 'groups', values: ['choir', 'music'] },
        { dimensionId: 'status', values: ['active', 'inactive'] },
      ],
    });
  });
});
