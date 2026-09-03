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
});
