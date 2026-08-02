import { elvantoSyncAPI, integrationsAPI } from '../../services/api';
import type {
  EstablishedLinkCorrection,
  PeopleSyncApplyResult,
  PeopleSyncBatch,
  PeopleSyncCorrectionPreview,
  PeopleSyncReview,
  PeopleSyncSelections,
  SyncProvider,
} from './types';

export type BatchReviewProviderSlug = 'planning-center' | 'elvanto';

export interface BatchReviewAdapter {
  provider: SyncProvider;
  returnTo: string;
  listBatches: () => Promise<PeopleSyncBatch[]>;
  loadReview: (batchId: number) => Promise<PeopleSyncReview>;
  previewCorrections: (
    batchId: number,
    baseReviewToken: string,
    linkCorrections: Record<string, EstablishedLinkCorrection>,
  ) => Promise<PeopleSyncCorrectionPreview>;
  applyReview: (
    batchId: number,
    reviewToken: string,
    selections: PeopleSyncSelections,
  ) => Promise<PeopleSyncApplyResult>;
}

function responseBody<T extends object>(data: T & { success?: boolean }): T {
  const { success: _success, ...body } = data;
  return body as T;
}

const planningCenterAdapter: BatchReviewAdapter = {
  provider: 'planning_center',
  returnTo: '/app/settings?tab=integrations&integration=planning-center',
  async listBatches() {
    const response = await integrationsAPI.getPlanningCenterSyncBatches();
    return response.data.batches;
  },
  async loadReview(batchId) {
    const response = await integrationsAPI.getPlanningCenterBatchPlan(batchId);
    return responseBody<PeopleSyncReview>(response.data);
  },
  async previewCorrections(batchId, baseReviewToken, linkCorrections) {
    const response = await integrationsAPI.previewPlanningCenterLinkCorrections(batchId, {
      baseReviewToken,
      linkCorrections,
    });
    return responseBody<PeopleSyncCorrectionPreview>(response.data);
  },
  async applyReview(batchId, reviewToken, selections) {
    const response = await integrationsAPI.applyPlanningCenterBatch(batchId, { reviewToken, selections });
    return responseBody<PeopleSyncApplyResult>(response.data);
  },
};

const elvantoAdapter: BatchReviewAdapter = {
  provider: 'elvanto',
  returnTo: '/app/settings?tab=integrations&integration=elvanto',
  async listBatches() {
    const response = await elvantoSyncAPI.listBatches();
    return response.data.batches;
  },
  async loadReview(batchId) {
    const response = await elvantoSyncAPI.getBatchPlan(batchId);
    return responseBody<PeopleSyncReview>(response.data);
  },
  async previewCorrections(batchId, baseReviewToken, linkCorrections) {
    const response = await elvantoSyncAPI.previewLinkCorrections(batchId, {
      baseReviewToken,
      linkCorrections,
    });
    return responseBody<PeopleSyncCorrectionPreview>(response.data);
  },
  async applyReview(batchId, reviewToken, selections) {
    const response = await elvantoSyncAPI.applyBatch(batchId, { reviewToken, selections });
    return responseBody<PeopleSyncApplyResult>(response.data);
  },
};

export function batchReviewApi(provider: string): BatchReviewAdapter | null {
  if (provider === 'planning-center') return planningCenterAdapter;
  if (provider === 'elvanto') return elvantoAdapter;
  return null;
}
