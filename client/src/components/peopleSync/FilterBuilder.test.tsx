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
