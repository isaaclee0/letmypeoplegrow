import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsAPI } from '../../services/api';
import EngagementSettings from './EngagementSettings';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, settingsAPI: { ...actual.settingsAPI, updateEngagementSettings: vi.fn() } };
});

const settings = {
  coreMinimum: 60, casualMinimum: 20,
  tiers: {
    core: { label: 'Core', colour: '#16A34A' }, casual: { label: 'Casual', colour: '#D97706' },
    irregular: { label: 'Irregular', colour: '#DC2626' },
  },
  gatheringRoles: [
    { gatheringTypeId: 1, role: 'primary' as const },
    { gatheringTypeId: 2, role: null },
    { gatheringTypeId: 3, role: 'other' as const },
  ],
  calculationRulesVersion: 1,
  assignmentPreview: { primaryAssigned: 7, communityAssigned: 3, primaryNotAssigned: 2 },
};

const gatherings = [
  { id: 1, name: 'Sunday', attendanceType: 'standard' as const, isActive: true },
  { id: 2, name: 'Youth', attendanceType: 'standard' as const, isActive: false },
  { id: 3, name: 'Conference', attendanceType: 'headcount' as const, isActive: true },
];

describe('EngagementSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows coordinators the complete active rules without editable controls', () => {
    render(<EngagementSettings settings={settings} gatherings={gatherings} canEdit={false} onSaved={vi.fn()} />);
    expect(screen.getByText('Core: 60% or more')).toBeInTheDocument();
    expect(screen.getByText('Casual: 20% to 59%')).toBeInTheDocument();
    expect(screen.getByText(/^Sunday: Primary$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save engagement settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('lets admins edit labels, colours, thresholds, and every gathering role with explanations', () => {
    render(<EngagementSettings settings={settings} gatherings={gatherings} canEdit onSaved={vi.fn()} />);
    expect(screen.getByText(/Primary combines alternative services into one opportunity per person each week/)).toBeInTheDocument();
    expect(screen.getByText(/Community treats each eligible session as a separate opportunity/)).toBeInTheDocument();
    expect(screen.getByText(/Other remains in attendance trends but not person tiers/)).toBeInTheDocument();
    expect(screen.getByText('Youth')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('Conference')).toBeInTheDocument();
    expect(screen.getByText(/Headcount gatherings cannot create person-level tiers/)).toBeInTheDocument();
    expect(screen.getByLabelText('Core label')).toHaveValue('Core');
    expect(screen.getByLabelText('Core colour')).toHaveValue('#16a34a');
    expect(screen.getByLabelText('Role for Youth')).toBeInTheDocument();
    expect(screen.getByText('7 Primary assigned')).toBeInTheDocument();
    expect(screen.getByText('3 Community assigned')).toBeInTheDocument();
    expect(screen.getByText('2 Primary not assigned')).toBeInTheDocument();
    expect(screen.getByText(/Weekly: 31 of 52 is 60%/)).toBeInTheDocument();
    expect(screen.getByText(/Fortnightly: 16 of 26 is 62%/)).toBeInTheDocument();
    expect(screen.getByText(/Monthly: 8 of 13 is 62%/)).toBeInTheDocument();
  });

  it('blocks invalid thresholds before saving', async () => {
    render(<EngagementSettings settings={settings} gatherings={gatherings} canEdit onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Casual minimum'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save engagement settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Casual minimum must be less than Core minimum');
    expect(settingsAPI.updateEngagementSettings).not.toHaveBeenCalled();
  });

  it('saves the complete settings atomically and refreshes the overview', async () => {
    const saved = { ...settings, coreMinimum: 65, calculationRulesVersion: 2 };
    vi.mocked(settingsAPI.updateEngagementSettings).mockResolvedValue({ data: { settings: saved } } as never);
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<EngagementSettings settings={settings} gatherings={gatherings} canEdit onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Core minimum'), { target: { value: '65' } });
    fireEvent.change(screen.getByLabelText('Core label'), { target: { value: 'Committed' } });
    fireEvent.change(screen.getByLabelText('Role for Youth'), { target: { value: 'community' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save engagement settings' }));

    await waitFor(() => expect(settingsAPI.updateEngagementSettings).toHaveBeenCalledWith({
      coreMinimum: 65,
      casualMinimum: 20,
      tiers: {
        core: { label: 'Committed', colour: '#16A34A' },
        casual: settings.tiers.casual,
        irregular: settings.tiers.irregular,
      },
      gatheringRoles: [
        { gatheringTypeId: 1, role: 'primary' },
        { gatheringTypeId: 2, role: 'community' },
        { gatheringTypeId: 3, role: 'other' },
      ],
    }));
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
  });
});
