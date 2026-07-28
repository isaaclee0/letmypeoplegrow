import { describe, expect, it } from 'vitest';
import type { FilterDimension } from '../components/peopleSync/types';
import { addBranch, addGroup, emptyBooleanFilter, removeBranch, removeGroup, setValueState } from './filterConfig';

const multiGroups: FilterDimension = {
  id: 'groups',
  label: 'Groups',
  cardinality: 'multi',
  values: [{ id: 'music', label: 'Music', count: 4 }],
};

const singleStatus: FilterDimension = {
  id: 'status',
  label: 'Status',
  cardinality: 'single',
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
});
