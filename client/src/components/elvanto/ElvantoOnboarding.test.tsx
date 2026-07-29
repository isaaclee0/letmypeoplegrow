import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoOnboarding, { type ElvantoOnboardingStep } from './ElvantoOnboarding';
import type { PeopleSyncBatch, PeopleSyncReview } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  integrationsAPI: { connectElvanto: vi.fn() },
  elvantoSyncAPI: { createBatch: vi.fn(), getBatchPlan: vi.fn(), applyBatch: vi.fn() },
  gatheringsAPI: { getAll: vi.fn(), create: vi.fn() },
  peopleSyncAPI: { previewAuthority: vi.fn(), applyAuthority: vi.fn() },
}));

vi.mock('../peopleSync/BatchSourceControls', () => ({
  default: ({ onChange }: { onChange: (source: { sourceKind: 'elvanto_group'; sourceExternalId: string }) => void }) => (
    <button type="button" onClick={() => onChange({ sourceKind: 'elvanto_group', sourceExternalId: 'group-youth' })}>Choose Youth Group</button>
  ),
}));

vi.mock('../peopleSync/SyncReview', () => ({
  default: ({ onApply }: { onApply: (reviewToken: string, selections: Record<string, never>) => void }) => (
    <section aria-label="Elvanto source review"><p>Elvanto sync review</p><button type="button" onClick={() => onApply('review-token', {})}>Apply reviewed source</button></section>
  ),
}));

const draftBatch = {
  id: 42, provider: 'elvanto', name: 'Youth Group', enabled: true,
  source: null, sourceRevision: 0,
  draftSource: { kind: 'elvanto_group', externalId: 'group-youth', name: 'Youth Group', memberCount: null, providerRefreshedAt: null },
  draftSourceBaseRevision: 0, draftSourceUpdatedAt: '2026-07-29T00:00:00.000Z', needsSourceReview: true,
  initialSourceReviewPending: true, sourceStatus: 'unknown', sourceStatusCheckedAt: null, sourceStatusErrorCode: null,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
} as PeopleSyncBatch;

const review: PeopleSyncReview = {
  runId: 17, reviewToken: 'review-token', snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' },
  plan: {
    provider: 'elvanto', authoritative: false, snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [], promoteToRegular: [],
    demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [], renameFamily: [], addToGathering: [],
    removeFromGathering: [], ambiguousPeople: [], familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
  },
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0, promoteToRegular: 0,
    demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0, renameFamily: 0, addToGathering: 0,
    removeFromGathering: 0, ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
};

function Harness() {
  const [step, setStep] = useState<ElvantoOnboardingStep>('elvanto-batch');
  return <ElvantoOnboarding step={step} onStepChange={setStep} onContinueToGatherings={vi.fn()} />;
}

describe('ElvantoOnboarding source review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { batch: draftBatch } });
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockResolvedValue({ data: review });
    vi.mocked(elvantoSyncAPI.applyBatch).mockResolvedValue({ data: { success: true, runId: 17, status: 'applied', applied: {}, summary: review.summary } });
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatherings: [] } });
  });

  it('creates a Group source draft, reviews it, and only then advances after promotion', async () => {
    render(<Harness />);

    expect(screen.getByText(/Choose one Elvanto Category or Group/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose Youth Group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));

    await waitFor(() => expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'elvanto_group', sourceExternalId: 'group-youth',
    })));
    await waitFor(() => expect(elvantoSyncAPI.getBatchPlan).toHaveBeenCalledWith(42));
    expect(await screen.findByText(/promotes the selected people source/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed source' }));
    await waitFor(() => expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledWith(42, {
      reviewToken: 'review-token', selections: {},
    }));
    expect(await screen.findByText('Keep LMPG aligned with Elvanto?')).toBeInTheDocument();
  });
});
