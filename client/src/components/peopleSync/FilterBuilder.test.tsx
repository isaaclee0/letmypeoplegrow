import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FilterBuilder from './FilterBuilder';
import type { BooleanFilterConfigV2, FilterMetadata } from './types';

const metadata: FilterMetadata = {
  dimensions: [
    { id: 'status', label: 'Status', cardinality: 'single', category: 'People', values: [{ id: 'active', label: 'Active', count: 12 }, { id: '$not_set', label: '$not_set', count: 2 }] },
    { id: 'groups', label: 'Groups', cardinality: 'multi', category: 'People', values: [{ id: 'youth', label: 'Youth', count: 8 }, { id: 'music', label: 'Music', count: 5 }, { id: 'seniors', label: 'Seniors', count: 3 }] },
  ],
};

function Controlled({ initial = { branches: [], exclusions: [] } }: { initial?: BooleanFilterConfigV2 }) {
  const [value, setValue] = useState(initial);
  return <><FilterBuilder metadata={metadata} value={value} onChange={setValue} /><output aria-label="Filter value">{JSON.stringify(value)}</output></>;
}

describe('FilterBuilder', () => {
  it('builds bracketed AND branches and allows the same dimension in another OR branch', () => {
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Branch 1' }));
    expect(screen.getByLabelText('Filter value')).toHaveTextContent('"branches":[]');
    fireEvent.click(screen.getByRole('button', { name: 'Choose Status for Branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Include Active' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add AND filter type to Branch 1' }));
    expect(screen.queryByRole('button', { name: 'Choose Status for Branch 1' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose Groups for Branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Include Youth' }));
    expect(screen.getByText('AND')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add OR alternative branch' }));
    expect(screen.getByText('OR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Status for Branch 2' })).toBeInTheDocument();
  });

  it('keeps staged branch construction local until its first included value', () => {
    const onChange = vi.fn();
    render(<FilterBuilder metadata={metadata} value={{ branches: [], exclusions: [] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Status for Branch 1' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can clear and include a pending value without persisting an invalid branch', () => {
    render(<Controlled initial={{ branches: [], exclusions: [{ dimensionId: 'status', values: ['active'] }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Status for Branch 1' }));
    expect(screen.getByRole('button', { name: 'NOT Active' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Off Active' }));
    expect(JSON.parse(screen.getByLabelText('Filter value').textContent || '{}')).toEqual({ branches: [], exclusions: [] });
    expect(screen.getByRole('searchbox', { name: 'Search pending Status values' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Include Active' }));
    expect(JSON.parse(screen.getByLabelText('Filter value').textContent || '{}')).toEqual({
      branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }],
      exclusions: [],
    });
  });

  it('keeps NOT in a pending branch as a valid global exclusion', () => {
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Status for Branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'NOT Active' }));
    expect(JSON.parse(screen.getByLabelText('Filter value').textContent || '{}')).toEqual({
      branches: [],
      exclusions: [{ dimensionId: 'status', values: ['active'] }],
    });
    expect(screen.getByRole('searchbox', { name: 'Search pending Status values' })).toBeInTheDocument();
  });

  it('returns focus to the exact cancelled AND or OR construction control', () => {
    render(<Controlled initial={{ branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] }} />);
    const andButton = screen.getByRole('button', { name: 'Add AND filter type to Branch 1' });
    fireEvent.click(andButton);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add AND filter type to Branch 1' })).toHaveFocus();

    const orButton = screen.getByRole('button', { name: 'Add OR alternative branch' });
    fireEvent.click(orButton);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add OR alternative branch' })).toHaveFocus();
  });

  it('locks existing branches during staged AND construction, then commits to and restores the original branch', () => {
    render(<Controlled initial={{ branches: [
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['music'] }] },
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth'] }] },
    ], exclusions: [] }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add AND filter type to Branch 2' }));
    expect(screen.getByText('Finish or cancel the staged filter before editing existing rules.')).toBeInTheDocument();
    const removeTarget = screen.getByRole('button', { name: 'Remove Branch 2' });
    expect(removeTarget).toBeDisabled();
    fireEvent.click(removeTarget);
    expect(screen.getByRole('button', { name: 'Choose Status for Branch 2' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add AND filter type to Branch 2' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Add AND filter type to Branch 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Status for Branch 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Include Active' }));
    expect(JSON.parse(screen.getByLabelText('Filter value').textContent || '{}').branches).toEqual([
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['music'] }] },
      { groups: [
        { dimensionId: 'groups', mode: 'all', values: ['youth'] },
        { dimensionId: 'status', mode: 'any', values: ['active'] },
      ] },
    ]);
  });

  it('cancels staged AND construction if an external value update removes its branch', () => {
    const initial: BooleanFilterConfigV2 = { branches: [
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['music'] }] },
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth'] }] },
    ], exclusions: [] };
    function ExternalControlled() {
      const [value, setValue] = useState(initial);
      return <><FilterBuilder metadata={metadata} value={value} onChange={setValue} /><button type="button" onClick={() => setValue({ branches: [initial.branches[0]], exclusions: [] })}>External update</button></>;
    }

    render(<ExternalControlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Add AND filter type to Branch 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'External update' }));
    expect(screen.queryByText('Choose a filter type for Branch 2')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not allow staged AND to globally exclude and remove its origin value', () => {
    const initial: BooleanFilterConfigV2 = { branches: [
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth'] }] },
      { groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] },
    ], exclusions: [] };
    render(<Controlled initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add AND filter type to Branch 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Groups for Branch 2' }));
    const notYouth = screen.getByRole('button', { name: 'NOT Youth' });
    expect(notYouth).toBeDisabled();
    expect(notYouth).toHaveAttribute('aria-describedby', 'pending-and-not-help');
    expect(screen.getByText('Finish or cancel this AND filter before changing Always exclude.')).toBeInTheDocument();
    fireEvent.keyDown(notYouth, { key: 'Enter' });
    expect(JSON.parse(screen.getByLabelText('Filter value').textContent || '{}')).toEqual(initial);
    expect(screen.getByRole('searchbox', { name: 'Search pending Groups values' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add AND filter type to Branch 2' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Add AND filter type to Branch 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Groups for Branch 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Include Youth' }));
    const statusBranch = JSON.parse(screen.getByLabelText('Filter value').textContent || '{}').branches
      .find((branch: BooleanFilterConfigV2['branches'][number]) => branch.groups.some((group) => group.dimensionId === 'status'));
    expect(statusBranch).toEqual({ groups: [
      { dimensionId: 'groups', mode: 'all', values: ['youth'] },
      { dimensionId: 'status', mode: 'any', values: ['active'] },
    ] });
  });

  it('defaults multi brackets to Match all, hides it for single values, and supports removal', () => {
    render(<Controlled initial={{ branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', 'music'] }, { dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] }} />);
    expect(screen.getByRole('button', { name: 'Match all for Groups' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /Match all for Status/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Groups from Branch 1' }));
    expect(screen.queryByRole('region', { name: 'Groups in Branch 1' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Branch 1' }));
    expect(screen.getByText('No one matches until you add a branch or an exclusion.')).toBeInTheDocument();
  });

  it('moves NOT values into the persistent exclusion ledger and restores focus after removal', () => {
    render(<Controlled initial={{ branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', 'music', 'seniors'] }] }, { groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', 'music', 'seniors'] }] }], exclusions: [] }} />);
    const groups = screen.getAllByRole('region', { name: /Groups in Branch/ });
    groups.forEach((group) => fireEvent.click(within(group).getByRole('button', { name: 'Open Groups values' })));
    fireEvent.click(within(groups[0]).getByRole('button', { name: 'NOT Youth' }));
    expect(screen.getByRole('region', { name: 'Always exclude' })).toHaveTextContent('Youth');
    expect(JSON.parse(screen.getByLabelText('Filter value').textContent || '{}').branches).toEqual([
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['music', 'seniors'] }] },
      { groups: [{ dimensionId: 'groups', mode: 'all', values: ['music', 'seniors'] }] },
    ]);
    fireEvent.click(within(screen.getAllByRole('region', { name: /Groups in Branch/ })[1]).getByRole('button', { name: 'NOT Music' }));
    const ledger = screen.getByRole('region', { name: 'Always exclude' });
    expect(ledger).toHaveTextContent('Youth');
    expect(ledger).toHaveTextContent('Music');
    const removeYouth = within(ledger).getByRole('button', { name: 'Remove exclusion Youth' });
    fireEvent.click(removeYouth);
    expect(screen.getAllByRole('button', { name: 'NOT Youth' }).some((button) => button === document.activeElement)).toBe(true);
  });

  it('searches only the open dimension, supports keyboard value selection, and retains unresolved choices', () => {
    render(<Controlled initial={{ branches: [{ groups: [{ dimensionId: 'missing_dimension', mode: 'all', values: ['gone'] }, { dimensionId: 'groups', mode: 'all', values: ['missing-value'] }, { dimensionId: 'status', mode: 'any', values: ['$not_set'] }] }], exclusions: [] }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('no longer available');
    fireEvent.click(screen.getByRole('button', { name: 'Open Groups values' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Groups values' }), { target: { value: 'Youth' } });
    expect(screen.getByRole('button', { name: 'Include Youth' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Include Music' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include Youth' }), { key: 'Enter' });
    expect(screen.getByLabelText('Filter value')).toHaveTextContent('youth');
    fireEvent.click(screen.getByRole('button', { name: 'Open Status values' }));
    expect(screen.getByText('Not set')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove missing_dimension from Branch 1' }));
    expect(screen.queryByText('missing_dimension')).not.toBeInTheDocument();
  });

  it('projects persisted missing dimensions and values from the saved config after a canonical refresh', () => {
    const refreshedMetadata: FilterMetadata = { dimensions: [
      { id: 'groups', label: 'Groups', cardinality: 'multi', category: 'People', values: [
        { id: 'current', label: 'Current', count: 1 },
      ] },
    ] };
    function RefreshedControlled() {
      const [value, setValue] = useState<BooleanFilterConfigV2>({ branches: [{ groups: [
        { dimensionId: 'custom_field:retired', mode: 'any', values: ['old-choice'] },
        { dimensionId: 'groups', mode: 'any', values: ['old-group'] },
      ] }], exclusions: [] });
      return <><FilterBuilder metadata={refreshedMetadata} value={value} onChange={setValue} /><output aria-label="Refreshed filter value">{JSON.stringify(value)}</output></>;
    }
    render(<RefreshedControlled />);

    expect(screen.getByRole('alert')).toHaveTextContent('custom_field:retired');
    expect(screen.getByRole('alert')).toHaveTextContent('old-group');
    fireEvent.click(screen.getByRole('button', { name: 'Open custom_field:retired values' }));
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove custom_field:retired from Branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Groups from Branch 1' }));
    expect(JSON.parse(screen.getByLabelText('Refreshed filter value').textContent || '{}')).toEqual({ branches: [], exclusions: [] });
  });

  it('keeps a NOT-only filter editable', () => {
    render(<Controlled initial={{ branches: [], exclusions: [{ dimensionId: 'status', values: ['active'] }] }} />);
    expect(screen.getByText('Everyone except the excluded people matches.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove exclusion Active' }));
    expect(screen.getByText('No one matches until you add a branch or an exclusion.')).toBeInTheDocument();
  });

  it('prevents invalid Match all combinations with Not set', () => {
    render(<Controlled initial={{ branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', '$not_set'] }] }], exclusions: [] }} />);
    expect(screen.getByRole('button', { name: 'Match any for Groups' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Filter value')).toHaveTextContent('"mode":"any"');
  });
});
