import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authAPI, integrationsAPI, onboardingAPI } from '../services/api';
import OnboardingPage from './OnboardingPage';

const navigate = vi.fn();
const authState = {
  login: vi.fn(), refreshOnboardingStatus: vi.fn(), updateUser: vi.fn(),
  user: { id: 1, email: 'admin@example.com', isFirstLogin: true },
};

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../services/api', () => ({
  authAPI: { requestCode: vi.fn(), verifyCode: vi.fn() },
  onboardingAPI: { saveChurchInfo: vi.fn(), complete: vi.fn() },
  integrationsAPI: {
    authorizePlanningCenter: vi.fn(),
    getPlanningCenterBatchPlan: vi.fn(),
    applyPlanningCenterBatch: vi.fn(),
    getCheckinAvailability: vi.fn(),
  },
  elvantoSyncAPI: {}, peopleSyncAPI: {}, gatheringsAPI: {},
}));

// Keep the test focused on onboarding's transition into the shared, real
// review component. The editor's create payload is covered by its own suite.
vi.mock('../components/planningCenter/PlanningCenterBatchEditor', () => ({
  default: ({ onSaved }: { onSaved: (batch: unknown) => void }) => (
    <button type="button" onClick={() => onSaved({
      id: 91,
      provider: 'planning_center',
      name: 'First PCO batch',
      enabled: true,
      filterSchemaVersion: 2,
      filterConfig: { branches: [], exclusions: [] },
      filterRevision: 1,
      draftFilterSchemaVersion: 2,
      draftFilterConfig: { branches: [], exclusions: [] },
      draftFilterBaseRevision: 1,
      draftFilterUpdatedAt: '2026-07-29T00:00:00.000Z',
      needsFilterReview: true,
      initialFilterReviewPending: true,
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
    })}>Create reviewed PCO batch</button>
  ),
}));

const pcoReview = {
  runId: 17,
  reviewToken: 'onboarding-pco-review',
  snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' as const },
  plan: {
    provider: 'planning_center' as const,
    authoritative: false,
    snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' as const },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
    promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
    renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
    familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
  },
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0,
    renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
    familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
};

async function reachChoosePath() {
  render(<OnboardingPage />);
  fireEvent.change(screen.getByPlaceholderText('e.g. Sunday Community Group'), { target: { value: 'Example Church' } });
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'admin@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and send code' }));
  fireEvent.change(await screen.findByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify & continue' }));
  await screen.findByText('Bring your people with you');
}

describe('OnboardingPage integration choices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/app/onboarding');
    vi.mocked(authAPI.requestCode).mockResolvedValue({ data: {} } as never);
    vi.mocked(authAPI.verifyCode).mockResolvedValue({ data: { token: 'token', user: authState.user } } as never);
    vi.mocked(onboardingAPI.saveChurchInfo).mockResolvedValue({ data: {} } as never);
    vi.mocked(onboardingAPI.complete).mockResolvedValue({ data: {} } as never);
    vi.mocked(integrationsAPI.authorizePlanningCenter).mockResolvedValue({ data: { authUrl: '#pco-oauth' } } as never);
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockResolvedValue({ data: pcoReview } as never);
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockResolvedValue({ data: { runId: 17, status: 'applied', applied: {}, summary: pcoReview.summary } } as never);
    vi.mocked(integrationsAPI.getCheckinAvailability).mockResolvedValue({ data: { available: true, hasImported: false, peopleLinked: true } } as never);
  });

  it('offers Planning Center, Elvanto, and Start fresh at choose-path', async () => {
    await reachChoosePath();
    expect(screen.getByRole('button', { name: /Planning Center/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Elvanto/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start fresh' })).toBeInTheDocument();
  });

  it('retains the Planning Center OAuth flow', async () => {
    await reachChoosePath();
    fireEvent.click(screen.getByRole('button', { name: /Planning Center/i }));
    await waitFor(() => expect(integrationsAPI.authorizePlanningCenter).toHaveBeenCalledWith('/app/onboarding'));
    expect(window.location.hash).toBe('#pco-oauth');
  });

  it('enters Elvanto connection without using a blind import path', async () => {
    await reachChoosePath();
    fireEvent.click(screen.getByRole('button', { name: /Elvanto/i }));
    expect(await screen.findByLabelText('Elvanto API key')).toBeInTheDocument();
    expect(screen.queryByText(/select people to import/i)).not.toBeInTheDocument();
  });

  it('keeps Start fresh completion unchanged', async () => {
    await reachChoosePath();
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(navigate).toHaveBeenCalledWith('/app/gatherings');
  });

  it('uses the real PCO review and only advances after a successful reviewed apply', async () => {
    window.history.replaceState({}, '', '/app/onboarding?pco=connected');
    render(<OnboardingPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create reviewed PCO batch' }));
    expect(await screen.findByRole('heading', { name: 'Planning Center sync review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    await waitFor(() => expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(91, {
      reviewToken: 'onboarding-pco-review', selections: expect.any(Object),
    }));
    await waitFor(() => expect(integrationsAPI.getCheckinAvailability).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Create your gatherings from Planning Center events/)).toBeInTheDocument();
  });

  it('keeps onboarding on the real PCO review when applying it fails', async () => {
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockRejectedValue({
      response: { data: { error: 'PCO apply failed.' } },
    });
    window.history.replaceState({}, '', '/app/onboarding?pco=connected');
    render(<OnboardingPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create reviewed PCO batch' }));
    expect(await screen.findByRole('heading', { name: 'Planning Center sync review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    expect(await screen.findByText('PCO apply failed.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Planning Center sync review' })).toBeInTheDocument();
    expect(integrationsAPI.getCheckinAvailability).not.toHaveBeenCalled();
  });
});
