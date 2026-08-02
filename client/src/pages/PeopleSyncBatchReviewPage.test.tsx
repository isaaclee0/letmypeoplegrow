import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleProtectedRoute } from '../App';
import Layout from '../components/Layout';
import ToastContainer from '../components/ToastContainer';
import type {
  EstablishedLinkCorrection,
  IdentityReviewEntry,
  PeopleSyncBatch,
  PeopleSyncCorrectionPreview,
  PeopleSyncPlan,
  PeopleSyncPlanSummary,
  PeopleSyncReview,
  SyncProvider,
} from '../components/peopleSync/types';
import { elvantoSyncAPI, integrationsAPI } from '../services/api';
import PeopleSyncBatchReviewPage from './PeopleSyncBatchReviewPage';

class RouterRequest {
  url: string;
  method: string;
  signal: AbortSignal;
  headers: Headers;

  constructor(input: string | URL | RouterRequest, init: RequestInit = {}) {
    this.url = input instanceof RouterRequest ? input.url : input.toString();
    this.method = init.method || (input instanceof RouterRequest ? input.method : 'GET');
    this.signal = init.signal || (input instanceof RouterRequest ? input.signal : new AbortController().signal);
    this.headers = new Headers(init.headers || (input instanceof RouterRequest ? input.headers : undefined));
  }
}

vi.stubGlobal('Request', RouterRequest);

const state = vi.hoisted(() => ({
  role: 'admin',
}));

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    user: {
      id: 1, role: state.role, firstName: 'Admin', lastName: 'Reviewer',
      gatheringAssignments: [], unreadNotifications: 0,
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
  usePWAUpdate: () => ({ updateAvailable: false, showUpdateNotification: false, performUpdate: vi.fn() }),
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
vi.mock('../services/api', () => ({
  aiAPI: { getStatus: vi.fn().mockResolvedValue({ data: { configured: false } }) },
  gatheringsAPI: { getAll: vi.fn().mockResolvedValue({ data: { gatherings: [] } }) },
  notificationsAPI: { getAll: vi.fn(), markAsRead: vi.fn() },
  usersAPI: {
    getPreferences: vi.fn().mockResolvedValue({ data: { preferences: {} } }),
    savePreference: vi.fn(),
    savePreferences: vi.fn(),
  },
  integrationsAPI: {
    getPlanningCenterSyncBatches: vi.fn(),
    getPlanningCenterBatchPlan: vi.fn(),
    previewPlanningCenterLinkCorrections: vi.fn(),
    applyPlanningCenterBatch: vi.fn(),
  },
  elvantoSyncAPI: {
    listBatches: vi.fn(),
    getBatchPlan: vi.fn(),
    previewLinkCorrections: vi.fn(),
    applyBatch: vi.fn(),
  },
}));

const emptyBuckets = (): Omit<PeopleSyncPlan, 'provider' | 'authoritative' | 'snapshot'> => ({
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
});

const summaryFor = (plan: PeopleSyncPlan): PeopleSyncPlanSummary => Object.fromEntries(
  Object.entries(plan)
    .filter(([key]) => !['provider', 'authoritative', 'snapshot', 'people', 'reviewContext'].includes(key))
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
) as PeopleSyncPlanSummary;

const identity = (overrides: Partial<IdentityReviewEntry> = {}): IdentityReviewEntry => ({
  suggestedIndividualId: 7,
  candidateIndividualIds: [7],
  excludedIndividualIds: [],
  held: false,
  canCreate: true,
  createPerson: {
    firstName: 'Alex', lastName: 'Smith', isChild: false,
    externalFamilyId: null, peopleType: 'regular',
  },
  ...overrides,
});

function reviewFor({
  provider = 'planning_center',
  token = 'base-review-token',
  runId = 7,
  attention = false,
  established = false,
  updateTarget,
}: {
  provider?: SyncProvider;
  token?: string;
  runId?: number;
  attention?: boolean;
  established?: boolean;
  updateTarget?: 30 | 42;
} = {}): PeopleSyncReview {
  const plan: PeopleSyncPlan = {
    ...emptyBuckets(),
    provider,
    authoritative: true,
    snapshot: { fetchedAt: '2026-08-02T01:00:00.000Z', mode: 'full' },
    people: {
      external: {
        'ext-auto': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } },
        ...(attention ? { 'ext-attention': { firstName: 'Blair', lastName: 'Jones', family: { state: 'none' } } } : {}),
        ...(established ? { 'ext-established': { firstName: 'Established', lastName: 'Source', family: { state: 'none' } } } : {}),
      },
      local: {
        '7': { firstName: 'Alex', lastName: 'Smith', matchEligible: true, family: { state: 'none' } },
        '8': { firstName: 'Taylor', lastName: 'Reed', matchEligible: true, family: { state: 'none' } },
        '9': { firstName: 'Jordan', lastName: 'Lee', matchEligible: true, family: { state: 'none' } },
        '30': { firstName: 'Replacement', lastName: 'Local', matchEligible: true, family: { state: 'none' } },
        '40': { firstName: 'Current', lastName: 'Link', matchEligible: false, family: { state: 'none' } },
        '42': { firstName: 'Alternative', lastName: 'Local', matchEligible: true, family: { state: 'none' } },
      },
    },
    reviewContext: {
      version: 2,
      correctionContractVersion: 1,
      manualCandidateIndividualIds: [7, 8, 9, 30, 42],
      identities: {
        'ext-auto': identity(),
        ...(attention ? {
          'ext-attention': identity({
            suggestedIndividualId: null,
            candidateIndividualIds: [8, 9],
            held: true,
            createPerson: {
              firstName: 'Blair', lastName: 'Jones', isChild: false,
              externalFamilyId: null, peopleType: 'regular',
            },
          }),
        } : {}),
      },
      ...(established ? {
        establishedLinks: { 'ext-established': { individualId: 40 } },
        projectedEstablishedLinks: {
          'ext-established': { individualId: updateTarget ?? 40 },
        },
        linkCorrections: updateTarget ? [{
          externalPersonId: 'ext-established',
          outcome: 'relink' as const,
          fromIndividualId: 40,
          individualId: updateTarget,
        }] : [],
      } : {}),
    },
    linkPeople: [{
      id: 'link:ext-auto', externalPersonId: 'ext-auto', individualId: 7,
      reason: 'unique_name', reviewRequired: false,
    }],
    ...(attention ? {
      ambiguousPeople: [{
        id: 'ambiguous:ext-attention', externalPersonId: 'ext-attention',
        reason: 'duplicate_name', candidateIndividualIds: [8, 9],
      }],
    } : {}),
    ...(updateTarget ? {
      updateManagedFields: [{
        id: `update:${updateTarget}`,
        externalPersonId: 'ext-established',
        individualId: updateTarget,
        changes: [{ field: 'firstName', localValue: 'Old', externalValue: 'Updated' }],
        reason: 'provider_managed_fields',
        reviewRequired: false,
      }],
    } : {}),
  };
  return {
    runId,
    reviewToken: token,
    decisionContractVersion: 2,
    summary: summaryFor(plan),
    plan,
    snapshot: plan.snapshot,
  };
}

function correctionPreview(target: 30 | 42, token: string): PeopleSyncCorrectionPreview {
  const review = reviewFor({ token, established: true, updateTarget: target });
  const { runId: _runId, ...preview } = review;
  return preview;
}

function batchFor(provider: SyncProvider, id = 7): PeopleSyncBatch {
  return {
    id,
    provider,
    name: provider === 'planning_center' ? `Members ${id}` : `Elvanto members ${id}`,
    enabled: true,
    source: {
      kind: provider === 'planning_center' ? 'planning_center_list' : 'elvanto_category',
      externalId: 'source-active',
      name: 'Active adults',
      memberCount: 75,
      providerRefreshedAt: null,
    },
    sourceRevision: 2,
    draftSource: {
      kind: provider === 'planning_center' ? 'planning_center_list' : 'elvanto_group',
      externalId: 'source-draft',
      name: 'Draft families',
      memberCount: 82,
      providerRefreshedAt: null,
    },
    draftSourceBaseRevision: 2,
    draftSourceUpdatedAt: '2026-08-02T00:00:00.000Z',
    needsSourceReview: true,
    initialSourceReviewPending: false,
    sourceStatus: 'available',
    sourceStatusCheckedAt: null,
    sourceStatusErrorCode: null,
    defaultPeopleType: 'regular',
    gatheringTypeId: null,
    gatheringAutoRemoveEnabled: false,
    scheduleEnabled: false,
    scheduleFrequency: 'weekly',
    scheduleDay: 1,
    legacyProviderBatchId: null,
    lastExternalWatermark: null,
    lastSyncAt: null,
    lastSyncResult: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderRoute(path: string, role = 'admin') {
  state.role = role;
  const router = createMemoryRouter([{
    path: '/app',
    element: <Layout />,
    children: [
      {
        path: 'settings/integrations/:provider/batches/:batchId/review',
        element: <RoleProtectedRoute allowedRoles={['admin']}><PeopleSyncBatchReviewPage /></RoleProtectedRoute>,
      },
      { path: 'settings', element: <div>Integration settings destination</div> },
      { path: 'attendance', element: <div>Attendance destination</div> },
    ],
  }], { initialEntries: [path] });
  render(<ToastContainer><RouterProvider router={router} /></ToastContainer>);
  return router;
}

async function chooseAlternativeForAttention() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Change LMPG match for Blair Jones' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Taylor Reed' }));
  return user;
}

async function beginEstablishedCorrection(target: 'Replacement Local' | 'Alternative Local') {
  const user = userEvent.setup();
  if (screen.getByRole('tab', { name: /Already linked/ }).getAttribute('aria-selected') !== 'true') {
    await user.click(screen.getByRole('tab', { name: /Already linked/ }));
  }
  await user.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: `Select ${target}` }));
  return user;
}

describe('PeopleSyncBatchReviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.role = 'admin';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const pcoBatch = batchFor('planning_center');
    const elvantoBatch = batchFor('elvanto');
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValue({ data: { success: true, batches: [pcoBatch] } } as never);
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValue({ data: { success: true, ...reviewFor() } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterLinkCorrections)
      .mockResolvedValue({ data: { success: true, ...correctionPreview(30, 'preview-token') } } as never);
    vi.mocked(integrationsAPI.applyPlanningCenterBatch)
      .mockResolvedValue({ data: { success: true, runId: 7, status: 'applied', applied: {}, summary: {} } } as never);
    vi.mocked(elvantoSyncAPI.listBatches)
      .mockResolvedValue({ data: { success: true, batches: [elvantoBatch] } } as never);
    vi.mocked(elvantoSyncAPI.getBatchPlan)
      .mockResolvedValue({ data: { success: true, ...reviewFor({ provider: 'elvanto' }) } } as never);
    vi.mocked(elvantoSyncAPI.previewLinkCorrections)
      .mockResolvedValue({ data: { success: true, ...correctionPreview(30, 'elvanto-preview') } } as never);
    vi.mocked(elvantoSyncAPI.applyBatch)
      .mockResolvedValue({ data: { success: true, runId: 7, status: 'applied', applied: {}, summary: {} } } as never);
  });

  it('renders the admin-only review route in the existing sidebar layout', async () => {
    renderRoute('/app/settings/integrations/planning-center/batches/7/review');

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'People' }).length).toBeGreaterThan(0);
    expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalledWith(7);
  });

  it('redirects a non-admin from the review route before loading provider data', async () => {
    renderRoute('/app/settings/integrations/planning-center/batches/7/review', 'coordinator');

    expect(await screen.findByText('Attendance destination')).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterBatchPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['/app/settings/integrations/unknown/batches/7/review', '/app/settings', '?tab=integrations'],
    ['/app/settings/integrations/planning-center/batches/not-a-number/review', '/app/settings', '?tab=integrations&integration=planning-center'],
  ])('returns invalid route context to integrations with an error', async (path, pathname, search) => {
    const router = renderRoute(path);

    expect(await screen.findByText('Integration settings destination')).toBeInTheDocument();
    expect(screen.getByText('This sync review link is invalid.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(pathname);
    expect(router.state.location.search).toBe(search);
  });

  it('loads batch metadata and prefers the draft source name beside the review', async () => {
    renderRoute('/app/settings/integrations/planning-center/batches/7/review');

    expect(await screen.findByText('Members 7')).toBeInTheDocument();
    expect(screen.getByText('Draft families')).toBeInTheDocument();
    expect(screen.queryByText('Active adults')).not.toBeInTheDocument();
  });

  it('reconstructs Elvanto provider and batch context from a direct route load', async () => {
    renderRoute('/app/settings/integrations/elvanto/batches/7/review');

    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.getByText('Elvanto members 7')).toBeInTheDocument();
    expect(elvantoSyncAPI.getBatchPlan).toHaveBeenCalledWith(7);
    expect(integrationsAPI.getPlanningCenterBatchPlan).not.toHaveBeenCalled();
  });

  it('keeps retry and back actions available after the initial plan load fails', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ data: { success: true, ...reviewFor({ token: 'retry-token' }) } } as never);
    renderRoute('/app/settings/integrations/planning-center/batches/7/review');

    expect(await screen.findByRole('alert')).toHaveTextContent('provider unavailable');
    expect(screen.getByRole('button', { name: 'Back to Planning Center' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry review' }));

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalledTimes(2);
  });

  it('uses the original base token for corrections and the effective preview token for apply', async () => {
    const base = reviewFor({ token: 'original-base', established: true });
    const preview = correctionPreview(30, 'effective-preview');
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValue({ data: { success: true, ...base } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterLinkCorrections)
      .mockResolvedValue({ data: { success: true, ...preview } } as never);
    renderRoute('/app/settings/integrations/planning-center/batches/7/review');

    await screen.findByText('Planning Center sync review');
    expect(screen.getByRole('tab', { name: 'Already linked 1' })).toBeInTheDocument();
    const user = await beginEstablishedCorrection('Replacement Local');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeEnabled());
    expect(integrationsAPI.previewPlanningCenterLinkCorrections).toHaveBeenCalledWith(7, {
      baseReviewToken: 'original-base',
      linkCorrections: {
        'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(7, expect.objectContaining({
      reviewToken: 'effective-preview',
      selections: expect.objectContaining({
        linkCorrections: {
          'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
        },
      }),
    })));
  });

  it('ignores a late plan response after route context changes', async () => {
    const latePlan = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockReturnValue(latePlan.promise as never);
    const router = renderRoute('/app/settings/integrations/planning-center/batches/7/review');
    await waitFor(() => expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalled());

    await act(async () => {
      await router.navigate('/app/settings/integrations/elvanto/batches/7/review');
    });
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();

    latePlan.resolve({ data: { success: true, ...reviewFor({ token: 'late-pco' }) } });
    await act(async () => { await latePlan.promise; });
    expect(screen.getByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.queryByText('Planning Center sync review')).not.toBeInTheDocument();
  });

  it('ignores an older correction preview after a newer preview succeeds', async () => {
    const base = reviewFor({ token: 'original-base', established: true });
    const older = deferred<{ data: { success: true } & PeopleSyncCorrectionPreview }>();
    const newer = deferred<{ data: { success: true } & PeopleSyncCorrectionPreview }>();
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValue({ data: { success: true, ...base } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterLinkCorrections)
      .mockReturnValueOnce(older.promise as never)
      .mockReturnValueOnce(newer.promise as never);
    renderRoute('/app/settings/integrations/planning-center/batches/7/review');

    await screen.findByText('Planning Center sync review');
    const user = await beginEstablishedCorrection('Replacement Local');
    await beginEstablishedCorrection('Alternative Local');
    newer.resolve({ data: { success: true, ...correctionPreview(42, 'preview-42') } });
    await waitFor(() => expect(screen.getByText('Update Alternative Local')).toBeInTheDocument());
    older.resolve({ data: { success: true, ...correctionPreview(30, 'preview-30') } });
    await waitFor(() => expect(screen.queryByText('Refreshing correction preview…')).not.toBeInTheDocument());

    expect(screen.queryByText('Update Replacement Local')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(7, expect.objectContaining({
      reviewToken: 'preview-42',
    })));
  });

  it('prompts before dirty refresh and captured sidebar navigation', async () => {
    const dirtyReview = reviewFor({ attention: true });
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValue({ data: { success: true, ...dirtyReview } } as never);
    vi.mocked(window.confirm).mockReturnValue(false);
    const router = renderRoute('/app/settings/integrations/planning-center/batches/7/review');
    await screen.findByText('Planning Center sync review');
    await chooseAlternativeForAttention();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalledTimes(1);
    const settingsLink = screen.getAllByRole('link', { name: 'Settings' })[0];
    fireEvent.click(settingsLink);
    expect(router.state.location.pathname).toContain('/review');

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalledTimes(2));
  });

  it('keeps a stale apply on the review and requires an explicit refresh', async () => {
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockRejectedValue({
      response: { data: { code: 'SYNC_PLAN_STALE', error: 'The source changed.' } },
    });
    renderRoute('/app/settings/integrations/planning-center/batches/7/review');

    await screen.findByText('Planning Center sync review');
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));

    expect(await screen.findByText('This review is out of date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Refresh plan' }).length).toBeGreaterThan(0);
  });

  it('shows success, refreshes batch metadata once, and returns to the provider integration', async () => {
    const router = renderRoute('/app/settings/integrations/planning-center/batches/7/review');
    await screen.findByText('Planning Center sync review');

    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));

    expect(await screen.findByText('Integration settings destination')).toBeInTheDocument();
    expect(screen.getByText('Sync applied successfully.')).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2);
    expect(router.state.location.search).toBe('?tab=integrations&integration=planning-center');
  });

  it('keeps apply successful and warns while returning when post-apply metadata refresh fails', async () => {
    const batch = batchFor('planning_center');
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { success: true, batches: [batch] } } as never)
      .mockRejectedValueOnce(new Error('batch refresh failed'));
    const router = renderRoute('/app/settings/integrations/planning-center/batches/7/review');
    await screen.findByText('Planning Center sync review');

    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));

    expect(await screen.findByText('Integration settings destination')).toBeInTheDocument();
    expect(screen.getByText('Sync applied successfully.')).toBeInTheDocument();
    expect(screen.getByText('Sync applied, but the latest batch status could not be loaded.')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=integrations&integration=planning-center');
  });
});
