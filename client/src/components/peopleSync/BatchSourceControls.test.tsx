import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peopleSyncAPI } from '../../services/api';
import BatchSourceControls from './BatchSourceControls';
import type { PeopleSyncBatch, ProviderSource, SourceSelection } from './types';

vi.mock('../../services/api', () => ({ peopleSyncAPI: { listSources: vi.fn(), discardSourceDraft: vi.fn() } }));

const source = (overrides: Partial<ProviderSource> = {}): ProviderSource => ({
  kind: 'planning_center_list', externalId: 'list-1', name: 'Sunday members', memberCount: 23,
  providerRefreshedAt: '2026-07-28T12:00:00.000Z', ...overrides,
});

const batch = (overrides: Partial<PeopleSyncBatch> = {}): PeopleSyncBatch => ({
  id: 4, provider: 'planning_center', name: 'Members', enabled: true,
  source: source(), sourceRevision: 2, draftSource: null, draftSourceBaseRevision: null,
  draftSourceUpdatedAt: null, needsSourceReview: false, initialSourceReviewPending: false,
  sourceStatus: 'available', sourceStatusCheckedAt: null, sourceStatusErrorCode: null,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
  ...overrides,
});

function Controlled({ provider = 'planning_center', initial = { sourceKind: 'planning_center_list', sourceExternalId: 'list-1' } as SourceSelection, currentBatch = null }: {
  provider?: 'planning_center' | 'elvanto'; initial?: SourceSelection | null; currentBatch?: PeopleSyncBatch | null;
}) {
  const [value, setValue] = useState<SourceSelection | null>(initial);
  return <><BatchSourceControls provider={provider} batch={currentBatch} value={value} onChange={setValue} onDiscarded={vi.fn()} /><output>{value ? `${value.sourceKind}:${value.sourceExternalId}` : 'none'}</output></>;
}

describe('BatchSourceControls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads visible Planning Center Lists and stores a stable source kind and ID while displaying its name', async () => {
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [source(), source({ externalId: 'list-2', name: 'Youth', memberCount: 8 })] } });
    render(<Controlled />);

    expect(await screen.findByRole('option', { name: 'Sunday members (23 members)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Planning Center List')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Planning Center List'), { target: { value: 'list-2' } });

    expect(screen.getByText('planning_center_list:list-2')).toBeInTheDocument();
    expect(screen.getByText('Youth')).toBeInTheDocument();
  });

  it('offers Elvanto Category and Group controls and clears the selected source when its type changes', async () => {
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [
      source({ kind: 'elvanto_category', externalId: 'category-1', name: 'Members', memberCount: null, providerRefreshedAt: null }),
      source({ kind: 'elvanto_group', externalId: 'group-1', name: 'Youth', memberCount: 8, providerRefreshedAt: null }),
    ] } });
    render(<Controlled provider="elvanto" initial={{ sourceKind: 'elvanto_category', sourceExternalId: 'category-1' }} />);

    await screen.findByRole('option', { name: 'Members' });
    expect(screen.getByLabelText('Category')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Group'));

    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Youth (8 members)' })).toBeInTheDocument();
  });

  it('resyncs the Elvanto source type when its controlled selection changes from Category to Group', async () => {
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [
      source({ kind: 'elvanto_category', externalId: 'category-1', name: 'Members', memberCount: null, providerRefreshedAt: null }),
      source({ kind: 'elvanto_group', externalId: 'group-1', name: 'Youth', memberCount: 8, providerRefreshedAt: null }),
    ] } });
    const { rerender } = render(<BatchSourceControls provider="elvanto" batch={null} value={{ sourceKind: 'elvanto_category', sourceExternalId: 'category-1' }} onChange={vi.fn()} onDiscarded={vi.fn()} />);

    await screen.findByRole('option', { name: 'Members' });
    rerender(<BatchSourceControls provider="elvanto" batch={null} value={{ sourceKind: 'elvanto_group', sourceExternalId: 'group-1' }} onChange={vi.fn()} onDiscarded={vi.fn()} />);

    expect(screen.getByLabelText('Group')).toBeChecked();
    expect(screen.getByRole('option', { name: 'Youth (8 members)' })).toBeInTheDocument();
  });

  it('shows active and pending source names, and discards only a non-initial draft', async () => {
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [source()] } });
    vi.mocked(peopleSyncAPI.discardSourceDraft).mockResolvedValue({ data: { success: true, batch: {
      ...batch(), draftSource: null, draftSourceBaseRevision: null, draftSourceUpdatedAt: null, needsSourceReview: false,
    } } });
    const onDiscarded = vi.fn();
    const pending = source({ externalId: 'list-2', name: 'New members' });
    const { rerender } = render(<BatchSourceControls provider="planning_center" batch={batch({ draftSource: pending, draftSourceBaseRevision: 2, draftSourceUpdatedAt: '2026-07-29T12:00:00.000Z', needsSourceReview: true })} value={{ sourceKind: pending.kind, sourceExternalId: pending.externalId }} onChange={vi.fn()} onDiscarded={onDiscarded} />);

    expect(await screen.findByText('Active source: Sunday members')).toBeInTheDocument();
    expect(screen.getByText('Pending source: New members')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard source draft' }));
    await waitFor(() => expect(peopleSyncAPI.discardSourceDraft).toHaveBeenCalledWith('planning_center', 4));
    expect(onDiscarded).toHaveBeenCalledTimes(1);

    rerender(<BatchSourceControls provider="planning_center" batch={batch({ source: null, draftSource: pending, initialSourceReviewPending: true, needsSourceReview: true })} value={{ sourceKind: pending.kind, sourceExternalId: pending.externalId }} onChange={vi.fn()} onDiscarded={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Discard source draft' })).not.toBeInTheDocument();
  });

  it('retains the last-known selected name and marks it missing when enumeration no longer contains it', async () => {
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [] } });
    render(<BatchSourceControls provider="planning_center" batch={batch({ sourceStatus: 'missing' })} value={{ sourceKind: 'planning_center_list', sourceExternalId: 'list-1' }} onChange={vi.fn()} onDiscarded={vi.fn()} />);

    expect(await screen.findByText('Sunday members')).toBeInTheDocument();
    expect(screen.getByText('Source missing')).toBeInTheDocument();
  });

  it('shows a source check error and its safe code distinctly from a missing source', async () => {
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [source()] } });
    render(<Controlled currentBatch={batch({ sourceStatus: 'error', sourceStatusErrorCode: 'SYNC_SOURCE_RATE_LIMIT' })} />);

    expect(await screen.findByText('Source check failed · SYNC_SOURCE_RATE_LIMIT')).toBeInTheDocument();
    expect(screen.queryByText('Source missing')).not.toBeInTheDocument();
  });

  it.each([
    ['green', 1],
    ['orange', 8],
    ['red', 31],
    ['unknown', null],
  ] as const)('shows Planning Center %s freshness as text and colour without a refresh action', async (band, ageInDays) => {
    const providerRefreshedAt = ageInDays === null ? null : new Date(Date.now() - ageInDays * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [source({ providerRefreshedAt })] } });
    render(<Controlled />);

    const freshness = await screen.findByTestId('planning-center-freshness');
    expect(freshness).toHaveClass(`source-freshness-${band}`);
    if (providerRefreshedAt) expect(freshness).toHaveAttribute('title', expect.stringContaining(new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
    }).format(new Date(providerRefreshedAt))));
    expect(screen.getByText('If recent members are missing, refresh this List in Planning Center.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh|run/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  it('shows Elvanto health from LMPG source-status checks without a warning banner or confirmation checkbox', async () => {
    vi.mocked(peopleSyncAPI.listSources).mockResolvedValue({ data: { success: true, sources: [source({ kind: 'elvanto_category', externalId: 'category-1', name: 'Members', providerRefreshedAt: null })] } });
    const checkedAt = '2026-07-29T12:00:00.000Z';
    render(<Controlled provider="elvanto" initial={{ sourceKind: 'elvanto_category', sourceExternalId: 'category-1' }} currentBatch={batch({ provider: 'elvanto', source: source({ kind: 'elvanto_category', externalId: 'category-1', name: 'Members' }), sourceStatusCheckedAt: checkedAt })} />);

    expect(await screen.findByText(`Last checked by LMPG ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
    }).format(new Date(checkedAt))}`)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
