import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosHarness = vi.hoisted(() => {
  const requestUse = vi.fn();
  const responseUse = vi.fn();
  const instance = Object.assign(vi.fn(), {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: requestUse },
      response: { use: responseUse },
    },
  });
  return { instance, requestUse, responseUse };
});

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => axiosHarness.instance),
    isAxiosError: (error: { isAxiosError?: boolean }) => error?.isAxiosError === true,
  },
}));

import { integrationsAPI } from './api';
import type { HouseholdChoiceEdits, PeopleReviewToken } from '../components/peopleSync/types';

type RejectedInterceptor = (error: {
  config: { url: string; _retry?: boolean };
  response: { status: number; data?: { code?: string; error?: string } };
}) => Promise<unknown>;

const responseRejected = axiosHarness.responseUse.mock.calls[0][1] as RejectedInterceptor;

describe('API authentication response handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('user', JSON.stringify({ id: 1 }));
  });

  it('surfaces provider SYNC_SOURCE_AUTH 401 without refreshing or replaying the request', async () => {
    const providerError = {
      config: { url: '/integrations/people-sync/people-authority/preview' },
      response: {
        status: 401,
        data: { code: 'SYNC_SOURCE_AUTH', error: 'Reconnect Elvanto to continue.' },
      },
    };

    await expect(responseRejected(providerError)).rejects.toBe(providerError);

    expect(axiosHarness.instance.post).not.toHaveBeenCalled();
    expect(axiosHarness.instance).not.toHaveBeenCalled();
    expect(localStorage.getItem('user')).not.toBeNull();
  });

  it('still refreshes and replays an ordinary expired-session 401 once', async () => {
    const sessionError = {
      config: { url: '/individuals' },
      response: { status: 401 },
    };
    const replayed = { status: 200, data: { success: true } };
    axiosHarness.instance.post.mockResolvedValueOnce({ status: 200 });
    axiosHarness.instance.mockResolvedValueOnce(replayed);

    await expect(responseRejected(sessionError)).resolves.toBe(replayed);

    expect(axiosHarness.instance.post).toHaveBeenCalledWith('/auth/refresh');
    expect(sessionError.config._retry).toBe(true);
    expect(axiosHarness.instance).toHaveBeenCalledWith(sessionError.config);
  });
});


describe('Planning Center local household review requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axiosHarness.instance.get.mockResolvedValue({ status: 200, data: { success: true } });
    axiosHarness.instance.post.mockResolvedValue({ status: 200, data: { success: true } });
  });

  it('sends v2 local destinations and exact signed edits without a provider-household ID', async () => {
    const edits: HouseholdChoiceEdits = {
      current: { destination: { kind: 'keep' } },
      existing: { destination: { kind: 'existing', familyId: 17 }, displayName: 'Local family name' },
      create: { destination: { kind: 'create' }, displayName: 'New family' },
      forget: { destination: { kind: 'forget' } },
    };
    const baseReviewToken = 'original-review' as PeopleReviewToken<'people_sync'>;
    await integrationsAPI.previewPlanningCenterHouseholdChoices(7, { baseReviewToken, householdChoices: edits });
    expect(axiosHarness.instance.post).toHaveBeenCalledWith('/integrations/planning-center/sync-batches/7/preview-household-choices', {
      baseReviewToken: 'original-review', householdChoices: edits,
    }, { params: { background: 1 }, timeout: 120000 });
    await integrationsAPI.applyPlanningCenterBatch(7, {
      reviewToken: 'signed-local-preview' as PeopleReviewToken<'people_sync'>,
      selections: { householdChoices: edits },
    });
    expect(axiosHarness.instance.post).toHaveBeenLastCalledWith('/integrations/planning-center/sync-batches/7/apply', {
      reviewToken: 'signed-local-preview', selections: { householdChoices: edits },
    }, { params: { background: 1 }, timeout: 120000 });
  });
});


describe('Planning Center integration-wide review requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axiosHarness.instance.get.mockResolvedValue({ status: 200, data: { success: true } });
    axiosHarness.instance.post.mockResolvedValue({ status: 200, data: { success: true } });
  });
  it('uses null-scope review endpoints and preserves signed bodies without a batch ID', async () => {
    const baseReviewToken = 'combined-base' as PeopleReviewToken<'people_sync'>;
    const householdChoices: HouseholdChoiceEdits = { household: { destination: { kind: 'keep' } } };
    await integrationsAPI.getPlanningCenterSyncPlan();
    expect(axiosHarness.instance.get).toHaveBeenCalledWith('/integrations/planning-center/sync/plan', { params: { background: 1 }, timeout: 120000 });
    await integrationsAPI.previewPlanningCenterSyncLinkCorrections({ baseReviewToken, linkCorrections: {} });
    expect(axiosHarness.instance.post).toHaveBeenLastCalledWith('/integrations/planning-center/sync/preview-link-corrections', { baseReviewToken, linkCorrections: {} }, { params: { background: 1 }, timeout: 120000 });
    await integrationsAPI.previewPlanningCenterSyncHouseholdChoices({ baseReviewToken, householdChoices });
    expect(axiosHarness.instance.post).toHaveBeenLastCalledWith('/integrations/planning-center/sync/preview-household-choices', { baseReviewToken, householdChoices }, { params: { background: 1 }, timeout: 120000 });
    await integrationsAPI.applyPlanningCenterSync({ reviewToken: baseReviewToken, selections: { householdChoices } });
    expect(axiosHarness.instance.post).toHaveBeenLastCalledWith('/integrations/planning-center/sync/apply', { reviewToken: baseReviewToken, selections: { householdChoices } }, { params: { background: 1 }, timeout: 120000 });
  });
});


it('polls a slow signed apply through a gateway error and returns the final result without replaying the apply', async () => {
  vi.useFakeTimers();
  try {
    vi.clearAllMocks();
    const pending = { status: 202, data: { jobId: 'job' } };
    const result = { status: 200, data: { success: true, runId: 19 } };
    axiosHarness.instance.post.mockResolvedValueOnce(pending);
    axiosHarness.instance.get.mockResolvedValue(pending);
    const work = integrationsAPI.applyPlanningCenterSync({ reviewToken: 'signed' as PeopleReviewToken<'people_sync'>, selections: {} });
    await vi.advanceTimersByTimeAsync(92000);
    axiosHarness.instance.get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 504 } }).mockResolvedValueOnce(result);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(work).resolves.toEqual(result);
    expect(axiosHarness.instance.post).toHaveBeenCalledTimes(1);
    expect(axiosHarness.instance.get.mock.calls.every(([url]) => url === '/integrations/planning-center/sync/jobs/job')).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
