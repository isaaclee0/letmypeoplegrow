import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, gatheringsAPI, integrationsAPI, peopleSyncAPI, settingsAPI } from '../../services/api';
import PeopleSyncSetup from './PeopleSyncSetup';

vi.mock('../../services/api', () => ({
  gatheringsAPI: { getAll: vi.fn() },
  integrationsAPI: { getPlanningCenterSyncBatches: vi.fn() },
  elvantoSyncAPI: { listBatches: vi.fn() },
  peopleSyncAPI: { getSettings: vi.fn(), updateSettings: vi.fn() },
  settingsAPI: { updateIntegrationSettings: vi.fn() },
}));
vi.mock('./AuthorityReviewWorkspace', () => ({ default: ({ activateInitialSync, onApplied }: any) => <><p>Starting sync {String(activateInitialSync)}</p><button onClick={onApplied}>Finish review</button></> }));
vi.mock('../planningCenter/PlanningCenterBatchEditor', () => ({ default: ({ onSaved, defaultScheduleEnabled, defaultGatheringId }: any) => <><button onClick={() => onSaved({ id: 42, scheduleEnabled: true })}>Save Planning Center mapping {String(defaultScheduleEnabled)}</button>{defaultGatheringId && <p>Gathering target {defaultGatheringId}</p>}</> }));
vi.mock('../elvanto/ElvantoBatchEditor', () => ({ default: ({ onSaved, gatherings, defaultScheduleEnabled }: any) => <button onClick={() => onSaved({ id: 43, scheduleEnabled: true })}>Save Elvanto mapping {gatherings[0]?.name} {String(defaultScheduleEnabled)}</button> }));

function Location() { return <p>{useLocation().pathname}</p>; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({ data: { settings: { authorityProvider: 'none', syncEnabled: true } } } as never);
  vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatherings: [{ id: 1, name: 'Youth' }] } } as never);
  vi.mocked(settingsAPI.updateIntegrationSettings).mockResolvedValue({ data: {} } as never);
  vi.mocked(peopleSyncAPI.updateSettings).mockResolvedValue({ data: {} } as never);
  vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({ data: { batches: [] } } as never);
  vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({ data: { batches: [] } } as never);
});

it('starts a scheduled first mapping automatically', async () => {
  render(<MemoryRouter><PeopleSyncSetup provider="planning_center" onCancel={vi.fn()} /></MemoryRouter>);
  fireEvent.click(await screen.findByText('Save Planning Center mapping true'));
  expect(await screen.findByText('Starting sync true')).toBeInTheDocument();
  expect(settingsAPI.updateIntegrationSettings).toHaveBeenCalledWith({ planningCenterSyncEnabled: true });
});

it('reviews a new mapping directly when Elvanto already manages people', async () => {
  vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({ data: { settings: { authorityProvider: 'elvanto', syncEnabled: true } } } as never);
  render(<MemoryRouter><PeopleSyncSetup provider="elvanto" onCancel={vi.fn()} /><Location /></MemoryRouter>);
  fireEvent.click(await screen.findByText('Save Elvanto mapping Youth true'));
  expect(await screen.findByRole('link', { name: 'Review and activate sync' })).toHaveAttribute('href', '/app/settings/integrations/elvanto/batches/43/review');
});

it('retries scheduling failure without creating another mapping', async () => {
  vi.mocked(settingsAPI.updateIntegrationSettings).mockRejectedValueOnce(new Error('Unavailable'));
  render(<MemoryRouter><PeopleSyncSetup provider="planning_center" onCancel={vi.fn()} /></MemoryRouter>);
  fireEvent.click(await screen.findByText('Save Planning Center mapping true'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
  expect(screen.queryByText('Save Planning Center mapping true')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Starting sync true')).toBeInTheDocument();
});

it('blocks setup when sync settings cannot be checked', async () => {
  vi.mocked(peopleSyncAPI.getSettings).mockRejectedValueOnce(new Error('Unavailable'));
  render(<MemoryRouter><PeopleSyncSetup provider="planning_center" onCancel={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
  expect(screen.queryByText('Save Planning Center mapping true')).not.toBeInTheDocument();
});

it('resumes a saved source draft through authority review before creating any new mapping', async () => {
  vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
    data: { batches: [{ id: 31, operationalState: 'source_review_required' }] },
  } as never);
  render(<MemoryRouter><PeopleSyncSetup provider="planning_center" resumeSetup onCancel={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Review and activate sync' })).toHaveAttribute('href', '/app/settings/integrations/planning-center/authority-review?reason=first-batch');
  expect(screen.queryByText('Save Planning Center mapping true')).not.toBeInTheDocument();
  expect(settingsAPI.updateIntegrationSettings).not.toHaveBeenCalled();
});

it('requires explicit authority review when the saved mapping belongs to another provider', async () => {
  vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({
    data: { settings: { authorityProvider: 'elvanto', syncEnabled: true } },
  } as never);
  vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
    data: { batches: [{ id: 31, operationalState: 'prepared' }] },
  } as never);
  render(<MemoryRouter><PeopleSyncSetup provider="planning_center" resumeSetup onCancel={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Review and activate sync' })).toHaveAttribute('href', '/app/settings/integrations/planning-center/authority-review');
});

it('continues onboarding from an active mapping without creating a new batch', async () => {
  vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({
    data: { settings: { authorityProvider: 'elvanto', syncEnabled: true } },
  } as never);
  vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({
    data: { batches: [{ id: 22, operationalState: 'active' }] },
  } as never);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const onComplete = vi.fn(() => pending);
  render(<MemoryRouter><PeopleSyncSetup provider="elvanto" resumeSetup onComplete={onComplete} onCancel={vi.fn()} /></MemoryRouter>);
  const continueButton = await screen.findByRole('button', { name: 'Continue' });
  fireEvent.click(continueButton);
  expect(continueButton).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  fireEvent.click(continueButton);
  expect(onComplete).toHaveBeenCalledOnce();
  expect(screen.queryByText('Save Elvanto mapping Youth true')).not.toBeInTheDocument();
  await act(async () => { finish(); });
  expect(continueButton).toBeEnabled();
});

it('keeps setup closed while saved batches cannot be checked', async () => {
  vi.mocked(elvantoSyncAPI.listBatches).mockRejectedValueOnce(new Error('Unavailable'));
  render(<MemoryRouter><PeopleSyncSetup provider="elvanto" resumeSetup onCancel={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
  expect(screen.queryByText('Save Elvanto mapping Youth true')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Save Elvanto mapping Youth true')).toBeInTheDocument();
});

it('passes the onboarding gathering target and reports a successfully applied first sync', async () => {
  const onComplete = vi.fn();
  render(<MemoryRouter><PeopleSyncSetup provider="planning_center" resumeSetup defaultGatheringId={1} onComplete={onComplete} onCancel={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByText('Gathering target 1')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Save Planning Center mapping true'));
  fireEvent.click(await screen.findByRole('button', { name: 'Finish review' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
});
