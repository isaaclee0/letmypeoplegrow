import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanningCenterBatchEditor from './PlanningCenterBatchEditor';
import { gatheringsAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import type { BooleanFilterConfigV2, FilterMetadata, PeopleSyncBatch } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  gatheringsAPI: { getAll: vi.fn(), create: vi.fn() },
  integrationsAPI: { createPlanningCenterSyncBatch: vi.fn(), updatePlanningCenterSyncBatch: vi.fn() },
  peopleSyncAPI: { getFilterMetadata: vi.fn(), previewFilter: vi.fn(), refreshFilterSnapshot: vi.fn(), saveFilterDraft: vi.fn(), discardFilterDraft: vi.fn() },
}));

const filter: BooleanFilterConfigV2 = {
  branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', 'music'] }] }],
  exclusions: [{ dimensionId: 'status', values: ['archived'] }],
};

const metadata: FilterMetadata = {
  dimensions: [
    { id: 'groups', label: 'Groups', cardinality: 'multi', category: 'People', values: [{ id: 'youth', label: 'Youth', count: 12 }, { id: 'music', label: 'Music', count: 8 }] },
    { id: 'status', label: 'Status', cardinality: 'single', category: 'People', values: [{ id: 'active', label: 'Active', count: 18 }, { id: 'archived', label: 'Archived', count: 2 }] },
  ],
};

const v2Batch: PeopleSyncBatch<BooleanFilterConfigV2> = {
  id: 4, provider: 'planning_center', name: 'Members', enabled: true, filterSchemaVersion: 2,
  filterConfig: filter, filterRevision: 1, draftFilterSchemaVersion: 2, draftFilterConfig: filter,
  draftFilterBaseRevision: 1, draftFilterUpdatedAt: '2026-07-28T00:00:00.000Z', needsFilterReview: true,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: 8, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
};

const productionLegacyBatch: PeopleSyncBatch = {
  ...v2Batch,
  filterSchemaVersion: 1,
  filterConfig: { membershipFilterEnabled: true, membershipAllowlist: ['Member'], fieldFilterEnabled: true, fieldFilters: [{ fieldDefinitionId: 'membership', values: ['Member'] }] },
  draftFilterSchemaVersion: null,
  draftFilterConfig: null,
};

function preview(warnings: Array<'BROAD_FILTER'> = []) {
  return {
    data: {
      success: true, matchCount: 12, snapshot: { id: 'snapshot', capturedAt: '2026-07-28T00:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: ['groups', 'status'] },
      overlaps: [{ batchId: 7, batchName: 'Youth', count: 3 }], uniqueEnabledPopulationCount: 20,
      missingDimensionIds: [], warnings,
    },
  };
}

function renderEditor(batch: PeopleSyncBatch | null = v2Batch, onSaved = vi.fn()) {
  return render(<PlanningCenterBatchEditor batch={batch} onSaved={onSaved} onCancel={vi.fn()} />);
}

describe('PlanningCenterBatchEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: [] });
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockResolvedValue({ data: { success: true, metadata, snapshot: preview().data.snapshot } });
    vi.mocked(peopleSyncAPI.previewFilter).mockResolvedValue(preview());
  });

  it('keeps a production-shaped legacy PCO batch read-only without loading or clearing its criteria', async () => {
    renderEditor(productionLegacyBatch);

    expect(await screen.findByText('Who qualifies?')).toBeInTheDocument();
    expect(screen.getByText(/criteria must be upgraded/)).toBeInTheDocument();
    expect(screen.queryByText('Qualification rules')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save batch' })).toBeDisabled();
    expect(screen.getByLabelText('Batch name')).toBeDisabled();
    expect(screen.getByLabelText('New people from this batch are added as')).toBeDisabled();
    expect(screen.getByLabelText('Gathering assignment')).toBeDisabled();
    expect(screen.getByLabelText('Runs automatically')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(peopleSyncAPI.getFilterMetadata).not.toHaveBeenCalled();
    expect(integrationsAPI.updatePlanningCenterSyncBatch).not.toHaveBeenCalled();
    expect(peopleSyncAPI.saveFilterDraft).not.toHaveBeenCalled();
  });

  it('uses a draft on reopen, retains the active criteria, and can discard only the draft', async () => {
    vi.mocked(peopleSyncAPI.discardFilterDraft).mockResolvedValue({ data: { success: true, batch: { ...v2Batch, draftFilterConfig: null, draftFilterSchemaVersion: null, draftFilterBaseRevision: null, draftFilterUpdatedAt: null, needsFilterReview: false } } });
    renderEditor();

    expect(await screen.findByText('Active criteria are unchanged until you complete a full review.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument();
    expect(screen.getByText('Match all')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(peopleSyncAPI.discardFilterDraft).toHaveBeenCalledWith('planning_center', 4));
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
  });

  it('creates one schema-v2 batch with the proposed draft', async () => {
    const created = { ...v2Batch, id: 10, needsFilterReview: true };
    vi.mocked(integrationsAPI.createPlanningCenterSyncBatch).mockResolvedValue({ data: { batch: created } });
    const onSaved = vi.fn();
    renderEditor(null, onSaved);

    await screen.findByText('Who qualifies?');
    fireEvent.change(screen.getByLabelText('Batch name'), { target: { value: 'New members' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));
    await waitFor(() => expect(integrationsAPI.createPlanningCenterSyncBatch).toHaveBeenCalledTimes(1));
    expect(integrationsAPI.createPlanningCenterSyncBatch).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New members', filterSchemaVersion: 2, draftFilterConfig: expect.objectContaining({ branches: [], exclusions: [] }),
    }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ needsFilterReview: true }));
  });

  it('waits for non-filter settings and the draft save before closing', async () => {
    let resolveUpdate!: (value: { data: { batch: PeopleSyncBatch<BooleanFilterConfigV2> } }) => void;
    let resolveDraft!: (value: { data: { success: true; batch: PeopleSyncBatch<BooleanFilterConfigV2> } }) => void;
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    vi.mocked(peopleSyncAPI.saveFilterDraft).mockReturnValue(new Promise((resolve) => { resolveDraft = resolve; }));
    const onSaved = vi.fn();
    renderEditor(v2Batch, onSaved);

    await screen.findByText('Who qualifies?');
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(integrationsAPI.updatePlanningCenterSyncBatch).toHaveBeenCalledWith(4, expect.not.objectContaining({
      membershipFilterEnabled: expect.anything(), membershipAllowlist: expect.anything(),
      fieldFilterEnabled: expect.anything(), fieldFilters: expect.anything(),
    })));
    expect(onSaved).not.toHaveBeenCalled();
    resolveUpdate({ data: { batch: v2Batch } });
    await waitFor(() => expect(peopleSyncAPI.saveFilterDraft).toHaveBeenCalledWith('planning_center', 4, expect.objectContaining({ filterConfig: filter })));
    expect(onSaved).not.toHaveBeenCalled();
    const latestDraft = { ...v2Batch, draftFilterConfig: null, draftFilterSchemaVersion: null, draftFilterBaseRevision: null, draftFilterUpdatedAt: null, needsFilterReview: false };
    resolveDraft({ data: { success: true, batch: latestDraft } });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(latestDraft));
  });

  it('requires acknowledgement for a broad warning and keeps the editor open when saving the draft fails', async () => {
    vi.mocked(peopleSyncAPI.previewFilter).mockResolvedValue(preview(['BROAD_FILTER']));
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockResolvedValue({ data: { batch: v2Batch } });
    vi.mocked(peopleSyncAPI.saveFilterDraft).mockRejectedValue({ response: { data: { error: 'Draft could not be saved.' } } });
    renderEditor();

    await screen.findByLabelText('Acknowledge broad filter');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save batch' })).toBeDisabled());
    fireEvent.click(screen.getByLabelText('Acknowledge broad filter'));
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Batch settings were saved, but filter draft was not: Draft could not be saved.'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Save batch' })).toBeInTheDocument();
  });

  it('reuses a newly created gathering when a saved batch needs its filter draft retried', async () => {
    vi.mocked(gatheringsAPI.create).mockResolvedValue({ data: { id: 77 } });
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockResolvedValue({ data: { batch: v2Batch } });
    vi.mocked(peopleSyncAPI.saveFilterDraft)
      .mockRejectedValueOnce({ response: { data: { error: 'Draft could not be saved.' } } })
      .mockResolvedValueOnce({ data: { success: true, batch: v2Batch } });
    const onSaved = vi.fn();
    renderEditor(v2Batch, onSaved);

    await screen.findByText('Who qualifies?');
    fireEvent.change(screen.getByLabelText('Gathering assignment'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('New gathering name'), { target: { value: 'New gathering' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('The gathering was created and Batch settings were saved, but filter draft was not: Draft could not be saved.'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(gatheringsAPI.create).toHaveBeenCalledTimes(1);
    expect(integrationsAPI.updatePlanningCenterSyncBatch).toHaveBeenCalledTimes(2);
    expect(peopleSyncAPI.saveFilterDraft).toHaveBeenCalledTimes(2);
  });
});
