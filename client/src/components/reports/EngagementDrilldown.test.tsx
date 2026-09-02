import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { reportsAPI } from '../../services/api';
import EngagementDrilldown from './EngagementDrilldown';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    reportsAPI: { ...actual.reportsAPI, getEngagementPeople: vi.fn(), getEngagementSessions: vi.fn() },
  };
});

describe('EngagementDrilldown', () => {
  it('uses the public Other participation label for a person profile', async () => {
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [{
      rowType: 'engagement_profile', individualId: 1, firstName: 'Alex', lastName: 'Able', familyId: null,
      primary: { status: 'core', attended: 31, opportunities: 46, rate: 31 / 46, statusSource: 'established' },
      community: { status: 'casual', attended: 4, opportunities: 8, rate: 0.5, statusSource: 'established' },
    }], nextCursor: null } } as never);

    render(<EngagementDrilldown
      kind="people"
      token="profile-token"
      title="Profile details"
      settings={{
        coreMinimum: 60, casualMinimum: 20,
        tiers: {
          core: { label: 'Core', colour: '#166534' },
          casual: { label: 'Casual', colour: '#b45309' },
          irregular: { label: 'Irregular', colour: '#b91c1c' },
        },
        gatheringRoles: [], calculationRulesVersion: 2,
        assignmentPreview: { primaryAssigned: 1, communityAssigned: 1, primaryNotAssigned: 0 },
      }}
      onClose={vi.fn()}
    />);

    const dialog = await screen.findByRole('dialog', { name: 'Profile details' });
    expect(within(dialog).getByText(/Other participation:/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Community:/)).not.toBeInTheDocument();
  });

  it('formats session dates for people instead of exposing ISO dates', async () => {
    vi.mocked(reportsAPI.getEngagementSessions).mockResolvedValue({ data: { rows: [{
      rowType: 'attendance_session', sessionId: 9, gatheringTypeId: 1, gatheringName: 'Sunday',
      sessionDate: '2026-05-17', attendance: 42, uniquePeople: 40,
    }], nextCursor: null } } as never);

    render(<EngagementDrilldown kind="sessions" token="sessions" title="Sessions" settings={{
      coreMinimum: 60, casualMinimum: 20,
      tiers: { core: { label: 'Core', colour: '#166534' }, casual: { label: 'Casual', colour: '#b45309' }, irregular: { label: 'Irregular', colour: '#b91c1c' } },
      gatheringRoles: [], calculationRulesVersion: 2,
      assignmentPreview: { primaryAssigned: 0, communityAssigned: 0, primaryNotAssigned: 0 },
    }} onClose={vi.fn()} />);

    expect(await screen.findByText(/17 May 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-05-17/)).not.toBeInTheDocument();
  });
});
