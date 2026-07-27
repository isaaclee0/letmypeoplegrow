import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ElvantoBatchEditor from './ElvantoBatchEditor';
import type { ElvantoMetadata, PeopleSyncBatch } from '../peopleSync/types';
import { elvantoSyncAPI, gatheringsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  elvantoSyncAPI: { createBatch: vi.fn(), updateBatch: vi.fn(), refreshMetadata: vi.fn() },
  gatheringsAPI: { create: vi.fn() },
}));

const metadata: ElvantoMetadata = {
  fetchedAt: '2026-07-25T10:00:00.000Z',
  categories: [],
  groups: [{ id: 'group-youth', name: 'Youth', status: null, memberCount: 12 }],
  demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [],
};

const savedBatch = {
  id: 11, provider: 'elvanto', name: 'Elvanto people', enabled: true, filterSchemaVersion: 1,
  filterConfig: { statuses: ['active', 'contact'], categoryIds: [], groups: { ids: [], operator: 'any' }, demographics: { values: [], operator: 'any' }, departments: { values: [], operator: 'any' }, serviceTypes: { ids: [], operator: 'any' }, locations: { ids: [], operator: 'any' }, customFields: [] },
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
} satisfies PeopleSyncBatch;

function renderEditor(batch: PeopleSyncBatch | null = null, props: Partial<React.ComponentProps<typeof ElvantoBatchEditor>> = {}) {
  return render(<ElvantoBatchEditor batch={batch} metadata={metadata} gatherings={[{ id: 3, name: 'Sunday gathering' }]} onSaved={vi.fn()} onCancel={vi.fn()} {...props} />);
}

describe('ElvantoBatchEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the documented default batch payload', async () => {
    const onSaved = vi.fn();
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { batch: savedBatch } });
    renderEditor(null, { onSaved });

    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));
    await waitFor(() => expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Elvanto people', enabled: true, filterSchemaVersion: 1, defaultPeopleType: 'regular',
      gatheringTypeId: null, gatheringAutoRemoveEnabled: false, scheduleEnabled: false,
      scheduleFrequency: 'weekly', scheduleDay: 1,
      filterConfig: expect.objectContaining({ statuses: ['active', 'contact'] }),
    })));
    expect(onSaved).toHaveBeenCalledWith(savedBatch);
  });

  it('edits an existing batch through the update boundary', async () => {
    vi.mocked(elvantoSyncAPI.updateBatch).mockResolvedValue({ data: { batch: { ...savedBatch, name: 'Youth' } } });
    renderEditor({ ...savedBatch, name: 'Members' });

    fireEvent.change(screen.getByLabelText('Batch name'), { target: { value: 'Youth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));
    await waitFor(() => expect(elvantoSyncAPI.updateBatch).toHaveBeenCalledWith(11, expect.objectContaining({ name: 'Youth' })));
  });

  it('rejects an empty name before calling the API', () => {
    renderEditor({ ...savedBatch, name: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a batch name.');
    expect(elvantoSyncAPI.updateBatch).not.toHaveBeenCalled();
  });

  it('rejects an invalid saved schedule day before calling the API', () => {
    renderEditor({ ...savedBatch, name: 'Monthly', scheduleEnabled: true, scheduleFrequency: 'monthly', scheduleDay: 32 });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a valid schedule day.');
    expect(elvantoSyncAPI.updateBatch).not.toHaveBeenCalled();
  });

  it('creates a gathering before saving the batch', async () => {
    vi.mocked(gatheringsAPI.create).mockResolvedValue({ data: { id: 17 } });
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { batch: savedBatch } });
    renderEditor();

    fireEvent.change(screen.getByLabelText('Gathering assignment'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('New gathering name'), { target: { value: 'Youth night' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));

    await waitFor(() => expect(gatheringsAPI.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Youth night', attendanceType: 'standard' })));
    expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(expect.objectContaining({ gatheringTypeId: 17 }));
  });

  it('asks for confirmation before enabling automatic gathering removal', async () => {
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { batch: savedBatch } });
    renderEditor();

    fireEvent.change(screen.getByLabelText('Gathering assignment'), { target: { value: 'existing' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Automatically remove people from this gathering' }));
    expect(screen.getByText('Enable automatic removal for this batch?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable automatic removal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));

    await waitFor(() => expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(expect.objectContaining({ gatheringAutoRemoveEnabled: true })));
  });

  it('refreshes metadata and previews qualification separately for every status', async () => {
    vi.mocked(elvantoSyncAPI.refreshMetadata).mockResolvedValue({ data: { metadata: { ...metadata, groups: [{ id: 'group-new', name: 'New group', status: null, memberCount: 1 }] } } });
    renderEditor();

    expect(screen.getByText('Active — included')).toBeInTheDocument();
    expect(screen.getByText('Contact — included')).toBeInTheDocument();
    expect(screen.getByText('Archived — excluded')).toBeInTheDocument();
    expect(screen.getByText('Deceased — excluded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh metadata' }));
    expect(await screen.findByLabelText('New group')).toBeInTheDocument();
  });
});
