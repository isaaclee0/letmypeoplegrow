import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import GuidedOnboardingPage from './GuidedOnboardingPage';

const { api, auth, guided, gathering } = vi.hoisted(() => ({
  api: { getStatus: vi.fn(), getAll: vi.fn(), saveGuidedProgress: vi.fn(), complete: vi.fn(), startGuided: vi.fn() },
  auth: { user: { id: 1, church_id: 'church', timezone: 'Australia/Hobart' }, refreshUserData: vi.fn(), refreshOnboardingStatus: vi.fn() },
  guided: { version: 2, required: true, state: { step: 'gathering-created', lastGatheringId: 7 }, gatheringCount: 1, standardGatheringCount: 0, populatedFamilyCount: 0, canFinish: true },
  gathering: { id: 7, name: 'Sunday', attendanceType: 'headcount', isActive: true },
}));
vi.mock('../services/api', () => ({ onboardingAPI: api, gatheringsAPI: { getAll: api.getAll } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/onboarding/GatheringWizard', () => ({ default: () => <p>New gathering form</p> }));
vi.mock('../components/onboarding/OnboardingPeopleStep', () => ({ default: () => <p>People options</p> }));

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  guided.state = { step: 'gathering-created', lastGatheringId: 7 };
  guided.gatheringCount = 1; guided.standardGatheringCount = 0; guided.populatedFamilyCount = 0; guided.canFinish = true;
  api.getStatus.mockImplementation(async () => ({ data: { completed: 0, guided: { ...guided } } }));
  api.getAll.mockResolvedValue({ data: { gatherings: [gathering] } });
  api.saveGuidedProgress.mockImplementation(async (state) => ({ data: { guided: { ...guided, state } } }));
  api.complete.mockResolvedValue({ data: {} });
});
function show(path = '/app/onboarding') {
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/onboarding" element={<GuidedOnboardingPage />} /><Route path="/app/attendance" element={<p>Attendance ready</p>} /></Routes></MemoryRouter>);
}

it('finishes headcount setup without requiring a person or family', async () => {
  show();
  await screen.findByText(/Want to create another gathering/i);
  expect(screen.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
  expect(await screen.findByText('Attendance ready')).toBeInTheDocument();
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(api.saveGuidedProgress).toHaveBeenLastCalledWith(expect.objectContaining({ inviteDeferred: true }));
});

it('offers people when any gathering tracks names, even if the last one is headcount', async () => {
  guided.standardGatheringCount = 1; guided.canFinish = false;
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Add people' }));
  expect(await screen.findByText('People options')).toBeInTheDocument();
  expect(api.complete).not.toHaveBeenCalled();
});

it('does not offer invitations when resumed progress is ahead of saved people', async () => {
  guided.state.step = 'invite'; guided.standardGatheringCount = 1; guided.canFinish = false;
  show();
  expect(await screen.findByText('People options')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Invite users' })).not.toBeInTheDocument();
});

it('keeps a completion failure retryable without leaving setup', async () => {
  guided.state.step = 'invite'; api.complete.mockRejectedValueOnce(new Error('offline'));
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/offline|finish/i));
  expect(screen.queryByText('Attendance ready')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  expect(await screen.findByText('Attendance ready')).toBeInTheDocument();
});

it('recovers a second gathering saved before its progress update', async () => {
  guided.state = { step: 'gathering', lastGatheringId: 7 };
  guided.gatheringCount = 2;
  api.getAll.mockResolvedValue({ data: { gatherings: [
    { ...gathering, id: 9, name: 'Midweek' }, gathering, { ...gathering, id: 11, name: 'Archived', isActive: false },
  ] } });
  show();
  expect(await screen.findByText('Midweek is ready.')).toBeInTheDocument();
  expect(screen.queryByText('New gathering form')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('button', { name: 'Not now' });
  expect(api.saveGuidedProgress).toHaveBeenCalledWith(expect.objectContaining({ lastGatheringId: 9 }));
});

it('keeps an intentional create-another step when no new gathering has saved', async () => {
  guided.state = { step: 'gathering', lastGatheringId: 7 };
  show();
  expect(await screen.findByText('New gathering form')).toBeInTheDocument();
});

it('retries attendance handoff without rewriting progress when completion committed but its response was lost', async () => {
  guided.state.step = 'invite';
  api.complete.mockImplementationOnce(async () => {
    api.getStatus.mockResolvedValue({ data: { completed: 1, guided: { ...guided, required: false, state: { ...guided.state, inviteDeferred: true } } } });
    throw new Error('Response lost');
  });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Response lost');
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  expect(await screen.findByText('Attendance ready')).toBeInTheDocument();
  expect(api.saveGuidedProgress).toHaveBeenCalledTimes(1);
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('invite_hint:church:1')).toBe('show');
});

it('retries failed account refresh after completion without reapplying it', async () => {
  guided.state.step = 'invite';
  api.complete.mockImplementationOnce(async () => {
    api.getStatus.mockResolvedValue({ data: { completed: 1, guided: { ...guided, required: false } } });
  });
  auth.refreshUserData.mockRejectedValueOnce(new Error('Account unavailable'));
  show('/app/onboarding?invited=1');
  fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Account unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  expect(await screen.findByText('Attendance ready')).toBeInTheDocument();
  expect(auth.refreshUserData).toHaveBeenCalledWith(true);
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(api.saveGuidedProgress).toHaveBeenCalledTimes(1);
});

it('does not treat a legacy completion flag as successful guided completion', async () => {
  guided.state.step = 'invite';
  show();
  const finish = await screen.findByRole('button', { name: 'Not now' });
  api.getStatus.mockResolvedValue({ data: { completed: 1, guided: { ...guided, version: 0, required: false } } });
  fireEvent.click(finish);
  expect(await screen.findByRole('alert')).toHaveTextContent(/setup progress is unavailable/i);
  expect(api.complete).not.toHaveBeenCalled();
  expect(api.saveGuidedProgress).not.toHaveBeenCalled();
});
