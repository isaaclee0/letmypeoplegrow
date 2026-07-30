import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanningCenterBatchEditor from './PlanningCenterBatchEditor';
import { gatheringsAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import type { PeopleSyncBatch } from '../peopleSync/types';

vi.mock('../../services/api', () => ({ gatheringsAPI: { getAll: vi.fn(), create: vi.fn() }, integrationsAPI: { createPlanningCenterSyncBatch: vi.fn(), updatePlanningCenterSyncBatch: vi.fn() }, peopleSyncAPI: { saveSourceDraft: vi.fn() } }));
vi.mock('../peopleSync/BatchSourceControls', () => ({ default: ({ value, onChange }: { value: { sourceKind: 'planning_center_list'; sourceExternalId: string } | null; onChange: (value: { sourceKind: 'planning_center_list'; sourceExternalId: string }) => void }) => <label>People source<select aria-label="People source" value={value?.sourceExternalId ?? ''} onChange={e => onChange({ sourceKind: 'planning_center_list', sourceExternalId: e.target.value })}><option value="">Choose</option><option value="list-1">Members</option><option value="list-2">New members</option></select></label> }));

const batch = { id: 4, provider: 'planning_center', name: 'Members', enabled: true, source: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members', memberCount: 10, providerRefreshedAt: null }, sourceRevision: 2, draftSource: null, draftSourceBaseRevision: null, draftSourceUpdatedAt: null, needsSourceReview: false, initialSourceReviewPending: false, sourceStatus: 'available', sourceStatusCheckedAt: null, sourceStatusErrorCode: null, defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false, scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1, legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null } as PeopleSyncBatch;
function renderEditor(current: PeopleSyncBatch | null = batch, onSaved = vi.fn()) { return render(<PlanningCenterBatchEditor batch={current} onSaved={onSaved} onCancel={vi.fn()} />); }
describe('PlanningCenterBatchEditor', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: [] }); });
  it('creates from one selected List and leaves the batch pending review', async () => {
    const created = { ...batch, id: 8, source: { ...batch.source!, externalId: 'list-2', name: 'New members' }, needsSourceReview: true, initialSourceReviewPending: true };
    vi.mocked(integrationsAPI.createPlanningCenterSyncBatch).mockResolvedValue({ data: { batch: created } }); const saved = vi.fn(); renderEditor(null, saved);
    expect(screen.queryByLabelText('Batch name')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('People source'), { target: { value: 'list-2' } }); fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));
    await waitFor(() => expect(integrationsAPI.createPlanningCenterSyncBatch).toHaveBeenCalledWith({ sourceKind: 'planning_center_list', sourceExternalId: 'list-2', defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false, scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1 }));
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ needsSourceReview: true }));
  });
  it('saves settings without a source draft when the source identity is unchanged', async () => {
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockResolvedValue({ data: { batch } }); const saved = vi.fn(); renderEditor(batch, saved); fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(integrationsAPI.updatePlanningCenterSyncBatch).toHaveBeenCalledWith(4, { defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false, scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1 })); expect(peopleSyncAPI.saveSourceDraft).not.toHaveBeenCalled(); expect(saved).toHaveBeenCalledWith(batch);
  });
  it('saves a source draft only when source identity changes', async () => {
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockResolvedValue({ data: { batch } }); vi.mocked(peopleSyncAPI.saveSourceDraft).mockResolvedValue({ data: { batch: { ...batch, needsSourceReview: true } } }); renderEditor(); fireEvent.change(screen.getByLabelText('People source'), { target: { value: 'list-2' } }); fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(peopleSyncAPI.saveSourceDraft).toHaveBeenCalledWith('planning_center', 4, { sourceKind: 'planning_center_list', sourceExternalId: 'list-2' }));
  });
  it('does not resubmit an existing source draft when saving unrelated settings', async () => {
    const pending = { ...batch, draftSource: { ...batch.source!, externalId: 'list-2', name: 'New members' }, needsSourceReview: true };
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockResolvedValue({ data: { batch: pending } });
    renderEditor(pending); fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(integrationsAPI.updatePlanningCenterSyncBatch).toHaveBeenCalled());
    expect(peopleSyncAPI.saveSourceDraft).not.toHaveBeenCalled();
  });
  it('blocks schedule changes while a source review is pending', async () => {
    renderEditor({ ...batch, draftSource: { ...batch.source!, externalId: 'list-2' }, needsSourceReview: true });
    await waitFor(() => expect(gatheringsAPI.getAll).toHaveBeenCalled());
    expect(screen.getByLabelText('Runs automatically')).toBeDisabled();
    expect(screen.getByText('Scheduled runs are blocked until you complete a full review.')).toBeInTheDocument();
  });
  it('makes the partial-save boundary clear if the source draft fails', async () => {
    vi.mocked(integrationsAPI.updatePlanningCenterSyncBatch).mockResolvedValue({ data: { batch } }); vi.mocked(peopleSyncAPI.saveSourceDraft).mockRejectedValue({ response: { data: { error: 'Source unavailable.' } } }); renderEditor(); fireEvent.change(screen.getByLabelText('People source'), { target: { value: 'list-2' } }); fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Batch settings were saved, but people source draft was not: Source unavailable.');
  });
});
