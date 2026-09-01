import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  EngagementDrilldownPage,
  EngagementOverviewDto,
  EngagementPersonDrilldownRow,
  EngagementSettingsDto,
} from '../../services/api';
import EngagementMovementPanel from './EngagementMovementPanel';

const settings: EngagementSettingsDto = {
  coreMinimum: 60,
  casualMinimum: 20,
  tiers: {
    core: { label: 'Committed', colour: '#166534' },
    casual: { label: 'Connected', colour: '#b45309' },
    irregular: { label: 'Occasional', colour: '#b91c1c' },
  },
  gatheringRoles: [],
  calculationRulesVersion: 2,
  assignmentPreview: { primaryAssigned: 8, communityAssigned: 6, primaryNotAssigned: 2 },
};

const movement: EngagementOverviewDto['tierMovement'] = {
  recentWindowWeeks: 13,
  axes: {
    primary: {
      confirmingHigher: { count: 2, peopleToken: 'primary-higher' },
      confirmingLower: { count: 1, peopleToken: 'primary-lower' },
      confirmedRecently: { count: 3, peopleToken: 'primary-confirmed' },
    },
    community: {
      confirmingHigher: { count: 4, peopleToken: 'other-higher' },
      confirmingLower: { count: 5, peopleToken: 'other-lower' },
      confirmedRecently: { count: 6, peopleToken: 'other-confirmed' },
    },
  },
};

type Page = EngagementDrilldownPage<EngagementPersonDrilldownRow>;

const pendingRows: EngagementPersonDrilldownRow[] = [
  {
    rowType: 'engagement_confirmation', individualId: 1, firstName: 'Zoe', lastName: 'Zebra', familyId: null,
    axis: 'primary', direction: 'higher', establishedTier: 'casual', candidateTier: 'core',
    observedOpportunities: 6, attended: 4, rate: 4 / 6,
    candidateStartedWeekEnd: '2026-06-28', candidateFinalWeekEnd: '2026-09-27', currentWeek: 7,
  },
  {
    rowType: 'engagement_confirmation', individualId: 2, firstName: 'Alex', lastName: 'Able', familyId: null,
    axis: 'primary', direction: 'higher', establishedTier: 'irregular', candidateTier: 'casual',
    observedOpportunities: 0, attended: 0, rate: null,
    candidateStartedWeekEnd: '2026-08-16', candidateFinalWeekEnd: '2026-11-15', currentWeek: 0,
  },
];

const confirmedRows: EngagementPersonDrilldownRow[] = [
  {
    rowType: 'engagement_transition', individualId: 3, firstName: 'Blair', lastName: 'Baker', familyId: null,
    axis: 'community', fromTier: 'core', toTier: 'irregular',
    candidateStartedWeekEnd: '2026-05-10', confirmedWeekEnd: '2026-08-09',
    longTermEvidence: { attended: 1, opportunities: 10, rate: 0.1 },
    confirmationEvidence: { attended: 1, opportunities: 8, rate: 0.125 },
  },
];

function page(rows: EngagementPersonDrilldownRow[], nextCursor: string | null = null): Page {
  return { rows, nextCursor };
}

describe('EngagementMovementPanel', () => {
  it('switches axes, exposes all three colour-independent counts, and loads the selected token', async () => {
    const user = userEvent.setup();
    const loadPeople = vi.fn().mockResolvedValue(page([]));
    render(<EngagementMovementPanel movement={movement} settings={settings} loadPeople={loadPeople} />);

    expect(screen.getByRole('button', { name: 'Primary' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Other participation' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Confirming higher, 2 people' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirming lower, 1 person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmed recently, 3 people' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Other participation' }));
    expect(screen.getByRole('button', { name: 'Other participation' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Confirming higher, 4 people' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirming lower, 5 people' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmed recently, 6 people' })).toBeInTheDocument();

    screen.getByRole('button', { name: 'Confirming lower, 5 people' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(loadPeople).toHaveBeenCalledWith('other-lower', undefined));
    expect(screen.getByRole('button', { name: 'Confirming lower, 5 people' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows pending evidence, zero-week guidance, sortable columns, and supports close and reselection', async () => {
    const loadPeople = vi.fn().mockResolvedValue(page(pendingRows));
    render(<EngagementMovementPanel movement={movement} settings={settings} loadPeople={loadPeople} />);

    const card = screen.getByRole('button', { name: 'Confirming higher, 2 people' });
    fireEvent.click(card);
    const panel = await screen.findByRole('region', { name: 'Primary — Confirming higher' });

    expect(within(panel).getByText('Connected → Committed')).toBeInTheDocument();
    expect(within(panel).getByText('6/8 opportunities observed')).toBeInTheDocument();
    expect(within(panel).getByText('4 attended (67%)')).toBeInTheDocument();
    expect(within(panel).getByText('week 7 of 13')).toBeInTheDocument();
    expect(within(panel).getByText('awaiting the first confirmation week')).toBeInTheDocument();
    expect(within(panel).getAllByRole('rowheader').map((row) => row.textContent)).toEqual(['Alex Able', 'Zoe Zebra']);

    const surnameHeader = within(panel).getByRole('columnheader', { name: 'Surname' });
    expect(surnameHeader).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(within(panel).getByRole('button', { name: 'Sort by surname descending' }));
    expect(within(panel).getAllByRole('rowheader').map((row) => row.textContent)).toEqual(['Zoe Zebra', 'Alex Able']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Sort by attendance percentage descending' }));
    expect(within(panel).getByRole('columnheader', { name: 'Attendance' })).toHaveAttribute('aria-sort', 'descending');
    expect(within(panel).getAllByRole('rowheader').map((row) => row.textContent)).toEqual(['Zoe Zebra', 'Alex Able']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Sort by attendance percentage ascending' }));
    expect(within(panel).getByRole('columnheader', { name: 'Attendance' })).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(within(panel).getByRole('button', { name: 'Close movement details' }));
    expect(screen.queryByRole('region', { name: 'Primary — Confirming higher' })).not.toBeInTheDocument();
    fireEvent.click(card);
    expect(await screen.findByRole('region', { name: 'Primary — Confirming higher' })).toBeInTheDocument();
    fireEvent.click(card);
    expect(screen.queryByRole('region', { name: 'Primary — Confirming higher' })).not.toBeInTheDocument();
  });

  it('shows confirmed transition dates and both evidence windows', async () => {
    const loadPeople = vi.fn().mockResolvedValue(page(confirmedRows));
    render(<EngagementMovementPanel movement={movement} settings={settings} loadPeople={loadPeople} />);
    fireEvent.click(screen.getByRole('button', { name: 'Other participation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed recently, 6 people' }));

    const panel = await screen.findByRole('region', { name: 'Other participation — Confirmed recently' });
    expect(within(panel).getByText('Committed → Occasional')).toBeInTheDocument();
    expect(within(panel).getByText('Other participation')).toBeInTheDocument();
    expect(within(panel).getByText('9 Aug 2026')).toBeInTheDocument();
    expect(within(panel).getByText('1 of 10 (10%)')).toBeInTheDocument();
    expect(within(panel).getByText('1 of 8 (13%)')).toBeInTheDocument();
    expect(within(panel).getByRole('columnheader', { name: '52-week evidence' })).toBeInTheDocument();
    expect(within(panel).getByRole('columnheader', { name: 'Confirmation evidence' })).toHaveAttribute('aria-sort', 'none');
  });

  it('explains active empty states without presenting stable people as movement', async () => {
    const loadPeople = vi.fn().mockResolvedValue(page([]));
    render(<EngagementMovementPanel movement={movement} settings={settings} loadPeople={loadPeople} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirming lower, 1 person' }));

    expect(await screen.findByText('No people are currently gathering evidence for this change.')).toBeInTheDocument();
    expect(screen.queryByText(/stable|unchanged/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
