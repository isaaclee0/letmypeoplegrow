import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { gatheringsAPI, peopleSyncAPI, settingsAPI } from '../../services/api';
import PeopleSyncSetup from './PeopleSyncSetup';

vi.mock('../../services/api', () => ({
  gatheringsAPI: { getAll: vi.fn() },
  peopleSyncAPI: { getSettings: vi.fn(), updateSettings: vi.fn() },
  settingsAPI: { updateIntegrationSettings: vi.fn() },
}));
vi.mock('./AuthorityReviewWorkspace', () => ({ default: ({ activateInitialSync }: any) => <p>Starting sync {String(activateInitialSync)}</p> }));
vi.mock('../planningCenter/PlanningCenterBatchEditor', () => ({ default: ({ onSaved, defaultScheduleEnabled }: any) => <button onClick={() => onSaved({ id: 42, scheduleEnabled: true })}>Save Planning Center mapping {String(defaultScheduleEnabled)}</button> }));
vi.mock('../elvanto/ElvantoBatchEditor', () => ({ default: ({ onSaved, gatherings, defaultScheduleEnabled }: any) => <button onClick={() => onSaved({ id: 43, scheduleEnabled: true })}>Save Elvanto mapping {gatherings[0]?.name} {String(defaultScheduleEnabled)}</button> }));

function Location() { return <p>{useLocation().pathname}</p>; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({ data: { settings: { authorityProvider: 'none', syncEnabled: true } } } as never);
  vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatherings: [{ id: 1, name: 'Youth' }] } } as never);
  vi.mocked(settingsAPI.updateIntegrationSettings).mockResolvedValue({ data: {} } as never);
  vi.mocked(peopleSyncAPI.updateSettings).mockResolvedValue({ data: {} } as never);
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
