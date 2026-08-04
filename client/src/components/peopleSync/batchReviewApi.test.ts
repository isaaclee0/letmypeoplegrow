import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsAPI, elvantoSyncAPI } from '../../services/api';
import { batchReviewApi } from './batchReviewApi';
import type {
  EstablishedLinkCorrection,
  PeopleSyncBatch,
  PeopleSyncCorrectionPreview,
  PeopleSyncPlan,
  PeopleSyncReview,
  PeopleSyncSelections,
} from './types';

vi.mock('../../services/api', () => ({
  PEOPLE_SYNC_BATCH_PREPARED_MESSAGE: 'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.',
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

const emptyPlan = (provider: 'planning_center' | 'elvanto'): PeopleSyncPlan => ({
  provider,
  authoritative: true,
  snapshot: { fetchedAt: '2026-08-02T01:00:00.000Z', mode: 'full' },
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
});

const reviewFor = (provider: 'planning_center' | 'elvanto', token: string): PeopleSyncReview => {
  const plan = emptyPlan(provider);
  return {
    runId: 41,
    reviewToken: token,
    plan,
    snapshot: plan.snapshot,
    summary: {
      linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
      promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0,
      renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
      familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
    },
  };
};

const batchFor = (provider: 'planning_center' | 'elvanto'): PeopleSyncBatch => ({
  id: 7,
  provider,
  name: provider === 'planning_center' ? 'Members' : 'Elvanto members',
  enabled: true,
  source: null,
  sourceRevision: 0,
  draftSource: null,
  draftSourceBaseRevision: null,
  draftSourceUpdatedAt: null,
  needsSourceReview: false,
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
});

describe('batchReviewApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects provider slugs that cannot identify a batch API', () => {
    expect(batchReviewApi('planning_centre')).toBeNull();
    expect(batchReviewApi('')).toBeNull();
  });

  it('normalizes the Planning Center batch review contract', async () => {
    const batch = batchFor('planning_center');
    const review = reviewFor('planning_center', 'pco-base-token');
    const preview: PeopleSyncCorrectionPreview = { ...review, reviewToken: 'pco-preview-token' };
    delete (preview as Partial<PeopleSyncReview>).runId;
    const corrections: Record<string, EstablishedLinkCorrection> = {
      'pco-1': { outcome: 'unlink', fromIndividualId: 19 },
    };
    const selections: PeopleSyncSelections = { decisionContractVersion: 2, identityDecisions: {} };

    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValue({ data: { success: true, batches: [batch] } } as never);
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValue({ data: { success: true, ...review } } as never);
    vi.mocked(integrationsAPI.previewPlanningCenterLinkCorrections)
      .mockResolvedValue({ data: { success: true, ...preview } } as never);
    vi.mocked(integrationsAPI.applyPlanningCenterBatch)
      .mockResolvedValue({ data: { success: true, runId: 41, status: 'applied', applied: {}, summary: {} } } as never);

    const adapter = batchReviewApi('planning-center');
    expect(adapter).not.toBeNull();
    expect(adapter?.provider).toBe('planning_center');
    expect(adapter?.returnTo).toBe('/app/settings?tab=integrations&integration=planning-center');
    await expect(adapter?.listBatches()).resolves.toEqual([batch]);
    await expect(adapter?.loadReview(batch)).resolves.toEqual({
      ...review,
      operationKind: 'people_sync',
      plan: { ...review.plan, operationKind: 'people_sync' },
    });
    await expect(adapter?.previewCorrections(batch, 'pco-base-token' as never, corrections)).resolves.toEqual({
      ...preview,
      operationKind: 'people_sync',
      plan: { ...preview.plan, operationKind: 'people_sync' },
    });
    await expect(adapter?.applyReview(batch, 'pco-preview-token' as never, selections)).resolves.toMatchObject({
      runId: 41,
      status: 'applied',
    });

    expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalledWith(7);
    expect(integrationsAPI.previewPlanningCenterLinkCorrections).toHaveBeenCalledWith(7, {
      baseReviewToken: 'pco-base-token',
      linkCorrections: corrections,
    });
    expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(7, {
      reviewToken: 'pco-preview-token',
      selections,
    });
  });

  it('normalizes the Elvanto batch review contract', async () => {
    const batch = batchFor('elvanto');
    const review = reviewFor('elvanto', 'elvanto-base-token');
    const preview: PeopleSyncCorrectionPreview = { ...review, reviewToken: 'elvanto-preview-token' };
    delete (preview as Partial<PeopleSyncReview>).runId;
    const corrections: Record<string, EstablishedLinkCorrection> = {
      'elvanto-1': { outcome: 'relink', fromIndividualId: 21, individualId: 22 },
    };
    const selections: PeopleSyncSelections = { decisionContractVersion: 2, identityDecisions: {} };

    vi.mocked(elvantoSyncAPI.listBatches)
      .mockResolvedValue({ data: { success: true, batches: [batch] } } as never);
    vi.mocked(elvantoSyncAPI.getBatchPlan)
      .mockResolvedValue({ data: { success: true, ...review } } as never);
    vi.mocked(elvantoSyncAPI.previewLinkCorrections)
      .mockResolvedValue({ data: { success: true, ...preview } } as never);
    vi.mocked(elvantoSyncAPI.applyBatch)
      .mockResolvedValue({ data: { success: true, runId: 42, status: 'applied', applied: {}, summary: {} } } as never);

    const adapter = batchReviewApi('elvanto');
    expect(adapter).not.toBeNull();
    expect(adapter?.provider).toBe('elvanto');
    expect(adapter?.returnTo).toBe('/app/settings?tab=integrations&integration=elvanto');
    await expect(adapter?.listBatches()).resolves.toEqual([batch]);
    await expect(adapter?.loadReview(batch)).resolves.toEqual({
      ...review,
      operationKind: 'people_sync',
      plan: { ...review.plan, operationKind: 'people_sync' },
    });
    await expect(adapter?.previewCorrections(batch, 'base-token' as never, corrections)).resolves.toEqual({
      ...preview,
      operationKind: 'people_sync',
      plan: { ...preview.plan, operationKind: 'people_sync' },
    });
    await expect(adapter?.applyReview(batch, 'elvanto-preview-token' as never, selections)).resolves.toMatchObject({
      runId: 42,
      status: 'applied',
    });

    expect(elvantoSyncAPI.previewLinkCorrections).toHaveBeenCalledWith(7, {
      baseReviewToken: 'base-token',
      linkCorrections: corrections,
    });
    expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledWith(7, {
      reviewToken: 'elvanto-preview-token',
      selections,
    });
  });

  it('rejects a review already marked for another operation at the batch boundary', async () => {
    const review = reviewFor('elvanto', 'wrong-operation-token');
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockResolvedValue({
      data: {
        success: true,
        ...review,
        operationKind: 'authority_switch',
        plan: { ...review.plan, operationKind: 'authority_switch' },
      },
    } as never);

    await expect(batchReviewApi('elvanto')?.loadReview(batchFor('elvanto'))).rejects.toThrow(
      'belongs to a different operation',
    );
  });

  it.each([
    ['planning-center', 'planning_center'],
    ['elvanto', 'elvanto'],
  ] as const)('cannot open, correct, or apply a prepared %s batch', async (slug, provider) => {
    const prepared = {
      ...batchFor(provider),
      operationalState: 'prepared' as const,
      reviewable: false,
      runnable: false,
    };
    const adapter = batchReviewApi(slug);

    await expect(adapter?.loadReview(prepared)).rejects.toThrow(
      'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.',
    );
    await expect(adapter?.previewCorrections(
      prepared,
      'review-token' as never,
      {},
    )).rejects.toThrow('Switch source of truth');
    await expect(adapter?.applyReview(
      prepared,
      'review-token' as never,
      { decisionContractVersion: 2, identityDecisions: {} },
    )).rejects.toThrow('Switch source of truth');

    expect(integrationsAPI.getPlanningCenterBatchPlan).not.toHaveBeenCalled();
    expect(integrationsAPI.previewPlanningCenterLinkCorrections).not.toHaveBeenCalled();
    expect(integrationsAPI.applyPlanningCenterBatch).not.toHaveBeenCalled();
    expect(elvantoSyncAPI.getBatchPlan).not.toHaveBeenCalled();
    expect(elvantoSyncAPI.previewLinkCorrections).not.toHaveBeenCalled();
    expect(elvantoSyncAPI.applyBatch).not.toHaveBeenCalled();
  });
});
