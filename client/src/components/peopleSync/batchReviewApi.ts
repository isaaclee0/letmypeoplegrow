import {
  elvantoSyncAPI,
  integrationsAPI,
  PEOPLE_SYNC_BATCH_PREPARED_MESSAGE,
} from '../../services/api';
import { tagLegacyPeopleReview } from './types';
import type {
  EstablishedLinkCorrection,
  HouseholdChoiceEdits,
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
  loadReview: (batch: PeopleSyncBatch | null) => Promise<PeopleSyncOperationReview>;
  previewCorrections: (
    batch: PeopleSyncBatch | null,
    baseReviewToken: PeopleReviewToken<'people_sync'>,
    linkCorrections: Record<string, EstablishedLinkCorrection>,
  ) => Promise<PeopleSyncOperationCorrectionPreview>;
  previewHouseholdChoices?: (
    batch: PeopleSyncBatch | null,
    baseReviewToken: PeopleReviewToken<'people_sync'>,
    householdChoices: HouseholdChoiceEdits,
  ) => Promise<PeopleSyncOperationCorrectionPreview>;
  applyReview: (
    batch: PeopleSyncBatch | null,
    reviewToken: PeopleReviewToken<'people_sync'>,
    selections: PeopleSyncSelections,
  ) => Promise<PeopleSyncApplyResult>;
}

function assertBatchReviewable(batch: PeopleSyncBatch | null, provider: SyncProvider): asserts batch is PeopleSyncBatch {
  if (!batch) throw new Error('This provider requires a sync batch.');
  if (batch.provider !== provider) throw new Error('This sync batch belongs to a different provider.');
  if (batch.reviewable) return;
  if (batch.operationalState === 'prepared') throw new Error(PEOPLE_SYNC_BATCH_PREPARED_MESSAGE);
  throw new Error('This sync batch is not available for review.');
}

function responseBody<T extends object>(data: T & { success?: boolean }): T {
  const { success: _success, ...body } = data;
  return body as T;
}

function assertIntegrationSources(review: Pick<PeopleSyncOperationReview, 'plan'>): void {
  const lists = review.plan.sourceContext?.reviewedLists;
  const validSource = (source: unknown): boolean => {
    if (!source || typeof source !== 'object') return false;
    const value = source as Record<string, unknown>;
    return value.kind === 'planning_center_list'
      && typeof value.externalId === 'string' && value.externalId.trim().length > 0
      && typeof value.name === 'string' && value.name.trim().length > 0;
  };
  if (!Array.isArray(lists) || lists.length === 0
    || new Set(lists.map((list) => list?.batchId)).size !== lists.length
    || !lists.every((list) => list && Number.isSafeInteger(list.batchId) && list.batchId > 0
      && typeof list.name === 'string' && list.name.trim().length > 0
      && (list.gatheringTypeId === null || (Number.isSafeInteger(list.gatheringTypeId) && list.gatheringTypeId > 0))
      && typeof list.isDraft === 'boolean' && validSource(list.selectedSource)
      && (list.activeSource === null || validSource(list.activeSource)))) {
    throw new Error('The reviewed list scope is missing or invalid. Refresh this review.');
  }
}

const planningCenterAdapter: BatchReviewAdapter = {
  provider: 'planning_center',
  returnTo: '/app/settings?tab=integrations&integration=planning-center',
  async listBatches() {
    const response = await integrationsAPI.getPlanningCenterSyncBatches();
    return response.data.batches;
  },
  async loadReview(batch) {
    if (batch) assertBatchReviewable(batch, 'planning_center');
    const response = await (batch ? integrationsAPI.getPlanningCenterBatchPlan(batch.id) : integrationsAPI.getPlanningCenterSyncPlan());
    const review = tagLegacyPeopleReview(responseBody(response.data), 'people_sync');
    if (!batch) assertIntegrationSources(review);
    return review;
  },
  async previewCorrections(batch, baseReviewToken, linkCorrections) {
    if (batch) assertBatchReviewable(batch, 'planning_center');
    const body = { baseReviewToken, linkCorrections };
    const response = await (batch ? integrationsAPI.previewPlanningCenterLinkCorrections(batch.id, body) : integrationsAPI.previewPlanningCenterSyncLinkCorrections(body));
    const review = tagLegacyPeopleReview(responseBody(response.data), 'people_sync');
    if (!batch) assertIntegrationSources(review);
    return review;
  },
  async previewHouseholdChoices(batch, baseReviewToken, householdChoices) {
    if (batch) assertBatchReviewable(batch, 'planning_center');
    const body = { baseReviewToken, householdChoices };
    const response = await (batch ? integrationsAPI.previewPlanningCenterHouseholdChoices(batch.id, body) : integrationsAPI.previewPlanningCenterSyncHouseholdChoices(body));
    const review = tagLegacyPeopleReview(responseBody(response.data), 'people_sync');
    if (!batch) assertIntegrationSources(review);
    return review;
  },
  async applyReview(batch, reviewToken, selections) {
    if (batch) assertBatchReviewable(batch, 'planning_center');
    const body = { reviewToken, selections };
    const response = await (batch ? integrationsAPI.applyPlanningCenterBatch(batch.id, body) : integrationsAPI.applyPlanningCenterSync(body));
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
