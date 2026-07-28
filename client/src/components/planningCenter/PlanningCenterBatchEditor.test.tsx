import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanningCenterBatchEditor from './PlanningCenterBatchEditor';
import { gatheringsAPI, integrationsAPI, peopleSyncAPI, type SyncBatch } from '../../services/api';
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

const legacyBatch: SyncBatch = {
  id: 9, name: 'Legacy members', membershipFilterEnabled: true, membershipAllowlist: ['Member'],
  fieldFilterEnabled: false, fieldFilters: [], defaultPeopleType: 'regular', gatheringTypeId: null,
  gatheringAutoRemoveEnabled: false, scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  lastSyncAt: null, lastSyncResult: null,
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

function renderEditor(batch: PeopleSyncBatch<BooleanFilterConfigV2> | SyncBatch | null = v2Batch, onSaved = vi.fn()) {
  return render(<PlanningCenterBatchEditor batch={batch} onSaved={onSaved} onCancel={vi.fn()} />);
}

describe('PlanningCenterBatchEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: [] });
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockResolvedValue({ data: { success: true, metadata, snapshot: preview().data.snapshot } });
    vi.mocked(peopleSyncAPI.previewFilter).mockResolvedValue(preview());
  });

  it('keeps the legacy panel DTO at a typed boundary while rendering the shared v2 filter editor', async () => {
    renderEditor(legacyBatch);

    expect(await screen.findByText('Who qualifies?')).toBeInTheDocument();
    expect(screen.getByText('Qualification rules')).toBeInTheDocument();
    expect(screen.getByLabelText('Always exclude')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh people data' })).toBeInTheDocument();
    expect(screen.getByLabelText('Gathering assignment')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
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
    expect(onSaved).not.toHaveBeenCalled();
    resolveUpdate({ data: { batch: v2Batch } });
    await waitFor(() => expect(peopleSyncAPI.saveFilterDraft).toHaveBeenCalledWith('planning_center', 4, expect.objectContaining({ filterConfig: filter })));
    expect(onSaved).not.toHaveBeenCalled();
    resolveDraft({ data: { success: true, batch: v2Batch } });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 4 })));
  });

  it('requires acknowledgement for a broad warning and keeps the editor open when saving the draft fails', async () => {
    vi.mocked(peopleSyncAPI.previewFilter).mockResolvedValue(preview(['BROAD_FILTER']));
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockResolvedValue({ data: { batch: v2Batch } });
    vi.mocked(peopleSyncAPI.saveFilterDraft).mockRejectedValue({ response: { data: { error: 'Draft could not be saved.' } } });
    renderEditor();

    await screen.findByLabelText('Acknowledge broad filter');
    expect(screen.getByRole('button', { name: 'Save batch' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Acknowledge broad filter'));
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    expect(await screen.findByText('Draft could not be saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save batch' })).toBeInTheDocument();
  });
});
