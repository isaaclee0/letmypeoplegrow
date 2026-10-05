import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, integrationsAPI } from '../../services/api';
import type { PeopleSyncBatch } from '../peopleSync/types';
import ProviderManagedPeopleNote from './ProviderManagedPeopleNote';

function batch(overrides: Partial<PeopleSyncBatch> = {}): PeopleSyncBatch {
  return {
    id: 1, provider: 'elvanto', name: 'Members', enabled: true,
    source: { kind: 'elvanto_category', externalId: 'members', name: 'Members', memberCount: null, providerRefreshedAt: null },
    sourceRevision: 1, draftSource: null, draftSourceBaseRevision: null,
    draftSourceUpdatedAt: null, needsSourceReview: false, initialSourceReviewPending: false,
    sourceStatus: 'available', sourceStatusCheckedAt: null, sourceStatusErrorCode: null,
    operationalState: 'active', reviewable: true, runnable: true,
    defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
    scheduleEnabled: true, scheduleFrequency: 'daily', scheduleDay: 1,
    legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('provider-managed people sync guidance', () => {
  it('shows each Elvanto batch cadence, including shorter-month handling', async () => {
    vi.spyOn(elvantoSyncAPI, 'listBatches').mockResolvedValue({ data: { batches: [
      batch(), batch({ id: 2, name: 'Youth', scheduleFrequency: 'weekly', scheduleDay: 0 }),
      batch({ id: 3, name: 'Volunteers', scheduleFrequency: 'monthly', scheduleDay: 31 }),
    ] } } as never);
    render(<ProviderManagedPeopleNote provider="elvanto" syncEnabled />);
    expect(await screen.findByText('Members: daily overnight')).toBeInTheDocument();
    expect(screen.getByText('Youth: weekly on Sunday (overnight)')).toBeInTheDocument();
    expect(screen.getByText('Volunteers: monthly on day 31 (overnight; last day in shorter months)')).toBeInTheDocument();
    expect(screen.getByText(/Make edits or remove people in Elvanto/)).toBeInTheDocument();
  });

  it('explains why disabled, draft, missing-source, and manual-only batches cannot auto-sync', async () => {
    vi.spyOn(integrationsAPI, 'getPlanningCenterSyncBatches').mockResolvedValue({ data: { batches: [
      batch({ enabled: false }),
      batch({ id: 2, name: 'Draft', needsSourceReview: true }),
      batch({ id: 3, name: 'Missing', sourceStatus: 'missing' }),
      batch({ id: 4, name: 'Manual', scheduleEnabled: false }),
    ] } } as never);
    render(<ProviderManagedPeopleNote provider="planning_center" syncEnabled />);
    expect(await screen.findByText('Members: batch disabled')).toBeInTheDocument();
    expect(screen.getByText('Draft: sync blocked until an administrator reviews the source')).toBeInTheDocument();
    expect(screen.getByText('Missing: sync blocked because the source is missing')).toBeInTheDocument();
    expect(screen.getByText('Manual: manual sync only')).toBeInTheDocument();
    expect(screen.queryByText(/daily overnight/)).not.toBeInTheDocument();
  });

  it('does not invent a schedule when the provider request fails', async () => {
    vi.spyOn(elvantoSyncAPI, 'listBatches').mockRejectedValue(new Error('Unavailable'));
    render(<ProviderManagedPeopleNote provider="elvanto" syncEnabled />);
    expect(await screen.findByText(/The sync schedule could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('explains when no batches have been configured', async () => {
    vi.spyOn(elvantoSyncAPI, 'listBatches').mockResolvedValue({ data: { batches: [] } } as never);
    render(<ProviderManagedPeopleNote provider="elvanto" syncEnabled />);
    expect(await screen.findByText(/No sync batches are configured/)).toBeInTheDocument();
  });

  it('warns about overwritten local edits when editing is unlocked', async () => {
    render(<ProviderManagedPeopleNote provider="elvanto" syncEnabled={false} editingLocked={false} />);
    expect(screen.getByText(/Local editing is enabled/)).toBeInTheDocument();
    expect(screen.getByText(/Automatic syncing is paused/)).toBeInTheDocument();
  });
});
