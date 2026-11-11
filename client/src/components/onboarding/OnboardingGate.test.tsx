import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingGate from './OnboardingGate';

const { getStatus, auth } = vi.hoisted(() => ({
  getStatus: vi.fn(), auth: { user: { id: 1, church_id: 'test', role: 'admin' } },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../services/api', () => ({ onboardingAPI: { getStatus } }));

function renderGate(path = '/app/gatherings') {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/app/onboarding" element={<p>Guided setup</p>} />
    <Route path="*" element={<OnboardingGate><p>Existing app</p></OnboardingGate>} />
  </Routes></MemoryRouter>);
}

describe('onboarding entry', () => {
  beforeEach(() => { vi.clearAllMocks(); auth.user.role = 'admin'; });
  it('takes a new approved administrator into setup before showing the gathering editor', async () => {
    getStatus.mockResolvedValue({ data: { guided: { required: true } } });
    renderGate();
    expect(screen.queryByText('Existing app')).not.toBeInTheDocument();
    expect(await screen.findByText('Guided setup')).toBeInTheDocument();
  });
  it('does not enroll a legacy church with an unfinished old onboarding flag', async () => {
    getStatus.mockResolvedValue({ data: { completed: false, guided: { required: false } } });
    renderGate();
    expect(await screen.findByText('Existing app')).toBeInTheDocument();
  });
  it('keeps a failed status check on a retry screen', async () => {
    getStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { guided: { required: true } } });
    renderGate();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Guided setup')).toBeInTheDocument();
    expect(screen.queryByText('Existing app')).not.toBeInTheDocument();
  });
  it('leaves invited attendance takers on their normal route', () => {
    auth.user.role = 'attendance_taker';
    renderGate('/app/attendance');
    expect(screen.getByText('Existing app')).toBeInTheDocument();
    expect(getStatus).not.toHaveBeenCalled();
  });
  it('allows required provider reviews and shows a return to setup', async () => {
    getStatus.mockResolvedValue({ data: { guided: { required: true } } });
    renderGate('/app/settings/integrations/planning-center/authority-review');
    expect(await screen.findByText('Existing app')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /return to setup/i })).toHaveAttribute('href', '/app/onboarding');
  });
  it.each(['elvanto', 'planning-center'])('allows %s sync settings for a saved mapping recovery', async (provider) => {
    getStatus.mockResolvedValue({ data: { guided: { required: true } } });
    renderGate(`/app/settings?tab=integrations&integration=${provider}`);
    expect(await screen.findByText('Existing app')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /return to setup/i })).toHaveAttribute('href', '/app/onboarding');
  });
  it.each(['/app/settings?tab=general&integration=elvanto', '/app/settings?tab=integrations', '/app/settings?tab=integrations&integration=other'])(
    'continues to gate unrelated settings at %s', async (path) => {
      getStatus.mockResolvedValue({ data: { guided: { required: true } } });
      renderGate(path);
      expect(await screen.findByText('Guided setup')).toBeInTheDocument();
    },
  );
});
