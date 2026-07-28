import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ElvantoBatchEditor from './ElvantoBatchEditor';
import type { BooleanFilterConfigV2, ElvantoMetadata, FilterMetadata, PeopleSyncBatch } from '../peopleSync/types';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  elvantoSyncAPI: { createBatch: vi.fn(), updateBatch: vi.fn() },
  gatheringsAPI: { create: vi.fn() },
  peopleSyncAPI: { getFilterMetadata: vi.fn(), previewFilter: vi.fn(), refreshFilterSnapshot: vi.fn(), saveFilterDraft: vi.fn(), discardFilterDraft: vi.fn() },
}));

const legacyMetadata: ElvantoMetadata = { fetchedAt: '2026-07-28T00:00:00.000Z', categories: [], groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [] };
const filter: BooleanFilterConfigV2 = {
  branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', 'music'] }] }],
  exclusions: [{ dimensionId: 'status', values: ['archived'] }],
};
const metadata: FilterMetadata = { dimensions: [
  { id: 'groups', label: 'Groups', cardinality: 'multi', category: 'People', values: [{ id: 'youth', label: 'Youth', count: 12 }, { id: 'music', label: 'Music', count: 8 }] },
  { id: 'status', label: 'Status', cardinality: 'single', category: 'People', values: [{ id: 'active', label: 'Active', count: 18 }, { id: 'archived', label: 'Archived', count: 2 }] },
] };
const batch: PeopleSyncBatch<BooleanFilterConfigV2> = {
  id: 11, provider: 'elvanto', name: 'Elvanto people', enabled: true, filterSchemaVersion: 2,
  filterConfig: filter, filterRevision: 1, draftFilterSchemaVersion: 2, draftFilterConfig: filter,
  draftFilterBaseRevision: 1, draftFilterUpdatedAt: '2026-07-28T00:00:00.000Z', needsFilterReview: true,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
};
const productionLegacyBatch: PeopleSyncBatch = {
  ...batch,
  filterSchemaVersion: 1,
  filterConfig: { statuses: ['active'], categoryIds: ['members'], groups: { ids: ['youth'], operator: 'all' } },
  draftFilterSchemaVersion: null,
  draftFilterConfig: null,
};
function preview() { return { data: { success: true, matchCount: 12, snapshot: { id: 'snapshot', capturedAt: '2026-07-28T00:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: ['groups', 'status'] }, overlaps: [{ batchId: 7, batchName: 'Youth', count: 3 }], uniqueEnabledPopulationCount: 20, missingDimensionIds: [], warnings: [] } }; }
function renderEditor(current: PeopleSyncBatch | null = batch, onSaved = vi.fn()) { return render(<ElvantoBatchEditor batch={current} metadata={legacyMetadata} gatherings={[{ id: 3, name: 'Sunday gathering' }]} onSaved={onSaved} onCancel={vi.fn()} />); }

describe('ElvantoBatchEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockResolvedValue({ data: { success: true, metadata, snapshot: preview().data.snapshot } });
    vi.mocked(peopleSyncAPI.previewFilter).mockResolvedValue(preview());
  });

  it('renders the same provider-neutral qualification subtree and retains Elvanto controls', async () => {
    renderEditor();

    expect(await screen.findByText('Who qualifies?')).toBeInTheDocument();
    expect(screen.getByText('Qualification rules')).toBeInTheDocument();
    expect(screen.getByText('Match all')).toBeInTheDocument();
    expect(screen.getByLabelText('Always exclude')).toBeInTheDocument();
    expect(await screen.findByText('12 people match')).toBeInTheDocument();
    expect(screen.getByText('3 also match Youth')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh people data' })).toBeInTheDocument();
    expect(screen.getByLabelText('Gathering assignment')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
  });

  it('keeps a production-shaped legacy Elvanto batch read-only when metadata is unavailable', async () => {
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockRejectedValue(new Error('metadata unavailable'));
    renderEditor(productionLegacyBatch);

    expect(await screen.findByText('Who qualifies?')).toBeInTheDocument();
    expect(screen.getByText(/criteria must be upgraded/)).toBeInTheDocument();
    expect(screen.queryByText('Qualification rules')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save batch' })).toBeDisabled();
    expect(screen.getByLabelText('Batch name')).toBeDisabled();
    expect(screen.getByLabelText('Enable this batch')).toBeDisabled();
    expect(screen.getByLabelText('New people from this batch are added as')).toBeDisabled();
    expect(screen.getByLabelText('Gathering assignment')).toBeDisabled();
    expect(screen.getByLabelText('Runs automatically')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(peopleSyncAPI.getFilterMetadata).not.toHaveBeenCalled();
    expect(elvantoSyncAPI.updateBatch).not.toHaveBeenCalled();
    expect(peopleSyncAPI.saveFilterDraft).not.toHaveBeenCalled();
  });

  it('creates exactly one v2 batch carrying the draft and review state', async () => {
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { batch } });
    const onSaved = vi.fn();
    renderEditor(null, onSaved);
    await screen.findByText('Who qualifies?');
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));

    await waitFor(() => expect(elvantoSyncAPI.createBatch).toHaveBeenCalledTimes(1));
    expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(expect.objectContaining({ filterSchemaVersion: 2, draftFilterConfig: expect.objectContaining({ branches: [], exclusions: [] }) }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ needsFilterReview: true }));
  });

  it('does not mutate active filter criteria through the non-filter update', async () => {
    vi.mocked(elvantoSyncAPI.updateBatch).mockResolvedValue({ data: { batch } });
    const latestDraft = { ...batch, draftFilterConfig: null, draftFilterSchemaVersion: null, draftFilterBaseRevision: null, draftFilterUpdatedAt: null, needsFilterReview: false };
    vi.mocked(peopleSyncAPI.saveFilterDraft).mockResolvedValue({ data: { success: true, batch: latestDraft } });
    const onSaved = vi.fn();
    renderEditor(batch, onSaved);
    await screen.findByText('Who qualifies?');
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));

    await waitFor(() => expect(elvantoSyncAPI.updateBatch).toHaveBeenCalledWith(11, expect.not.objectContaining({ filterConfig: expect.anything(), filterSchemaVersion: expect.anything() })));
    expect(peopleSyncAPI.saveFilterDraft).toHaveBeenCalledWith('elvanto', 11, expect.objectContaining({ filterConfig: filter }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(latestDraft));
  });

  it('keeps the editor open with a specific settings error', async () => {
    vi.mocked(elvantoSyncAPI.updateBatch).mockRejectedValue({ response: { data: { error: 'Settings could not be saved.' } } });
    renderEditor();
    await screen.findByText('Who qualifies?');
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be saved.');
    expect(peopleSyncAPI.saveFilterDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save batch' })).toBeInTheDocument();
  });

  it('reuses a newly created gathering when a saved batch needs its filter draft retried', async () => {
    vi.mocked(gatheringsAPI.create).mockResolvedValue({ data: { id: 77 } });
    vi.mocked(elvantoSyncAPI.updateBatch).mockResolvedValue({ data: { batch } });
    vi.mocked(peopleSyncAPI.saveFilterDraft)
      .mockRejectedValueOnce({ response: { data: { error: 'Draft could not be saved.' } } })
      .mockResolvedValueOnce({ data: { success: true, batch } });
    const onSaved = vi.fn();
    renderEditor(batch, onSaved);

    await screen.findByText('Who qualifies?');
    fireEvent.change(screen.getByLabelText('Gathering assignment'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('New gathering name'), { target: { value: 'New gathering' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('The gathering was created and Batch settings were saved, but filter draft was not: Draft could not be saved.'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(gatheringsAPI.create).toHaveBeenCalledTimes(1);
    expect(elvantoSyncAPI.updateBatch).toHaveBeenCalledTimes(2);
    expect(peopleSyncAPI.saveFilterDraft).toHaveBeenCalledTimes(2);
  });
});
