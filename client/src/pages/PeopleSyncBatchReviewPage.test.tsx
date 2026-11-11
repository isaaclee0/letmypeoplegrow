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
  HouseholdChoiceEdits,
  IdentityReviewEntry,
  PeopleSyncBatch,
  PeopleSyncCorrectionPreview,
  PeopleSyncPlan,
  PeopleSyncPlanSummary,
  PeopleSyncReview,
  SyncProvider,
} from '../components/peopleSync/types';
import { elvantoSyncAPI, gatheringsAPI, integrationsAPI, peopleSyncAPI } from '../services/api';
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
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

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
  PEOPLE_SYNC_BATCH_PREPARED_MESSAGE: 'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.',
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
    getPlanningCenterSyncPlan: vi.fn(),
    previewPlanningCenterSyncLinkCorrections: vi.fn(),
    previewPlanningCenterSyncHouseholdChoices: vi.fn(),
    applyPlanningCenterSync: vi.fn(),
  },
  peopleSyncAPI: { getSettings: vi.fn(), forgetReconciliationKeep: vi.fn() },
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
  sourceContext: { promotions: [], reviewedLists: [{ batchId: 7, name: 'Members 7', gatheringTypeId: null,
    activeSource: { kind: 'planning_center_list', externalId: 'source-active', name: 'Active adults' },
    selectedSource: { kind: 'planning_center_list', externalId: 'source-draft', name: 'Draft families' }, isDraft: true }] },
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

function householdReview({ token = 'household-base', saved = false, edits = {} }: {
  token?: string; saved?: boolean; edits?: HouseholdChoiceEdits;
} = {}): PeopleSyncReview {
  const review = reviewFor({ token });
  review.plan.linkPeople = [];
  review.plan.reviewContext!.identities = {};
  review.plan.reviewContext!.establishedLinks = { one: { individualId: 1 }, two: { individualId: 2 } };
  const edit = edits.card;
  review.plan.householdChoices = {
    version: 2, edits, basePreferences: [],
    localFamilies: [
      { id: 10, familyName: 'Smith family', memberNames: ['Alex Smith', 'Blair Smith'] },
      { id: 20, familyName: 'Jones family', memberNames: ['Casey Jones'] },
    ],
    decisions: edit ? [{
      groupId: 'card', destination: edit.destination,
      resolvedName: edit.displayName?.trim() || null,
      fromName: edit.destination.kind === 'existing' && edit.destination.familyId === 20 ? 'Jones family' : 'Smith family',
      people: [
        { externalPersonId: 'one', individualId: 1, fromFamilyId: 10, sourceFingerprint: null },
        { externalPersonId: 'two', individualId: 2, fromFamilyId: 10, sourceFingerprint: null },
      ],
    }] : [],
    groups: [{
      id: 'card', saved, invalidReason: null, sourceChanged: false,
      selectedDestination: edit?.destination.kind === 'existing' ? edit.destination : saved ? { kind: 'existing', familyId: 10 } : { kind: 'keep' },
      displayName: 'Smith family', suggestedName: 'Smith household',
      people: [
        { externalPersonId: 'one', individualId: 1, firstName: 'Alex', lastName: 'Smith', currentFamilyId: 10, sourceFingerprint: null, currentFamilyName: 'Smith family' },
        { externalPersonId: 'two', individualId: 2, firstName: 'Blair', lastName: 'Smith', currentFamilyId: 10, sourceFingerprint: null, currentFamilyName: 'Smith family' },
      ],
      sourceHouseholds: [
        { externalFamilyId: 'h1', name: 'PCO Smith household', members: [
          { externalPersonId: 'parent', firstName: 'Pat', lastName: 'Smith', inSource: false },
        ] },
        { externalFamilyId: 'h2', name: 'PCO Smith household', members: [
          { externalPersonId: 'child', firstName: 'Casey', lastName: 'Smith', inSource: true },
        ] },
      ],
    }],
  };
  review.summary = summaryFor(review.plan);
  return review;
}

function outsideSourceReview({ linkRequired = true, withNormalIdentity = false }: { linkRequired?: boolean; withNormalIdentity?: boolean } = {}): PeopleSyncReview {
  const review = reviewFor({ token: 'outside-source-review' });
  if (!withNormalIdentity) {
    review.plan.linkPeople = [];
    review.plan.reviewContext!.identities = {};
  }
  review.plan.people!.local['8'] = { firstName: 'Taylor', lastName: 'Reed', family: { state: 'known', name: 'Reed family', members: [], totalOtherMembers: 0 } };
  review.plan.archive = [{
    id: 'outside-source:8', individualId: 8, externalPersonId: 'pco-outside',
    reason: 'outside_all_sync_sources', linkRequired,
    externalFirstName: 'Taylor', externalLastName: 'REED',
    sourceNames: ['Members', 'Youth'], pcoHouseholdNames: ['Reed household'],
  }];
  if (!linkRequired) review.plan.reviewContext!.establishedLinks = { 'pco-outside': { individualId: 8 } };
  review.summary = summaryFor(review.plan);
  return review;
}

function manyOutsideSourceReview(): PeopleSyncReview {
  const review = outsideSourceReview({ withNormalIdentity: true });
  const first = review.plan.archive[0];
  review.plan.archive = [first, ...Array.from({ length: 5 }, (_, index) => ({
    ...first, id: `outside:${20 + index}`, individualId: 20 + index, externalPersonId: `pco-outside-${20 + index}`,
    externalFirstName: `Casey${index + 1}`, externalLastName: 'Jones',
  }))];
  for (let index = 0; index < 5; index += 1) {
    review.plan.people!.local[String(20 + index)] = { firstName: `Casey${index + 1}`, lastName: 'Jones', family: { state: 'none' } };
  }
  // The same person also has an ordinary attendance-list decision. It must
  // remain visible even when their optional archive card is collapsed.
  review.plan.removeFromGathering = [{
    id: 'remove:taylor', individualId: 8, externalPersonId: 'pco-outside', batchId: 7,
    gatheringTypeId: 1, gatheringName: 'Members attendance', reason: 'outside_source', reviewRequired: true,
  }];
  review.summary = summaryFor(review.plan);
  return review;
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
    operationalState: 'active',
    reviewable: true,
    runnable: true,
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
      { path: 'settings/integrations/planning-center/review', element: <RoleProtectedRoute allowedRoles={['admin']}><PeopleSyncBatchReviewPage integrationWide /></RoleProtectedRoute> },
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
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockReset();
    state.role = 'admin';
    vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({ data: { success: true, settings: { authorityProvider: 'planning_center', pendingAuthorityProvider: null } } } as never);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const pcoBatch = batchFor('planning_center');
    const elvantoBatch = batchFor('elvanto');
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValue({ data: { success: true, batches: [pcoBatch] } } as never);
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan)
      .mockResolvedValue({ data: { success: true, ...reviewFor() } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncLinkCorrections)
      .mockResolvedValue({ data: { success: true, ...correctionPreview(30, 'preview-token') } } as never);
    vi.mocked(integrationsAPI.applyPlanningCenterSync)
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

  it.each(['', '?layout=decisions'])('passes gathering names to the combined review filter in layout %s', async (layout) => {
    const signed = reviewFor();
    const source = signed.plan.sourceContext!.reviewedLists![0];
    signed.plan.sourceContext!.reviewedLists = [{ ...source, gatheringTypeId: 1 }, { ...source, batchId: 8, gatheringTypeId: 2 }];
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValueOnce({ data: { success: true, ...signed } } as never);
    vi.mocked(gatheringsAPI.getAll).mockResolvedValueOnce({ data: { gatherings: [{ id: 1, name: 'Sunday AM' }, { id: 2, name: 'Sunday PM' }] } } as never);
    renderRoute(`/app/settings/integrations/planning-center/review${layout}`);
    const filter = await screen.findByRole('combobox', { name: 'Gathering changes' });
    expect(within(filter).getByRole('option', { name: 'Sunday AM' })).toHaveValue('1');
    expect(within(filter).getByRole('option', { name: 'Sunday PM' })).toHaveValue('2');
  });

  it('blocks a list without an active or draft source before fetching a combined plan', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValueOnce({ data: { batches: [{ ...batchFor('planning_center'), source: null, draftSource: null }] } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a Planning Center list');
    expect(integrationsAPI.getPlanningCenterSyncPlan).not.toHaveBeenCalled();
  });

  it('shows the signed selected source instead of metadata fetched before the review was built', async () => {
    const signed = reviewFor();
    signed.plan.sourceContext!.reviewedLists = [{ batchId: 7, name: 'Signed list configuration', gatheringTypeId: null,
      activeSource: { kind: 'planning_center_list', externalId: 'active', name: 'Signed previous source' },
      selectedSource: { kind: 'planning_center_list', externalId: 'changed', name: 'Signed new source' }, isDraft: true }];
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValueOnce({ data: { success: true, ...signed } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByText('Signed new source')).toBeInTheDocument();
    expect(screen.getByText('Signed previous source')).toBeInTheDocument();
    expect(screen.queryByText('Draft families')).not.toBeInTheDocument();
    expect(screen.queryByText('Active adults')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Planning Center review & sync' })).toBeInTheDocument();
  });

  it.each([undefined, [], [{ batchId: 7, name: 'Missing selected source', isDraft: true }]])('fails closed when the signed integration source summary is incomplete: %s', async (reviewedLists) => {
    const signed = reviewFor();
    signed.plan.sourceContext!.reviewedLists = reviewedLists as never;
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValueOnce({ data: { success: true, ...signed } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByRole('alert')).toHaveTextContent('The reviewed list scope is missing or invalid. Refresh this review.');
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Draft families')).not.toBeInTheDocument();
  });

  it('redirects old Planning Center batch links to the combined review and preserves layout', async () => {
    const router = renderRoute('/app/settings/integrations/planning-center/batches/7/review?layout=decisions');
    await screen.findByRole('list', { name: 'People to review' });
    expect(router.state.location.pathname).toBe('/app/settings/integrations/planning-center/review');
    expect(router.state.location.search).toBe('?layout=decisions');
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(1);
  });

  it('includes all enabled modern sources and excludes disabled and retired sources', async () => {
    const second = { ...batchFor('planning_center', 8), name: 'Youth', draftSource: null, source: { ...batchFor('planning_center').source!, name: 'Youth list' } };
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({ data: { batches: [batchFor('planning_center'), second,
      { ...second, id: 9, name: 'Disabled source', enabled: false }, { ...second, id: 10, name: 'Retired source', legacyProviderBatchId: 50 }] } } as never);
    const signed = reviewFor();
    signed.plan.sourceContext!.reviewedLists!.push({ batchId: 8, name: 'Youth', gatheringTypeId: null,
      activeSource: { kind: 'planning_center_list', externalId: 'youth', name: 'Youth list' },
      selectedSource: { kind: 'planning_center_list', externalId: 'youth', name: 'Youth list' }, isDraft: false });
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValueOnce({ data: { success: true, ...signed } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByText('Youth list')).toBeInTheDocument();
    expect(screen.getByText('Draft families')).toBeInTheDocument();
    expect(screen.queryByText('Disabled source')).not.toBeInTheDocument();
    expect(screen.queryByText('Retired source')).not.toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(1);
  });

  it('shows a helpful empty state without fetching a plan when no lists are enabled', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({ data: { batches: [{ ...batchFor('planning_center'), enabled: false }] } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByText('No enabled Planning Center lists')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Planning Center' })).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterSyncPlan).not.toHaveBeenCalled();
  });

  it.each([
    { authorityProvider: 'none', pendingAuthorityProvider: null },
    { authorityProvider: 'elvanto', pendingAuthorityProvider: null },
    { authorityProvider: 'planning_center', pendingAuthorityProvider: 'elvanto' },
  ])('blocks ordinary review while authority is not settled: %s', async (settings) => {
    vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({ data: { settings } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByRole('alert')).toHaveTextContent(/source of truth|source switch/);
    expect(integrationsAPI.getPlanningCenterSyncPlan).not.toHaveBeenCalled();
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
  });

  it('fails closed when current authority settings cannot be loaded', async () => {
    vi.mocked(peopleSyncAPI.getSettings).mockRejectedValueOnce(new Error('People source settings unavailable.'));
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByRole('alert')).toHaveTextContent('People source settings unavailable.');
    expect(integrationsAPI.getPlanningCenterSyncPlan).not.toHaveBeenCalled();
  });

  it.each(['', '?layout=decisions'])('requires a signed preview and applies one card-wide choice in layout %s', async (layout) => {
    const base = householdReview();
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...base } } as never);
    const pending = deferred<{ data: { success: true } & PeopleSyncCorrectionPreview }>();
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockReturnValueOnce(pending.promise as never)
      .mockImplementationOnce(async (body) => ({ data: { success: true, ...householdReview({ token: 'second-household-preview', edits: body.householdChoices }) } }) as never);
    renderRoute(`/app/settings/integrations/planning-center/review${layout}`);
    const user = userEvent.setup();
    const selector = await screen.findByRole('combobox', { name: 'Household for everyone on this card' });
    await user.selectOptions(selector, 'existing:20');
    expect(await screen.findByRole('button', { name: /Apply .*changes|Nothing to apply/ })).toBeDisabled();
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).toHaveBeenCalledWith({
      baseReviewToken: 'household-base', householdChoices: { card: { destination: { kind: 'existing', familyId: 20 } } },
    });
    expect(selector).toBeDisabled();
    await act(async () => pending.resolve({ data: { success: true, ...householdReview({ token: 'first-household-preview', edits: { card: { destination: { kind: 'existing', familyId: 20 } } } }) } }));
    expect(await screen.findByRole('button', { name: /Apply 1 (selected )?change$/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Edit family name/ }));
    await user.clear(screen.getByLabelText('LMPG family display name (optional)'));
    await user.type(screen.getByLabelText('LMPG family display name (optional)'), 'Alex and Blair');
    expect(screen.getByRole('button', { name: /Apply 1 (selected )?change$/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    await waitFor(() => expect(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).toHaveBeenLastCalledWith({
      baseReviewToken: 'household-base', householdChoices: { card: { destination: { kind: 'existing', familyId: 20 }, displayName: 'Alex and Blair' } },
    }));
    await user.click(await screen.findByRole('button', { name: /Apply 1 (selected )?change$/ }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith({
      reviewToken: 'second-household-preview', selections: expect.objectContaining({ householdChoices: { card: { destination: { kind: 'existing', familyId: 20 }, displayName: 'Alex and Blair' } } }),
    }));
  });

  it('protects household drafts and previewed choices when leaving or refreshing the review', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...householdReview() } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockImplementation(async (body) => ({ data: { success: true, ...householdReview({ token: 'signed-household', edits: body.householdChoices }) } }) as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Household for everyone on this card' }), 'existing:20');
    vi.mocked(window.confirm).mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Back to Planning Center' }));
    expect(screen.queryByText('Integration settings destination')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(await screen.findByRole('button', { name: 'Apply 1 selected change' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(1);
    vi.mocked(window.confirm).mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Refresh plan' }));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('combobox', { name: 'Household for everyone on this card' })).toHaveValue('keep');
  });

  it('saves a display-name-only edit even when nobody needs a family move', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...householdReview({ saved: true }) } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockImplementation(async (body) => ({ data: { success: true, ...householdReview({ token: 'name-only', saved: true, edits: body.householdChoices }) } }) as never);
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Edit family name/ }));
    const name = screen.getByLabelText('LMPG family display name (optional)');
    await user.clear(name); await user.type(name, 'Smiths of Hobart');
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(await screen.findByTestId('household-display-name')).toHaveTextContent('Smiths of Hobart');
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith({
      reviewToken: 'name-only', selections: expect.objectContaining({ householdChoices: { card: { destination: { kind: 'existing', familyId: 10 }, displayName: 'Smiths of Hobart' } } }),
    }));
  });

  it('previews forgetting and resetting a saved choice without saving it immediately', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...householdReview({ saved: true }) } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockImplementation(async (body) => ({ data: { success: true, ...householdReview({ token: `forget-${Object.keys(body.householdChoices).length}`, saved: true, edits: body.householdChoices }) } }) as never);
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Forget saved choice' }));
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(await screen.findByRole('button', { name: 'Apply 1 change' })).toBeEnabled();
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
    expect(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).toHaveBeenLastCalledWith({ baseReviewToken: 'household-base', householdChoices: { card: { destination: { kind: 'forget' } } } });
    await user.click(screen.getByRole('button', { name: 'Reset card' }));
    expect(screen.getByRole('button', { name: 'Apply 1 change' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    await waitFor(() => expect(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).toHaveBeenLastCalledWith({ baseReviewToken: 'household-base', householdChoices: {} }));
    expect(await screen.findByRole('button', { name: 'Nothing to apply' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Household for everyone on this card' })).toHaveValue('existing:10');
  });

  it('keeps the draft and blocks Apply after a failed household preview', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...householdReview() } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockRejectedValue({ response: { status: 409, data: { error: 'The local family changed. Refresh the review.', code: 'SYNC_PLAN_STALE' } } });
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Household for everyone on this card' }), 'existing:20');
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(await screen.findByText('The local family changed. Refresh the review.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nothing to apply' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Household for everyone on this card' })).toHaveValue('existing:20');
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
  });

  it.each(['', '?layout=decisions'])('remembers the default current arrangement without selecting PCO in layout %s', async (layout) => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...householdReview() } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockImplementation(async (body) => ({ data: { success: true, ...householdReview({ token: 'keep-current', edits: body.householdChoices }) } }) as never);
    renderRoute(`/app/settings/integrations/planning-center/review${layout}`);
    const user = userEvent.setup();
    const selector = await screen.findByRole('combobox', { name: 'Household for everyone on this card' });
    expect(selector).toHaveValue('keep');
    expect(within(selector).queryByRole('option', { name: /PCO Smith household/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remember this household' }));
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).toHaveBeenCalledWith({ baseReviewToken: 'household-base', householdChoices: { card: { destination: { kind: 'keep' } } } });
    expect(await screen.findByText('Alex Smith: stays in Smith family')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Apply 1 (selected )?change$/ }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith({
      reviewToken: 'keep-current', selections: expect.objectContaining({ householdChoices: { card: { destination: { kind: 'keep' } } } }),
    }));
  });

  it('creates the chosen local family directly on Apply without a second family-resolution decision', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...householdReview() } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockImplementation(async (body) => ({ data: { success: true, ...householdReview({ token: 'create-family', edits: body.householdChoices }) } }) as never);
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Household for everyone on this card' }), 'create');
    const name = screen.getByRole('textbox', { name: 'New family name' });
    await user.clear(name);
    expect(screen.getByRole('button', { name: 'Preview household choices' })).toBeDisabled();
    expect(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).not.toHaveBeenCalled();
    await user.type(name, 'Our Smiths');
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(await screen.findByText('Alex Smith: Smith family → Our Smiths')).toBeInTheDocument();
    expect(screen.getByText('Blair Smith: Smith family → Our Smiths')).toBeInTheDocument();
    expect(screen.queryByText(/Review any family moves below|Family moves appear here after preview|separate move/)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Apply 1 change' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalled());
    const submitted = vi.mocked(integrationsAPI.applyPlanningCenterSync).mock.calls[0][0];
    expect(submitted.selections.householdChoices).toEqual({ card: { destination: { kind: 'create' }, displayName: 'Our Smiths' } });
    expect(submitted.selections.acceptFamilyResolutionIds || []).toEqual([]);
  });

  it('shows a renewed provider proposal after PCO changes and replaces it with an explicit local choice preview', async () => {
    const changed = householdReview({ saved: true });
    changed.plan.householdChoices!.groups[0].sourceChanged = true;
    changed.plan.householdChoices!.groups[0].invalidReason = 'Planning Center household membership changed. Review the updated household.';
    changed.plan.familyConflicts = [{
      id: 'provider-move', externalFamilyId: 'updated-pco', externalFamilyName: 'Jones household',
      memberExternalIds: ['one', 'two'], reason: 'multiple_local_families',
      resolution: { kind: 'household', destination: { kind: 'existing', familyId: 20, familyName: 'Jones family' }, moves: [
        { externalPersonId: 'one', individualId: 1, fromFamilyId: 10 },
        { externalPersonId: 'two', individualId: 2, fromFamilyId: 10 },
      ] },
    }];
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...changed } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).mockImplementation(async (body) => ({ data: { success: true, ...householdReview({ token: 'local-instead', saved: true, edits: body.householdChoices }) } }) as never);
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    expect(await screen.findByText('Planning Center household membership changed. Review the updated household.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Apply 1 change' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Something else' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Household for everyone on this card' })).toBeEnabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Household for everyone on this card' }), 'keep');
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(await screen.findByText('Alex Smith: stays in Smith family')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Something else' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalled());
    const submitted = vi.mocked(integrationsAPI.applyPlanningCenterSync).mock.calls[0][0];
    expect(submitted.selections.householdChoices).toEqual({ card: { destination: { kind: 'keep' } } });
    expect(submitted.selections.acceptFamilyResolutionIds || []).toEqual([]);
  });

  it('requires a refresh for a stale v1 household review', async () => {
    const old = householdReview();
    old.plan.householdChoices!.version = 1 as never;
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...old } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    expect(await screen.findByText('Household choices have changed. Refresh this review before applying.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply .*selected/ })).toBeDisabled();
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
  });

  it('protects other review decisions before replacing them with a household preview', async () => {
    const base = reviewFor({ attention: true });
    base.plan.householdChoices = householdReview().plan.householdChoices;
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...base } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    await screen.findByRole('combobox', { name: 'Household for everyone on this card' });
    const user = await chooseAlternativeForAttention();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Household for everyone on this card' }), 'existing:20');
    vi.mocked(window.confirm).mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Preview household choices' }));
    expect(window.confirm).toHaveBeenLastCalledWith('Previewing household choices recalculates this review and resets your other unsaved review choices. Continue?');
    expect(integrationsAPI.previewPlanningCenterSyncHouseholdChoices).not.toHaveBeenCalled();
    expect(screen.getAllByText('Taylor Reed').length).toBeGreaterThan(0);
  });

  it('does not silently replace pending household choices with a person-link correction', async () => {
    const base = reviewFor({ established: true });
    base.plan.householdChoices = householdReview().plan.householdChoices;
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...base } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Household for everyone on this card' }), 'existing:20');
    await beginEstablishedCorrection('Replacement Local');
    expect(await screen.findByText(/Reset household choices and preview them/)).toBeInTheDocument();
    expect(integrationsAPI.previewPlanningCenterSyncLinkCorrections).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Household for everyone on this card' })).toHaveValue('existing:20');
    expect(screen.getByRole('button', { name: /Apply .*selected/ })).toBeDisabled();
  });

  it.each([true, false])('requires explicit outside-list archive acceptance in the decision layout (linkRequired=%s)', async (linkRequired) => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...outsideSourceReview({ linkRequired }) } } as never);
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    expect(await screen.findByText('Keep active for now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nothing to apply' })).toBeDisabled();
    expect(screen.getByText(/Active in Planning Center, but outside every enabled sync list/)).toBeInTheDocument();
    expect(screen.getAllByText('Taylor REED').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reed household').length).toBeGreaterThan(0);
    expect(screen.getByText('Checked lists: Members, Youth')).toBeInTheDocument();
    expect(screen.queryByText(/No longer active in Planning Center|Not in LMPG/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Something else' }));
    expect(screen.queryByRole('option', { name: /Add as a new person/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: linkRequired ? /Link and archive/ : /Archive in LMPG/ }));
    expect(screen.getByText('Attendance history is kept.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith({
      reviewToken: 'outside-source-review',
      selections: expect.objectContaining({ acceptArchiveIndividualIds: [8], identityDecisions: {} }),
    }));
  });

  it.each([true, false])('requires explicit compound acceptance and archive acknowledgement in the current layout (linkRequired=%s)', async (linkRequired) => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...outsideSourceReview({ linkRequired }) } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');
    const user = userEvent.setup();
    const choice = await screen.findByRole('checkbox', { name: linkRequired ? 'Link and archive Taylor Reed' : 'Archive in LMPG Taylor Reed' });
    expect(choice).not.toBeChecked();
    expect(screen.getByText('Keep active for now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 0 selected changes' })).toBeEnabled();
    expect(screen.queryByText('Archived in the provider')).not.toBeInTheDocument();
    await user.click(choice);
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I understand that this sync will archive people/ }));
    await user.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith({
      reviewToken: 'outside-source-review', selections: expect.objectContaining({ acceptArchiveIndividualIds: [8], identityDecisions: {} }),
    }));
  });

  it.each(['', '?layout=decisions'])('leaves an outside-list candidate active while applying unrelated changes in layout %s', async (layout) => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...outsideSourceReview({ withNormalIdentity: true }) } } as never);
    renderRoute(`/app/settings/integrations/planning-center/review${layout}`);
    const user = userEvent.setup();
    expect(await screen.findByText('Keep active for now')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Apply 1 (selected )?change$/ }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalled());
    expect(vi.mocked(integrationsAPI.applyPlanningCenterSync).mock.calls[0][0].selections).toMatchObject({
      acceptArchiveIndividualIds: [], identityDecisions: { 'ext-auto': { outcome: 'accept' } },
    });
  });

  it.each(['', '?layout=decisions'])('blocks an outside-list link-and-archive that collides with another selected match in layout %s', async (layout) => {
    const review = outsideSourceReview({ withNormalIdentity: true });
    review.plan.reviewContext!.identities['ext-auto'].suggestedIndividualId = 8;
    review.plan.reviewContext!.identities['ext-auto'].candidateIndividualIds = [8];
    review.plan.linkPeople[0].individualId = 8;
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...review } } as never);
    renderRoute(`/app/settings/integrations/planning-center/review${layout}`);
    const user = userEvent.setup();
    expect(await screen.findByText('Keep active for now')).toBeInTheDocument();
    if (layout) {
      const outside = screen.getByRole('region', { name: 'Active in Planning Center, but outside every enabled sync list.' });
      await user.click(within(outside).getByRole('button', { name: 'Something else' }));
      await user.click(screen.getByRole('option', { name: /Link and archive/ }));
    } else {
      await user.click(screen.getByRole('checkbox', { name: 'Link and archive Taylor Reed' }));
      await user.click(screen.getByRole('checkbox', { name: /I understand that this sync will archive people/ }));
    }
    expect(screen.getByRole('button', { name: /Apply 2 (selected )?changes$/ })).toBeDisabled();
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
  });

  it.each(['', '?layout=decisions'])('collapses large outside-list sets and preserves hidden selections through name searches in layout %s', async (layout) => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockResolvedValue({ data: { success: true, ...manyOutsideSourceReview() } } as never);
    await act(async () => { renderRoute(`/app/settings/integrations/planning-center/review${layout}`); });
    const user = userEvent.setup();
    const summary = await screen.findByText('People outside synced lists (6)');
    const section = summary.closest('details')!;
    expect(section).not.toHaveAttribute('open');
    expect(screen.queryByText('Keep active for now')).not.toBeInTheDocument();
    expect(screen.queryByText(/6 people and households to review|7 people and households to review/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Members attendance/).length).toBeGreaterThan(0);
    expect(within(section).getByText('0 selected')).toBeInTheDocument();
    await user.click(summary);
    const search = await screen.findByRole('searchbox', { name: 'Search people outside synced lists' });
    await user.type(search, 'taylor');
    expect(await within(section).findByText('Keep active for now')).toBeInTheDocument();
    expect(within(section).queryByText('Casey1 Jones')).not.toBeInTheDocument();
    if (layout) {
      await user.click(within(section).getByRole('button', { name: 'Something else' }));
      await user.click(screen.getByRole('option', { name: /Link and archive/ }));
    } else {
      await user.click(within(section).getByRole('checkbox', { name: 'Link and archive Taylor Reed' }));
    }
    expect(within(section).getByText('1 selected')).toBeInTheDocument();
    await user.clear(search); await user.type(search, 'casey1');
    expect(within(section).queryByText('Taylor REED')).not.toBeInTheDocument();
    expect(within(section).getByText('Keep active for now')).toBeInTheDocument();
    expect(within(section).getByText('1 selected')).toBeInTheDocument();
    await user.clear(search); await user.type(search, 'nobody matches');
    expect(within(section).getByText('No people match this name.')).toBeInTheDocument();
    expect(within(section).getByText('1 selected')).toBeInTheDocument();
    await user.click(summary);
    expect(section).not.toHaveAttribute('open');
    expect(screen.queryByRole('searchbox', { name: 'Search people outside synced lists' })).not.toBeInTheDocument();
    if (!layout) await user.click(screen.getByRole('checkbox', { name: /I understand that this sync will archive people/ }));
    await user.click(screen.getByRole('button', { name: /Apply [23] (selected )?changes$/ }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalled());
    expect(vi.mocked(integrationsAPI.applyPlanningCenterSync).mock.calls[0][0].selections.acceptArchiveIndividualIds).toEqual([8]);
  });

  it('renders the admin-only review route in the existing sidebar layout', async () => {
    renderRoute('/app/settings/integrations/planning-center/review');

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'People' }).length).toBeGreaterThan(0);
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledWith();
  });

  it('applies the new dev decision layout through the signed batch API', async () => {
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    expect(await screen.findByRole('list', { name: 'People to review' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    expect(await screen.findByText('Integration settings destination')).toBeInTheDocument();
    expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith({
      reviewToken: 'base-review-token',
      selections: expect.objectContaining({
        decisionContractVersion: 2,
        identityDecisions: { 'ext-auto': { outcome: 'accept' } },
      }),
    });
  });

  it('shows the same-sync gathering consequence for a held creation and removes it when deferred', async () => {
    const review = reviewFor({ attention: true });
    Object.assign(review.plan.reviewContext!.identities['ext-attention'], {
      gatheringAssignments: [{ batchId: 7, gatheringTypeId: 1 }],
    });
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan)
      .mockResolvedValue({ data: { success: true, ...review } } as never);
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    const heading = await screen.findByRole('heading', { name: 'Blair Jones' });
    const card = within(heading.closest('li')!);
    expect(card.getByText('Joins 1 attendance list in this sync')).toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Something else' }));
    await user.click(screen.getByRole('option', { name: /Decide later/ }));
    expect(card.queryByText('Joins 1 attendance list in this sync')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    expect(await screen.findByText('Integration settings destination')).toBeInTheDocument();
    expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith(expect.objectContaining({
      selections: expect.objectContaining({ identityDecisions: { 'ext-auto': { outcome: 'accept' } } }),
    }));
  });

  it('requires a fresh review after a stale apply in the new dev layout', async () => {
    vi.mocked(integrationsAPI.applyPlanningCenterSync).mockRejectedValueOnce({
      response: { data: { code: 'SYNC_PLAN_STALE', error: 'The roster changed. Refresh this review.' } },
    });
    renderRoute('/app/settings/integrations/planning-center/review?layout=decisions');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Apply 1 change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The roster changed. Refresh this review.');
    expect(screen.getByRole('button', { name: 'Apply 1 change' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    expect(await screen.findByRole('button', { name: 'Apply 1 change' })).toBeEnabled();
  });

  it('redirects a non-admin from the review route before loading provider data', async () => {
    renderRoute('/app/settings/integrations/planning-center/review', 'coordinator');

    expect(await screen.findByText('Attendance destination')).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterSyncPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['/app/settings/integrations/unknown/batches/7/review', '/app/settings', '?tab=integrations'],
    ['/app/settings/integrations/elvanto/batches/not-a-number/review', '/app/settings', '?tab=integrations&integration=elvanto'],
  ])('returns invalid route context to integrations with an error', async (path, pathname, search) => {
    const router = renderRoute(path);

    expect(await screen.findByText('Integration settings destination')).toBeInTheDocument();
    expect(screen.getByText('This sync review link is invalid.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(pathname);
    expect(router.state.location.search).toBe(search);
  });

  it('shows participating source metadata and explicitly labels the pending draft change', async () => {
    renderRoute('/app/settings/integrations/planning-center/review');

    expect(await screen.findByText('Members 7')).toBeInTheDocument();
    expect(screen.getByText('Draft families')).toBeInTheDocument();
    expect(screen.getByText('Active adults')).toBeInTheDocument();
    expect(screen.getByText('Pending source change')).toBeInTheDocument();
  });

  it('reconstructs Elvanto provider and batch context from a direct route load', async () => {
    renderRoute('/app/settings/integrations/elvanto/batches/7/review');

    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.getByText('Elvanto members 7')).toBeInTheDocument();
    expect(elvantoSyncAPI.getBatchPlan).toHaveBeenCalledWith(7);
    expect(integrationsAPI.getPlanningCenterSyncPlan).not.toHaveBeenCalled();
  });

  it('keeps retry and back actions available after the initial plan load fails', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan)
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ data: { success: true, ...reviewFor({ token: 'retry-token' }) } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');

    expect(await screen.findByRole('alert')).toHaveTextContent('provider unavailable');
    expect(screen.getByRole('button', { name: 'Back to Planning Center' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry review' }));

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(2);
  });

  it('shows switch-source guidance and never opens or applies a prepared batch from a stale bookmark', async () => {
    const prepared = {
      ...batchFor('planning_center'),
      operationalState: 'prepared' as const,
      reviewable: false,
      runnable: false,
    };
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValue({ data: { success: true, batches: [prepared] } } as never);

    renderRoute('/app/settings/integrations/planning-center/review');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.',
    );
    expect(integrationsAPI.getPlanningCenterSyncPlan).not.toHaveBeenCalled();
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Apply .*selected change/ })).not.toBeInTheDocument();
  });

  it('replaces an active review with switch-source guidance when refreshed metadata becomes prepared', async () => {
    const active = batchFor('planning_center');
    const prepared = {
      ...active,
      operationalState: 'prepared' as const,
      reviewable: false,
      runnable: false,
    };
    const metadataRefresh = deferred<{ data: { success: true; batches: PeopleSyncBatch[] } }>();
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { success: true, batches: [active] } } as never)
      .mockReturnValueOnce(metadataRefresh.promise as never);
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan)
      .mockResolvedValue({ data: { success: true, ...reviewFor({ established: true }) } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Already linked 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Loading sync review');
    expect(screen.queryByText('Planning Center sync review')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Already linked 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply .*selected change/ })).not.toBeInTheDocument();

    metadataRefresh.resolve({ data: { success: true, batches: [prepared] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.',
    );
    expect(screen.queryByText('Planning Center sync review')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Already linked 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply .*selected change/ })).not.toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(1);
    expect(integrationsAPI.previewPlanningCenterSyncLinkCorrections).not.toHaveBeenCalled();
    expect(integrationsAPI.applyPlanningCenterSync).not.toHaveBeenCalled();
  });

  it('uses the original base token for corrections and the effective preview token for apply', async () => {
    const base = reviewFor({ token: 'original-base', established: true });
    const preview = correctionPreview(30, 'effective-preview');
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan)
      .mockResolvedValue({ data: { success: true, ...base } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncLinkCorrections)
      .mockResolvedValue({ data: { success: true, ...preview } } as never);
    renderRoute('/app/settings/integrations/planning-center/review');

    await screen.findByText('Planning Center sync review');
    expect(screen.getByRole('tab', { name: 'Already linked 1' })).toBeInTheDocument();
    const user = await beginEstablishedCorrection('Replacement Local');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeEnabled());
    expect(integrationsAPI.previewPlanningCenterSyncLinkCorrections).toHaveBeenCalledWith({
      baseReviewToken: 'original-base',
      linkCorrections: {
        'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith(expect.objectContaining({
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
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan).mockReturnValue(latePlan.promise as never);
    const router = renderRoute('/app/settings/integrations/planning-center/review');
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalled());

    await act(async () => {
      await router.navigate('/app/settings/integrations/elvanto/batches/7/review');
    });
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();

    latePlan.resolve({ data: { success: true, ...reviewFor({ token: 'late-pco' }) } });
    await act(async () => { await latePlan.promise; });
    expect(screen.getByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.queryByText('Planning Center sync review')).not.toBeInTheDocument();
  });

  it('clears the old review before a different provider and batch fail to load', async () => {
    const failedElvantoPlan = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(elvantoSyncAPI.listBatches)
      .mockResolvedValue({ data: { success: true, batches: [batchFor('elvanto', 8)] } } as never);
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockReturnValue(failedElvantoPlan.promise as never);
    const router = renderRoute('/app/settings/integrations/planning-center/review');
    await screen.findByText('Planning Center sync review');

    await act(async () => {
      await router.navigate('/app/settings/integrations/elvanto/batches/8/review');
    });

    expect(screen.queryByText('Planning Center sync review')).not.toBeInTheDocument();
    expect(screen.queryByText('Members 7')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply 1 selected change' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading sync review');
    expect(elvantoSyncAPI.applyBatch).not.toHaveBeenCalled();

    failedElvantoPlan.reject(new Error('Elvanto batch 8 unavailable'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Elvanto batch 8 unavailable');
    expect(screen.queryByText('Planning Center sync review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply .*selected change/ })).not.toBeInTheDocument();
    expect(elvantoSyncAPI.applyBatch).not.toHaveBeenCalled();
  });

  it('ignores an older correction preview after a newer preview succeeds', async () => {
    const base = reviewFor({ token: 'original-base', established: true });
    const older = deferred<{ data: { success: true } & PeopleSyncCorrectionPreview }>();
    const newer = deferred<{ data: { success: true } & PeopleSyncCorrectionPreview }>();
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan)
      .mockResolvedValue({ data: { success: true, ...base } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterSyncLinkCorrections)
      .mockReturnValueOnce(older.promise as never)
      .mockReturnValueOnce(newer.promise as never);
    renderRoute('/app/settings/integrations/planning-center/review');

    await screen.findByText('Planning Center sync review');
    const user = await beginEstablishedCorrection('Replacement Local');
    await beginEstablishedCorrection('Alternative Local');
    newer.resolve({ data: { success: true, ...correctionPreview(42, 'preview-42') } });
    await waitFor(() => expect(screen.getByText('Update Alternative Local')).toBeInTheDocument());
    older.resolve({ data: { success: true, ...correctionPreview(30, 'preview-30') } });
    await waitFor(() => expect(screen.queryByText('Refreshing correction preview…')).not.toBeInTheDocument());

    expect(screen.queryByText('Update Replacement Local')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterSync).toHaveBeenCalledWith(expect.objectContaining({
      reviewToken: 'preview-42',
    })));
  });

  it('prompts before dirty refresh and captured sidebar navigation', async () => {
    const dirtyReview = reviewFor({ attention: true });
    vi.mocked(integrationsAPI.getPlanningCenterSyncPlan)
      .mockResolvedValue({ data: { success: true, ...dirtyReview } } as never);
    vi.mocked(window.confirm).mockReturnValue(false);
    const router = renderRoute('/app/settings/integrations/planning-center/review');
    await screen.findByText('Planning Center sync review');
    await chooseAlternativeForAttention();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(1);
    const settingsLink = screen.getAllByRole('link', { name: 'Settings' })[0];
    fireEvent.click(settingsLink);
    expect(router.state.location.pathname).toContain('/review');

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncPlan).toHaveBeenCalledTimes(2));
  });

  it('keeps a stale apply on the review and requires an explicit refresh', async () => {
    vi.mocked(integrationsAPI.applyPlanningCenterSync).mockRejectedValue({
      response: { data: { code: 'SYNC_PLAN_STALE', error: 'The source changed.' } },
    });
    renderRoute('/app/settings/integrations/planning-center/review');

    await screen.findByText('Planning Center sync review');
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));

    expect(await screen.findByText('This review is out of date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Refresh plan' }).length).toBeGreaterThan(0);
  });

  it('shows success, refreshes batch metadata once, and returns to the provider integration', async () => {
    const router = renderRoute('/app/settings/integrations/planning-center/review');
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
    const router = renderRoute('/app/settings/integrations/planning-center/review');
    await screen.findByText('Planning Center sync review');

    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));

    expect(await screen.findByText('Integration settings destination')).toBeInTheDocument();
    expect(screen.getByText('Sync applied successfully.')).toBeInTheDocument();
    expect(screen.getByText('Sync applied, but the latest batch status could not be loaded.')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=integrations&integration=planning-center');
  });
});
