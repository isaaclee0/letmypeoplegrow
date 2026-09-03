import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { reportsAPI } from '../../services/api';
import EngagementDrilldown from './EngagementDrilldown';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    reportsAPI: { ...actual.reportsAPI, getEngagementSessions: vi.fn() },
  };
});

describe('EngagementDrilldown', () => {
  it('formats session dates for people instead of exposing ISO dates', async () => {
    vi.mocked(reportsAPI.getEngagementSessions).mockResolvedValue({ data: { rows: [{
      rowType: 'attendance_session', sessionId: 9, gatheringTypeId: 1, gatheringName: 'Sunday',
      sessionDate: '2026-05-17', attendance: 42, uniquePeople: 40,
    }], nextCursor: null } } as never);

    render(<EngagementDrilldown token="sessions" title="Sessions" onClose={vi.fn()} />);

    expect(await screen.findByText(/17 May 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-05-17/)).not.toBeInTheDocument();
  });

});
