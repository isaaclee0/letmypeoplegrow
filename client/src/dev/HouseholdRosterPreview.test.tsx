import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import HouseholdRosterPreview from './HouseholdRosterPreview';

describe('PCO household roster preview', () => {
  it('shares one attendance mark across both household memberships and the person view', () => {
    render(<HouseholdRosterPreview />);
    const both = screen.getAllByRole('checkbox', { name: 'Jamie Bell present' });
    expect(both).toHaveLength(2);
    fireEvent.click(both[0]);
    expect(both[1]).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 8 present');
    fireEvent.click(screen.getByRole('button', { name: 'By person' }));
    const only = screen.getByRole('checkbox', { name: 'Jamie Bell present' });
    expect(only).toBeChecked();
    fireEvent.click(only);
    expect(screen.getByRole('status')).toHaveTextContent('0 of 8 present');
  });

  it('keeps same-name households distinct and shows unlinked history separately', () => {
    render(<HouseholdRosterPreview />);
    expect(screen.getAllByRole('heading', { name: 'Ford Household' })).toHaveLength(2);
    expect(screen.queryByText('Nico Lane')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Unlinked people/ }));
    expect(screen.getByText('Nico Lane')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getAllByText('Attendance history')[0]);
    expect(screen.getByText('22 Nov 2026 · Sunday AM')).toBeVisible();
  });

  it('shows a newly confirmed second membership on sync without a household choice or duplicate check-in', () => {
    render(<HouseholdRosterPreview />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rowan Bell present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simulate PCO update' }));
    const hart = screen.getByRole('region', { name: 'Hart Household' });
    expect(within(hart).getByRole('checkbox', { name: 'Rowan Bell present' })).toBeChecked();
    expect(screen.getAllByRole('checkbox', { name: 'Rowan Bell present' })).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('1 of 8 present');
  });
});
