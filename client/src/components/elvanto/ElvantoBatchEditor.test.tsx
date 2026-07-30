import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ElvantoBatchEditor from './ElvantoBatchEditor';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';
import type { PeopleSyncBatch } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  elvantoSyncAPI: { createBatch: vi.fn(), updateBatch: vi.fn() },
  gatheringsAPI: { create: vi.fn() },
  peopleSyncAPI: { saveSourceDraft: vi.fn() },
}));

vi.mock('../peopleSync/BatchSourceControls', () => ({
  default: ({ value, onChange }: { value: { sourceKind: 'elvanto_category'; sourceExternalId: string } | null; onChange: (value: { sourceKind: 'elvanto_category'; sourceExternalId: string }) => void }) => (
    <label>People source<select aria-label="People source" value={value?.sourceExternalId ?? ''} onChange={(event) => onChange({ sourceKind: 'elvanto_category', sourceExternalId: event.target.value })}>
      <option value="">Choose</option><option value="category-1">Members</option><option value="category-2">Visitors</option>
    </select></label>
  ),
}));

const batch = {
  id: 11, provider: 'elvanto', name: 'Elvanto people', enabled: true,
  source: { kind: 'elvanto_category', externalId: 'category-1', name: 'Members', memberCount: 5, providerRefreshedAt: null },
  sourceRevision: 1, draftSource: null, draftSourceBaseRevision: null, draftSourceUpdatedAt: null,
  needsSourceReview: false, initialSourceReviewPending: false, sourceStatus: 'available', sourceStatusCheckedAt: null, sourceStatusErrorCode: null,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
} as PeopleSyncBatch;

function renderEditor(current: PeopleSyncBatch | null = batch, onSaved = vi.fn()) {
  return render(<ElvantoBatchEditor batch={current} gatherings={[]} onSaved={onSaved} onCancel={vi.fn()} />);
}

describe('ElvantoBatchEditor source drafts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one selected Category batch pending review', async () => {
    const created = { ...batch, id: 13, needsSourceReview: true, initialSourceReviewPending: true };
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { batch: created } });
    const saved = vi.fn();
    renderEditor(null, saved);
    expect(screen.queryByLabelText('Batch name')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('People source'), { target: { value: 'category-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));
    await waitFor(() => expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'elvanto_category', sourceExternalId: 'category-1',
    })));
    expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(
      expect.not.objectContaining({ name: expect.anything() }),
    );
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ needsSourceReview: true }));
  });

  it('saves a draft only after the Category identity changes', async () => {
    vi.mocked(elvantoSyncAPI.updateBatch).mockResolvedValue({ data: { batch } });
    vi.mocked(peopleSyncAPI.saveSourceDraft).mockResolvedValue({ data: { batch: { ...batch, needsSourceReview: true } } });
    renderEditor();
    expect(screen.queryByLabelText('Batch name')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('People source'), { target: { value: 'category-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(peopleSyncAPI.saveSourceDraft).toHaveBeenCalledWith('elvanto', 11, {
      sourceKind: 'elvanto_category', sourceExternalId: 'category-2',
    }));
    expect(elvantoSyncAPI.updateBatch).toHaveBeenCalledWith(
      11,
      expect.not.objectContaining({ name: expect.anything() }),
    );
  });

  it('keeps an existing source draft and blocks its schedule', async () => {
    const pending = { ...batch, draftSource: { ...batch.source!, externalId: 'category-2', name: 'Visitors' }, needsSourceReview: true };
    vi.mocked(elvantoSyncAPI.updateBatch).mockResolvedValue({ data: { batch: pending } });
    renderEditor(pending);
    expect(screen.getByLabelText('Runs automatically')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(elvantoSyncAPI.updateBatch).toHaveBeenCalled());
    expect(peopleSyncAPI.saveSourceDraft).not.toHaveBeenCalled();
  });

  it('presents automatic gathering removal as a styled switch with a warning dialog', () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Gathering assignment'), { target: { value: 'new' } });

    const toggle = screen.getByRole('switch', { name: 'Automatically remove people from this gathering' });
    expect(toggle).toHaveClass('relative', 'inline-flex');
    expect(toggle.querySelector('span')).toHaveClass('rounded-full', 'bg-white');

    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Enable automatic removal for this batch?' });
    expect(dialog).toHaveTextContent('People who stop matching this batch will be removed from its gathering.');
    fireEvent.click(screen.getByRole('button', { name: 'Enable automatic removal' }));
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});
