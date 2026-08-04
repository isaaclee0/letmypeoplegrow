import {
  elvantoSyncAPI,
  integrationsAPI,
  PEOPLE_SYNC_BATCH_PREPARED_MESSAGE,
} from '../../services/api';
import { tagLegacyPeopleReview } from './types';
import type {
  EstablishedLinkCorrection,
  PeopleReviewToken,
  PeopleSyncApplyResult,
  PeopleSyncBatch,
  PeopleSyncOperationCorrectionPreview,
  PeopleSyncOperationReview,
  PeopleSyncSelections,
  SyncProvider,
} from './types';

export type BatchReviewProviderSlug = 'planning-center' | 'elvanto';

export interface BatchReviewAdapter {
  provider: SyncProvider;
  returnTo: string;
  listBatches: () => Promise<PeopleSyncBatch[]>;
  loadReview: (batch: PeopleSyncBatch) => Promise<PeopleSyncOperationReview>;
  previewCorrections: (
    batch: PeopleSyncBatch,
    baseReviewToken: PeopleReviewToken<'people_sync'>,
    linkCorrections: Record<string, EstablishedLinkCorrection>,
  ) => Promise<PeopleSyncOperationCorrectionPreview>;
  applyReview: (
    batch: PeopleSyncBatch,
    reviewToken: PeopleReviewToken<'people_sync'>,
    selections: PeopleSyncSelections,
  ) => Promise<PeopleSyncApplyResult>;
}

function assertBatchReviewable(batch: PeopleSyncBatch, provider: SyncProvider): void {
  if (batch.provider !== provider) throw new Error('This sync batch belongs to a different provider.');
  if (batch.reviewable) return;
  if (batch.operationalState === 'prepared') throw new Error(PEOPLE_SYNC_BATCH_PREPARED_MESSAGE);
  throw new Error('This sync batch is not available for review.');
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
  async loadReview(batch) {
    assertBatchReviewable(batch, 'planning_center');
    const response = await integrationsAPI.getPlanningCenterBatchPlan(batch.id);
    return tagLegacyPeopleReview(responseBody(response.data), 'people_sync');
  },
  async previewCorrections(batch, baseReviewToken, linkCorrections) {
    assertBatchReviewable(batch, 'planning_center');
    const response = await integrationsAPI.previewPlanningCenterLinkCorrections(batch.id, {
      baseReviewToken,
      linkCorrections,
    });
    return tagLegacyPeopleReview(responseBody(response.data), 'people_sync');
  },
  async applyReview(batch, reviewToken, selections) {
    assertBatchReviewable(batch, 'planning_center');
    const response = await integrationsAPI.applyPlanningCenterBatch(batch.id, { reviewToken, selections });
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
  async loadReview(batch) {
    assertBatchReviewable(batch, 'elvanto');
    const response = await elvantoSyncAPI.getBatchPlan(batch.id);
    return tagLegacyPeopleReview(responseBody(response.data), 'people_sync');
  },
  async previewCorrections(batch, baseReviewToken, linkCorrections) {
    assertBatchReviewable(batch, 'elvanto');
    const response = await elvantoSyncAPI.previewLinkCorrections(batch.id, {
      baseReviewToken,
      linkCorrections,
    });
    return tagLegacyPeopleReview(responseBody(response.data), 'people_sync');
  },
  async applyReview(batch, reviewToken, selections) {
    assertBatchReviewable(batch, 'elvanto');
    const response = await elvantoSyncAPI.applyBatch(batch.id, { reviewToken, selections });
    return responseBody<PeopleSyncApplyResult>(response.data);
  },
};

export function batchReviewApi(provider: string): BatchReviewAdapter | null {
  if (provider === 'planning-center') return planningCenterAdapter;
  if (provider === 'elvanto') return elvantoAdapter;
  return null;
}
