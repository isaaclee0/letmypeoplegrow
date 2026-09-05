import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { individualsAPI, reportsAPI } from '../../services/api';
import EngagementPeoplePanel from './EngagementPeoplePanel';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    reportsAPI: {
      ...actual.reportsAPI,
      getEngagementPeople: vi.fn(),
    },
    individualsAPI: {
      ...actual.individualsAPI,
      getAttendanceHistory: vi.fn(),
    },
  };
});

describe('EngagementPeoplePanel contextual declines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('opens attendance history from the keyboard and passes the selected gathering IDs', async () => {
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [{
      rowType: 'contextual_decline',
      individualId: 2001,
      firstName: 'Alex',
      lastName: 'Able',
      familyId: null,
      baseline: { attendedWeeks: 3, opportunityWeeks: 4, rate: 75 },
      recent: { attendedWeeks: 1, opportunityWeeks: 6, rate: 16.7 },
      summary: 'Usually attends 3 weeks in 4; attended 1 of the last 6 weeks.',
    }], nextCursor: null } } as never);
    vi.mocked(individualsAPI.getAttendanceHistory).mockResolvedValue({ data: { history: [
      { date: '2026-09-02', gatheringId: 2, gatheringName: 'Youth', present: true },
      { date: '2026-09-01', gatheringId: 1, gatheringName: 'Sunday', present: true },
      { date: '2026-08-31', gatheringId: 3, gatheringName: 'Conference', present: true },
    ] } } as never);

    render(
      <EngagementPeoplePanel
        token="decline-token"
        title="People attending less often"
        gatheringIds={[2, 1]}
        onClose={vi.fn()}
      />,
    );

    const panel = await screen.findByRole('region', { name: 'People attending less often' });
    const historyTrigger = await within(panel).findByRole('button', { name: 'Alex Able' });
    expect(historyTrigger).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(historyTrigger, { key: ' ' });

    expect(await within(panel).findByText(/Sep 2, 2026/)).toHaveTextContent('Youth');
    expect(within(panel).getByText(/Sep 1, 2026/)).toHaveTextContent('Sunday');
    expect(within(panel).queryByText(/Aug 31, 2026/)).not.toBeInTheDocument();
  });

  it('preserves decline relevance order initially and labels earlier and recent attendance accurately', async () => {
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [
      { rowType: 'contextual_decline', individualId: 2, firstName: 'Zoe', lastName: 'Zulu', familyId: null, baseline: { attendedWeeks: 4, opportunityWeeks: 4, rate: 100 }, recent: { attendedWeeks: 0, opportunityWeeks: 4, rate: 0 }, summary: 'Largest decline' },
      { rowType: 'contextual_decline', individualId: 1, firstName: 'Amy', lastName: 'Able', familyId: null, baseline: { attendedWeeks: 3, opportunityWeeks: 4, rate: 75 }, recent: { attendedWeeks: 2, opportunityWeeks: 4, rate: 50 }, summary: 'Smaller decline' },
    ], nextCursor: null } } as never);

    render(<EngagementPeoplePanel token="declines" title="People attending less often" onClose={vi.fn()} />);
    const panel = await screen.findByRole('region', { name: 'People attending less often' });
    const names = within(panel).getAllByRole('rowheader').map((cell) => cell.textContent);
    expect(names).toEqual(['Zoe Zulu', 'Amy Able']);
    expect(within(panel).getByRole('columnheader', { name: 'Earlier attendance' })).toBeInTheDocument();
    expect(within(panel).getByRole('columnheader', { name: 'Recent attendance' })).toBeInTheDocument();
  });
});

describe('EngagementPeoplePanel contextual regularity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('uses a responsive three-column people grid and retains attendance sorting', async () => {
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [
      { rowType: 'contextual_regularity', individualId: 1, firstName: 'Amy', lastName: 'Able', familyId: null, rate: 25, evidence: { attendedWeeks: 1, opportunityWeeks: 4 } },
      { rowType: 'contextual_regularity', individualId: 2, firstName: 'Zoe', lastName: 'Zulu', familyId: null, rate: 75, evidence: { attendedWeeks: 3, opportunityWeeks: 4 } },
      { rowType: 'contextual_regularity', individualId: 3, firstName: 'Ben', lastName: 'Baker', familyId: null, rate: 50, evidence: { attendedWeeks: 2, opportunityWeeks: 4 } },
    ], nextCursor: null } } as never);

    render(<EngagementPeoplePanel token="core" title="Core people" onClose={vi.fn()} />);

    const panel = await screen.findByRole('region', { name: 'Core people' });
    const people = within(panel).getByRole('list', { name: 'People' });
    expect(panel).toHaveClass('dark:bg-gray-800');
    expect(people).toHaveClass('grid-cols-1', 'md:grid-cols-2', 'xl:grid-cols-3');
    expect(within(people).getAllByRole('listitem')[0]).toHaveClass('dark:bg-gray-700/60', 'dark:border-gray-600');
    expect(within(people).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Amy Able1 of 4 weeks (25%)',
      'Zoe Zulu3 of 4 weeks (75%)',
      'Ben Baker2 of 4 weeks (50%)',
    ]);

    fireEvent.click(within(panel).getByRole('button', { name: 'Sort by attendance descending' }));
    expect(within(people).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Zoe Zulu3 of 4 weeks (75%)',
      'Ben Baker2 of 4 weeks (50%)',
      'Amy Able1 of 4 weeks (25%)',
    ]);
  });
});
