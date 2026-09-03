import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextualEngagementSettingsDto } from '../../services/api';
import { settingsAPI } from '../../services/api';
import RegularitySettings from './RegularitySettings';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    settingsAPI: { ...actual.settingsAPI, updateEngagementSettings: vi.fn() },
  };
});

const settings: ContextualEngagementSettingsDto = {
  coreMinimum: 60,
  casualMinimum: 20,
  tiers: {
    core: { label: 'Core', colour: '#16A34A' },
    casual: { label: 'Casual', colour: '#D97706' },
    irregular: { label: 'Irregular', colour: '#DC2626' },
  },
  calculationRulesVersion: 2,
};

describe('RegularitySettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers only threshold, label, and colour controls with exact percentage explanations', () => {
    render(<RegularitySettings settings={settings} onSaved={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Regularity settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Core minimum')).toHaveValue(60);
    expect(screen.getByLabelText('Casual minimum')).toHaveValue(20);
    expect(screen.getByLabelText('Core label')).toHaveValue('Core');
    expect(screen.getByLabelText('Casual colour')).toHaveValue('#d97706');
    expect(screen.getByText('60% or more of opportunity weeks')).toBeInTheDocument();
    expect(screen.getByText('20%–59% of opportunity weeks')).toBeInTheDocument();
    expect(screen.getByText('Below 20% of opportunity weeks')).toBeInTheDocument();
    expect(screen.queryByText(/gathering roles|primary|other participation|assigned/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/times a month|monthly/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('blocks invalid thresholds before making a request', async () => {
    render(<RegularitySettings settings={settings} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Casual minimum'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save regularity settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Casual minimum must be less than Core minimum');
    expect(settingsAPI.updateEngagementSettings).not.toHaveBeenCalled();
  });

  it('requires every tier label', async () => {
    render(<RegularitySettings settings={settings} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Irregular label'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save regularity settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Each tier needs a label.');
    expect(settingsAPI.updateEngagementSettings).not.toHaveBeenCalled();
  });

  it('saves thresholds and tier styles without gathering-role fields', async () => {
    const saved = { ...settings, coreMinimum: 65, calculationRulesVersion: 3 };
    vi.mocked(settingsAPI.updateEngagementSettings).mockResolvedValue({ data: { settings: saved } } as never);
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<RegularitySettings settings={settings} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Core minimum'), { target: { value: '65' } });
    fireEvent.change(screen.getByLabelText('Core label'), { target: { value: 'Committed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save regularity settings' }));

    await waitFor(() => expect(settingsAPI.updateEngagementSettings).toHaveBeenCalledWith({
      coreMinimum: 65,
      casualMinimum: 20,
      tiers: {
        core: { label: 'Committed', colour: '#16A34A' },
        casual: settings.tiers.casual,
        irregular: settings.tiers.irregular,
      },
    }));
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
  });

  it('disables saving while a request is in progress and presents request errors', async () => {
    let rejectSave!: (reason?: unknown) => void;
    vi.mocked(settingsAPI.updateEngagementSettings).mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject; }) as never);
    render(<RegularitySettings settings={settings} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save regularity settings' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => rejectSave({ response: { data: { error: 'The settings could not be saved.' } } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The settings could not be saved.');
  });
});
