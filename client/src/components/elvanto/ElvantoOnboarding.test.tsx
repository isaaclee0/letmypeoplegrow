import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, gatheringsAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import type { PeopleSyncBatch, PeopleSyncPlan, PeopleSyncReview } from '../peopleSync/types';
import ElvantoOnboarding, { reduceElvantoConnection, type ElvantoOnboardingStep } from './ElvantoOnboarding';

vi.mock('../../services/api', () => ({
  integrationsAPI: { connectElvanto: vi.fn() },
  elvantoSyncAPI: {
    getMetadata: vi.fn(), createBatch: vi.fn(), updateBatch: vi.fn(), refreshMetadata: vi.fn(),
    getBatchPlan: vi.fn(), applyBatch: vi.fn(),
  },
  gatheringsAPI: { getAll: vi.fn(), create: vi.fn() },
  peopleSyncAPI: { previewAuthority: vi.fn(), applyAuthority: vi.fn() },
}));

const metadata = {
  fetchedAt: '2026-07-25T10:00:00.000Z', categories: [], groups: [], demographics: [],
  departments: [], serviceTypes: [], locations: [], customFields: [],
};

const batch: PeopleSyncBatch = {
  id: 12, provider: 'elvanto', name: 'Elvanto people', enabled: true, filterSchemaVersion: 2,
  filterConfig: { branches: [], exclusions: [] }, filterRevision: 1,
  draftFilterSchemaVersion: 2, draftFilterConfig: { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] },
  draftFilterBaseRevision: 1, draftFilterUpdatedAt: '2026-07-28T08:00:00.000Z', needsFilterReview: true,
  initialFilterReviewPending: true,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
};

const emptyPlan: PeopleSyncPlan = {
  provider: 'elvanto', authoritative: false,
  snapshot: { fetchedAt: '2026-07-25T10:00:00.000Z', mode: 'full' },
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
};

function review(reviewToken: string): PeopleSyncReview {
  return {
    runId: 4, reviewToken, plan: emptyPlan, snapshot: emptyPlan.snapshot,
    summary: {
      linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
      promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0,
      moveFamily: 0, renameFamily: 0, addToGathering: 0, removeFromGathering: 0,
      ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
    },
  };
}

function Harness({ onContinue = vi.fn() }: { onContinue?: () => void }) {
  const [step, setStep] = useState<ElvantoOnboardingStep>('elvanto-connect');
  return <ElvantoOnboarding step={step} onStepChange={setStep} onContinueToGatherings={onContinue} />;
}

describe('ElvantoOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationsAPI.connectElvanto).mockResolvedValue({ data: { success: true, status: {} as never } });
    vi.mocked(elvantoSyncAPI.getMetadata).mockResolvedValue({ data: { success: true, metadata, stale: false, cached: true } });
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatherings: [] } });
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { success: true, batch } });
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockResolvedValue({ data: { success: true, ...review('batch-review') } });
    vi.mocked(elvantoSyncAPI.applyBatch).mockResolvedValue({ data: { success: true, runId: 4, status: 'applied', applied: {} as never, summary: review('batch-review').summary } });
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review('authority-review') } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({ data: { success: true, runId: 5, status: 'applied', applied: {} as never, summary: review('authority-review').summary } });
  });

  it('clears the in-memory API key when connection succeeds', () => {
    expect(reduceElvantoConnection(
      { apiKey: 'secret-key', connected: false },
      { type: 'connected' },
    )).toEqual({ apiKey: '', connected: true });
  });

  it('connects, configures a batch, applies its review, then reviews and applies optional authority', async () => {
    const onContinue = vi.fn();
    render(<Harness onContinue={onContinue} />);

    const keyInput = screen.getByLabelText('Elvanto API key');
    expect(keyInput).toHaveAttribute('type', 'password');
    fireEvent.change(keyInput, { target: { value: 'secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));

    expect(await screen.findByLabelText('Batch name')).toBeInTheDocument();
    expect(integrationsAPI.connectElvanto).toHaveBeenCalledWith('secret-key');
    expect(screen.queryByDisplayValue('secret-key')).not.toBeInTheDocument();
    expect(screen.queryByText('secret-key')).not.toBeInTheDocument();
    expect(elvantoSyncAPI.getMetadata).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    expect(await screen.findByText('Keep LMPG aligned with Elvanto?')).toBeInTheDocument();
    expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledWith(12, {
      reviewToken: 'batch-review', selections: expect.any(Object),
    });
    expect(screen.getByText(/linked names, child status, family membership and active status are managed in Elvanto/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));
    expect(screen.getByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    await waitFor(() => expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledWith('elvanto', 'authority-review', expect.any(Object)));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('keeps an invalid API key retryable without advancing', async () => {
    vi.mocked(integrationsAPI.connectElvanto)
      .mockRejectedValueOnce({ response: { data: { error: 'Invalid API key' } } })
      .mockResolvedValueOnce({ data: { success: true, status: {} as never } });
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid API key');

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'good-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));
    expect(await screen.findByLabelText('Batch name')).toBeInTheDocument();
  });

  it('retries metadata when Elvanto is temporarily unavailable after connection', async () => {
    vi.mocked(elvantoSyncAPI.getMetadata)
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: { success: true, metadata, stale: false, cached: true } });
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'valid-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Elvanto is unavailable/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading Elvanto' }));

    expect(await screen.findByLabelText('Batch name')).toBeInTheDocument();
    expect(integrationsAPI.connectElvanto).toHaveBeenCalledTimes(1);
    expect(elvantoSyncAPI.getMetadata).toHaveBeenCalledTimes(2);
  });

  it('can skip before connecting', async () => {
    const beforeConnection = vi.fn();
    render(<Harness onContinue={beforeConnection} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip Elvanto' }));
    expect(beforeConnection).toHaveBeenCalledTimes(1);
  });

  it('keeps onboarding in the review when applying the first draft fails', async () => {
    vi.mocked(elvantoSyncAPI.applyBatch).mockRejectedValueOnce({ response: { data: { error: 'Review expired' } } });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'valid-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create batch' }));
    await screen.findByText('Elvanto sync review');
    expect(screen.queryByRole('button', { name: 'Continue without importing' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to apply sync.');
    expect(screen.getByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.queryByText('Keep LMPG aligned with Elvanto?')).not.toBeInTheDocument();
  });

  it('allows declining authority after the reviewed import', async () => {
    const onContinue = vi.fn();
    render(<Harness onContinue={onContinue} />);
    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'valid-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create batch' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply sync' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
