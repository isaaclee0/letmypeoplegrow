import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peopleSyncAPI } from '../../services/api';
import PeopleSourceControl from './PeopleSourceControl';
import type { PeopleSyncPlan, PeopleSyncReview, PeopleSyncSettings } from './types';

vi.mock('../../services/api', () => ({
  peopleSyncAPI: {
    previewAuthority: vi.fn(),
    applyAuthority: vi.fn(),
    disableAuthority: vi.fn(),
  },
}));

const plan: PeopleSyncPlan = {
  provider: 'elvanto',
  authoritative: true,
  snapshot: { fetchedAt: '2026-07-25T09:00:00.000Z', mode: 'full' },
  linkPeople: [{ id: 'link:1', externalPersonId: 'e-1', individualId: 1, reason: 'Matched', reviewRequired: false }],
  linkFamilies: [],
  addPeople: [
    { id: 'add:2', externalPersonId: 'e-2', firstName: 'Ada', lastName: 'Lovelace', isChild: false, familyId: null, peopleType: 'regular', reason: 'New', reviewRequired: true },
    { id: 'add:3', externalPersonId: 'e-3', firstName: 'Grace', lastName: 'Hopper', isChild: false, familyId: null, peopleType: 'regular', reason: 'New', reviewRequired: true },
  ],
  addFamilies: [],
  updateManagedFields: [
    { id: 'update:4', externalPersonId: 'e-4', individualId: 4, changes: [{ field: 'firstName', localValue: 'A', externalValue: 'B' }], reason: 'Changed', reviewRequired: false },
    { id: 'update:5', externalPersonId: 'e-5', individualId: 5, changes: [{ field: 'lastName', localValue: 'A', externalValue: 'B' }], reason: 'Changed', reviewRequired: false },
    { id: 'update:6', externalPersonId: 'e-6', individualId: 6, changes: [{ field: 'isChild', localValue: false, externalValue: true }], reason: 'Changed', reviewRequired: false },
  ],
  promoteToRegular: [],
  demoteToLocalVisitor: [],
  archive: [],
  reactivate: [{ id: 'restore:7', externalPersonId: 'e-7', individualId: 7, reason: 'Returned' }],
  moveFamily: [],
  renameFamily: [],
  addToGathering: [],
  removeFromGathering: [],
  ambiguousPeople: [],
  familyConflicts: [],
  unmatchedLocalRegulars: [],
  skipped: [],
};

const review: PeopleSyncReview = {
  runId: 10,
  reviewToken: 'authority-review',
  plan,
  snapshot: plan.snapshot,
  summary: {
    linkPeople: 1, linkFamilies: 0, addPeople: 2, addFamilies: 0, updateManagedFields: 3,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 1,
    moveFamily: 0, renameFamily: 0, addToGathering: 0, removeFromGathering: 0,
    ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
  authority: { active: 'planning_center', pending: 'elvanto' },
};

const initialSettings: PeopleSyncSettings = {
  authorityProvider: 'planning_center',
  pendingAuthorityProvider: null,
  elvantoIncludeContacts: true,
  elvantoAlignPeopleType: true,
  fullReconciliationFrequency: 'weekly',
  fullReconciliationDay: 1,
};

function Harness({ connections = { planning_center: true, elvanto: true } }: {
  connections?: { planning_center: boolean; elvanto: boolean };
}) {
  const [settings, setSettings] = useState(initialSettings);
  return (
    <PeopleSourceControl
      settings={settings}
      connections={connections}
      onRefresh={async () => {
        setSettings((current) => ({
          ...current,
          authorityProvider: vi.mocked(peopleSyncAPI.disableAuthority).mock.calls.length > 0 ? 'none' : 'elvanto',
          pendingAuthorityProvider: null,
        }));
      }}
    />
  );
}

describe('PeopleSourceControl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers None and both connected providers without directly updating settings', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    render(<Harness />);

    expect(screen.getByRole('radio', { name: 'None' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Planning Center' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Elvanto' }));

    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));
    expect(screen.getByRole('radio', { name: 'Planning Center' })).toBeChecked();
  });

  it('renders preview coverage and change counts, then changes authority only after reviewed apply succeeds', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 10, status: 'applied', applied: {} as never, summary: review.summary },
    });
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Elvanto' }));
    expect(await screen.findByText('Coverage: 1 linked')).toBeInTheDocument();
    expect(screen.getByText('5 locked after apply')).toBeInTheDocument();
    expect(screen.getByText('2 adds')).toBeInTheDocument();
    expect(screen.getByText('3 updates')).toBeInTheDocument();
    expect(screen.getByText('1 restore')).toBeInTheDocument();
    expect(screen.getByText('0 archives')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Planning Center' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));
    await waitFor(() => expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledWith('elvanto', 'authority-review', expect.any(Object)));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Elvanto' })).toBeChecked());
  });

  it('cancels a preview without changing the active authority', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Elvanto' }));
    await screen.findByText('Elvanto sync review');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    expect(screen.queryByText('Elvanto sync review')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Planning Center' })).toBeChecked();
    expect(peopleSyncAPI.applyAuthority).not.toHaveBeenCalled();
  });

  it('requires confirmation before disabling authority', async () => {
    vi.mocked(peopleSyncAPI.disableAuthority).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect(screen.getByText('Stop using a people source of truth?')).toBeInTheDocument();
    expect(peopleSyncAPI.disableAuthority).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use no people source' }));

    await waitFor(() => expect(peopleSyncAPI.disableAuthority).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'None' })).toBeChecked());
  });

  it('disables disconnected providers and explains why', () => {
    render(<Harness connections={{ planning_center: true, elvanto: false }} />);

    expect(screen.getByRole('radio', { name: 'Elvanto' })).toBeDisabled();
    expect(screen.getByText('Connect Elvanto before selecting it as your people source.')).toBeInTheDocument();
  });

  it('keeps a partial-success authority commit failure visible and does not claim the provider changed', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: {
        success: true,
        runId: 10,
        status: 'applied',
        applied: {} as never,
        summary: review.summary,
        authorityCommitError: 'The people changes were applied, but Elvanto could not be made authoritative.',
      },
    });
    const onRefresh = vi.fn();
    render(<PeopleSourceControl settings={initialSettings} connections={{ planning_center: true, elvanto: true }} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Elvanto' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply sync' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('people changes were applied');
    expect(screen.getByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Planning Center' })).toBeChecked();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
