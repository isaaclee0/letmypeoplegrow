import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import OnboardingPeopleStep from './OnboardingPeopleStep';
import type { GuidedOnboardingState } from '../../services/api';
import type { PeopleImportSummary } from '../people/AddPeopleModal';
const { api, rollback } = vi.hoisted(() => ({
  api: { people: vi.fn(), settings: vi.fn(), pco: vi.fn(), sources: vi.fn(), milestone: vi.fn() },
  rollback: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  individualsAPI: { getAll: api.people }, peopleSyncAPI: { getSettings: api.settings },
  integrationsAPI: { getPlanningCenterStatus: api.pco }, peopleImportAPI: { listSources: api.sources },
  csvImportAPI: {}, gatheringsAPI: {}, elvantoSyncAPI: {}, settingsAPI: {}, familiesAPI: {},
}));
vi.mock('../people/AddPeopleModal', () => ({
  default: ({ initialMethod, onSuccess }: {
    initialMethod: GuidedOnboardingState['peopleMethod']; onSuccess: (summary?: PeopleImportSummary) => Promise<void>;
  }) => initialMethod === 'csv'
    ? <button onClick={() => void onSuccess({ imported: 2, duplicates: 1, skipped: 0 }).catch(rollback)}>Apply spreadsheet</button>
    : <button onClick={() => void onSuccess().catch(rollback)}>Save person</button>,
}));
beforeEach(() => {
  vi.clearAllMocks();
  api.people.mockResolvedValue({ data: { people: [] } });
  api.settings.mockResolvedValue({ data: { settings: { authorityProvider: 'none', peopleEditingLocked: true } } });
  api.pco.mockResolvedValue({ data: { enabled: true, configured: true, connected: false } });
  api.sources.mockResolvedValue({ data: { sources: [], allOption: { kind: 'all', name: 'Everyone' } } });
  api.milestone.mockResolvedValue(undefined);
});
function Harness({ initialState = { step: 'people' } }: { initialState?: GuidedOnboardingState }) {
  const [state, setState] = useState(initialState);
  return <OnboardingPeopleStep state={state} status={{ version: 2, required: true, state, gatheringCount: 1, standardGatheringCount: 1, populatedFamilyCount: 0, canFinish: false }} gatherings={[]} onStateChange={async next => setState(next)} onPeopleAdded={api.milestone} onContinue={async () => {}} onBack={async () => {}} />;
}
it('explains sync and one-time import after choosing a provider', async () => {
  render(<Harness />);
  await userEvent.click(await screen.findByRole('button', { name: 'Elvanto' }));
  expect(screen.getByRole('button', { name: /Keep using Elvanto/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /one-time import/i })).toBeInTheDocument();
  expect(screen.getByText(/Later changes in Elvanto will not be synchronised/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('button', { name: 'Planning Center' })).toBeInTheDocument();
});
it('offers all three local methods after choosing no provider', async () => {
  render(<Harness />);
  await userEvent.click(await screen.findByRole('button', { name: 'No' }));
  expect(screen.getByRole('button', { name: /Add people manually/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Upload a spreadsheet/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Copy and paste/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Download template/ })).toBeInTheDocument();
});
it('does not offer a disabled Planning Center integration as a working connection', async () => {
  api.pco.mockResolvedValue({ data: { enabled: false, configured: false, connected: false } });
  render(<Harness />);
  expect(await screen.findByRole('button', { name: 'Planning Center' })).toBeDisabled();
  expect(screen.getByText(/Planning Center isn't available/)).toBeInTheDocument();
});

it.each(['milestone', 'people'] as const)('keeps a saved person when the %s refresh fails and retries both reads', async (failedRead) => {
  render(<Harness initialState={{ step: 'people', provider: null, peopleMethod: 'person' }} />);
  const save = await screen.findByRole('button', { name: 'Save person' });
  api.people.mockResolvedValue({ data: { people: [{ id: 3, firstName: 'Saved', lastName: 'Person', peopleType: 'regular' }] } });
  api[failedRead].mockRejectedValueOnce(new Error('Temporarily offline'));
  await userEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent(/changes were saved.*Temporarily offline/i);
  expect(rollback).not.toHaveBeenCalled();
  expect(screen.queryByText('No people have been added yet')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save person' })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Your people are here')).toBeInTheDocument();
  expect(api.people).toHaveBeenCalledTimes(3);
  expect(api.milestone).toHaveBeenCalledTimes(2);
});

it('shows the server counts after a spreadsheet import refreshes the roster', async () => {
  render(<Harness initialState={{ step: 'people', provider: null, peopleMethod: 'csv' }} />);
  const apply = await screen.findByRole('button', { name: 'Apply spreadsheet' });
  api.people.mockResolvedValue({ data: { people: [{ id: 3, firstName: 'Saved', lastName: 'Person', peopleType: 'regular' }] } });
  await userEvent.click(apply);
  expect(await screen.findByText('2 added · 1 existing match · 0 skipped')).toBeInTheDocument();
});
