import React, { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { PeopleSyncPlan, PeopleSyncReview } from '../components/peopleSync/types';
import { peopleSyncAPI } from '../services/api';

const authState = vi.hoisted(() => ({ role: 'admin' }));

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    user: {
      id: 1,
      role: authState.role,
      firstName: 'Admin',
      lastName: 'Reviewer',
      gatheringAssignments: [],
      unreadNotifications: 0,
      isChurchApproved: true,
    },
    isAuthenticated: true,
    isLoading: false,
    needsOnboarding: false,
    myChurches: [],
    logout: vi.fn(),
    updateUser: vi.fn(),
    switchChurch: vi.fn(),
    login: vi.fn(),
    refreshOnboardingStatus: vi.fn(),
    refreshUserData: vi.fn(),
    refreshTokenAndUserData: vi.fn(),
  }),
}));
vi.mock('../contexts/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => children,
  useWebSocket: () => ({ isOfflineMode: false, connectionStatus: 'connected' }),
}));
vi.mock('../contexts/PWAUpdateContext', () => ({
  PWAUpdateProvider: ({ children }: { children: React.ReactNode }) => children,
  usePWAUpdate: () => ({ showUpdateNotification: false, performUpdate: vi.fn() }),
}));
vi.mock('../contexts/CheckInsContext', () => ({
  CheckInsProvider: ({ children }: { children: React.ReactNode }) => children,
  useCheckIns: () => ({ isLocked: false }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => children,
  useSettings: () => ({}),
}));
vi.mock('../contexts/SmartCacheContext', () => ({
  SmartCacheProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../utils/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../services/userPreferences', () => ({ userPreferences: {} }));
vi.mock('./SettingsPage', () => ({ default: () => <div>Integration settings destination</div> }));
vi.mock('./AttendancePage', () => ({ default: () => <div>Attendance destination</div> }));
vi.mock('../services/api', () => ({
  aiAPI: { getStatus: vi.fn().mockResolvedValue({ data: { configured: false } }) },
  gatheringsAPI: { getAll: vi.fn().mockResolvedValue({ data: { gatherings: [] } }) },
  notificationsAPI: { getAll: vi.fn(), markAsRead: vi.fn() },
  usersAPI: {
    getPreferences: vi.fn().mockResolvedValue({ data: { preferences: {} } }),
    savePreference: vi.fn(),
    savePreferences: vi.fn(),
  },
  peopleSyncAPI: {
    previewAuthority: vi.fn(),
    cancelAuthorityPreview: vi.fn(),
    applyAuthority: vi.fn(),
    getSettings: vi.fn(),
  },
}));

const plan: PeopleSyncPlan = {
  provider: 'planning_center',
  authoritative: true,
  snapshot: { fetchedAt: '2026-08-04T02:00:00.000Z', mode: 'full' },
  people: { external: {}, local: {} },
  reviewContext: { version: 2, manualCandidateIndividualIds: [], identities: {} },
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
};

const review: PeopleSyncReview = {
  runId: 81,
  reviewToken: 'first-batch-authority-token',
  decisionContractVersion: 2,
  plan,
  snapshot: plan.snapshot,
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0,
    moveFamily: 0, renameFamily: 0, addToGathering: 0, removeFromGathering: 0,
    ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
  authority: { active: 'none', pending: 'planning_center' },
  authorityPreviewId: 'first-batch-preview-81',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderRoute(path: string, { role = 'admin', strict = false } = {}) {
  authState.role = role;
  window.history.pushState({}, '', path);
  return render(strict ? <StrictMode><App /></StrictMode> : <App />);
}

describe('PeopleSyncAuthorityReviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = 'admin';
    window.history.pushState({}, '', '/');
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 81, status: 'applied', applied: {} as never, summary: review.summary },
    });
    vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({
      data: { success: true, settings: { authorityProvider: 'planning_center' } as never },
    });
  });

  it('registers the admin-only route inside the existing app shell', async () => {
    renderRoute('/app/settings/integrations/planning-center/authority-review?reason=first-batch');

    expect(await screen.findByRole('heading', { name: 'Review Planning Center as source of truth' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'People' }).length).toBeGreaterThan(0);
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('redirects a non-admin before starting provider work', async () => {
    renderRoute('/app/settings/integrations/planning-center/authority-review?reason=first-batch', { role: 'coordinator' });

    await waitFor(() => expect(window.location.pathname).toBe('/app/attendance'));
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('redirects an invalid provider to integration settings without previewing', async () => {
    renderRoute('/app/settings/integrations/not-a-provider/authority-review?reason=first-batch');

    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe('/app/settings?tab=integrations'));
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('warns about authoritative lifecycle changes and preserves the other connection', async () => {
    renderRoute('/app/settings/integrations/planning-center/authority-review?reason=first-batch');

    expect(await screen.findByText(/added, updated, archived, or reactivated/i)).toBeInTheDocument();
    expect(screen.getByText(/other provider stays connected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review and enable source of truth' })).toBeInTheDocument();
  });

  it('returns directly to the provider panel when the warning is cancelled before preview', async () => {
    renderRoute('/app/settings/integrations/planning-center/authority-review?reason=first-batch');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`)
      .toBe('/app/settings?tab=integrations&integration=planning-center'));
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('starts exactly one preview after confirmation under React Strict Mode', async () => {
    renderRoute('/app/settings/integrations/planning-center/authority-review?reason=first-batch', { strict: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Review and enable source of truth' }));

    expect(await screen.findByRole('region', { name: 'Planning Center authority review' })).toBeInTheDocument();
    expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledTimes(1);
    expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('planning_center');
  });

  it('waits for exact cancellation of a late preview before returning to the provider panel', async () => {
    const previewRequest = deferred<{ data: { success: true } & PeopleSyncReview }>();
    const cancellationRequest = deferred<{ data: { success: true; authority: { active: 'none'; pending: null } } }>();
    vi.mocked(peopleSyncAPI.previewAuthority).mockReturnValue(previewRequest.promise);
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReturnValue(cancellationRequest.promise);
    renderRoute('/app/settings/integrations/planning-center/authority-review?reason=first-batch');
    fireEvent.click(await screen.findByRole('button', { name: 'Review and enable source of truth' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel authority change' }));

    expect(window.location.pathname).toContain('/authority-review');
    await act(async () => previewRequest.resolve({
      data: { ...review, success: true, authorityPreviewId: 'late-first-batch-preview' },
    }));
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview)
      .toHaveBeenCalledWith('planning_center', 'late-first-batch-preview'));
    expect(window.location.pathname).toContain('/authority-review');

    await act(async () => cancellationRequest.resolve({
      data: { success: true, authority: { active: 'none', pending: null } },
    }));
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`)
      .toBe('/app/settings?tab=integrations&integration=planning-center'));
  });

  it('returns to the matching provider panel only after apply status refresh succeeds', async () => {
    renderRoute('/app/settings/integrations/elvanto/authority-review?reason=first-batch');
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({
      data: { success: true, ...review, plan: { ...plan, provider: 'elvanto' }, authority: { active: 'none', pending: 'elvanto' } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Review and enable source of truth' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 0 selected changes' }));

    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`)
      .toBe('/app/settings?tab=integrations&integration=elvanto'));
    expect(peopleSyncAPI.getSettings).toHaveBeenCalledTimes(1);
  });

  it('stays in the completed review when status refresh fails and returns after retry', async () => {
    vi.mocked(peopleSyncAPI.getSettings).mockRejectedValueOnce(new Error('Status unavailable'));
    renderRoute('/app/settings/integrations/planning-center/authority-review?reason=first-batch');
    fireEvent.click(await screen.findByRole('button', { name: 'Review and enable source of truth' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 0 selected changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/applied, but its status could not be refreshed: Status unavailable/i);
    expect(window.location.pathname).toContain('/authority-review');
    expect(screen.queryByRole('button', { name: 'Apply 0 selected changes' })).not.toBeInTheDocument();

    vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({
      data: { success: true, settings: { authorityProvider: 'planning_center' } as never },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry status refresh' }));
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`)
      .toBe('/app/settings?tab=integrations&integration=planning-center'));
  });
});
