import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peopleSyncAPI } from '../../services/api';
import PeopleSourceControl from './PeopleSourceControl';
import type { PeopleSyncBatch, PeopleSyncPlan, PeopleSyncReview, PeopleSyncSettings, SyncProvider } from './types';

vi.mock('../../services/api', () => ({
  peopleSyncAPI: {
    previewAuthority: vi.fn(),
    cancelAuthorityPreview: vi.fn(),
    applyAuthority: vi.fn(),
    disableAuthority: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

const plan: PeopleSyncPlan = {
  provider: 'elvanto',
  authoritative: true,
  snapshot: { fetchedAt: '2026-07-25T09:00:00.000Z', mode: 'full' },
  people: {
    external: { 'e-1': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } } },
    local: {
      '1': { firstName: 'Alex', lastName: 'Smith', matchEligible: true, family: { state: 'none' } },
      '2': { firstName: 'Alex', lastName: 'Jones', matchEligible: true, family: { state: 'none' } },
    },
  },
  reviewContext: {
    version: 2,
    manualCandidateIndividualIds: [1, 2],
    identities: {
      'e-1': {
        suggestedIndividualId: 1, candidateIndividualIds: [1], excludedIndividualIds: [],
        held: false, canCreate: true,
        createPerson: { firstName: 'Alex', lastName: 'Smith', isChild: false, externalFamilyId: null, peopleType: 'regular' },
      },
    },
  },
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
  decisionContractVersion: 2,
  plan,
  snapshot: plan.snapshot,
  summary: {
    linkPeople: 1, linkFamilies: 0, addPeople: 2, addFamilies: 0, updateManagedFields: 3,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 1,
    moveFamily: 0, renameFamily: 0, addToGathering: 0, removeFromGathering: 0,
    ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
  authority: { active: 'planning_center', pending: 'elvanto' },
  authorityPreviewId: 'authority-preview-1',
};

const initialSettings: PeopleSyncSettings = {
  authorityProvider: 'planning_center',
  pendingAuthorityProvider: null,
  syncEnabled: true,
  peopleEditingLocked: true,
  elvantoIncludeContacts: true,
  elvantoAlignPeopleType: true,
  fullReconciliationFrequency: 'weekly',
  fullReconciliationDay: 1,
};

const enabledPreparedBatch = {
  id: 20,
  provider: 'elvanto',
  name: 'Sunday service',
  enabled: true,
  source: { kind: 'elvanto_category', externalId: 'members', name: 'Members', memberCount: 30, providerRefreshedAt: null },
  sourceRevision: 1,
  draftSource: null,
  draftSourceBaseRevision: null,
  draftSourceUpdatedAt: null,
  needsSourceReview: false,
  initialSourceReviewPending: false,
  sourceStatus: 'available',
  sourceStatusCheckedAt: null,
  sourceStatusErrorCode: null,
  operationalState: 'prepared',
  reviewable: false,
  runnable: false,
  defaultPeopleType: 'regular',
  gatheringTypeId: null,
  gatheringAutoRemoveEnabled: false,
  scheduleEnabled: true,
  scheduleFrequency: 'weekly',
  scheduleDay: 0,
  legacyProviderBatchId: null,
  lastExternalWatermark: null,
  lastSyncAt: null,
  lastSyncResult: null,
} as PeopleSyncBatch;

function Harness({
  provider = 'elvanto',
  batches = [enabledPreparedBatch],
  connections = { planning_center: true, elvanto: true },
  initialAuthority = 'planning_center',
}: {
  provider?: SyncProvider;
  batches?: PeopleSyncBatch[];
  connections?: Record<SyncProvider, boolean>;
  initialAuthority?: PeopleSyncSettings['authorityProvider'];
}) {
  const [settings, setSettings] = useState<PeopleSyncSettings>({
    ...initialSettings,
    authorityProvider: initialAuthority,
  });
  return (
    <PeopleSourceControl
      provider={provider}
      batches={batches}
      settings={settings}
      connections={connections}
      onRefresh={async () => {
        setSettings((current) => ({
          ...current,
          authorityProvider: vi.mocked(peopleSyncAPI.disableAuthority).mock.calls.length > 0 ? 'none' : provider,
          pendingAuthorityProvider: null,
        }));
      }}
    />
  );
}

describe('PeopleSourceControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(peopleSyncAPI.updateSettings).mockResolvedValue({ data: { success: true, settings: initialSettings } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
  });

  it('reflects only the persisted authority in its checked state', () => {
    render(<Harness provider="elvanto" initialAuthority="elvanto" />);

    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).toBeChecked();
  });

  it('previews directly from no authority without optimistically checking the switch', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    render(<Harness initialAuthority="none" />);

    const toggle = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    fireEvent.click(toggle);

    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));
    expect(toggle).not.toBeChecked();
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
  });

  it('cancels a provider-switch warning without making an API call', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));

    expect(screen.getByText('Switch people management from Planning Center to Elvanto?')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Switch people management from Planning Center to Elvanto?' });
    expect(dialog).toHaveTextContent('Elvanto will manage people after the review is applied.');
    expect(dialog).toHaveTextContent('Planning Center remains connected, but its batches become inactive.');
    expect(dialog).toHaveTextContent('1 enabled Elvanto batch will be activated by this review.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
    expect(screen.queryByText('Switch people management from Planning Center to Elvanto?')).not.toBeInTheDocument();
  });

  it('moves focus into the switch warning, traps Tab, and restores focus after Escape', async () => {
    render(<Harness />);

    const toggle = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Switch people management from Planning Center to Elvanto?' });
    const continueButton = screen.getByRole('button', { name: 'Continue to review' });
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });

    await waitFor(() => expect(continueButton).toHaveFocus());
    cancelButton.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(continueButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(toggle).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('continues from a provider-switch warning to review without checking the switch', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    render(<Harness />);

    const toggle = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));

    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));
    expect(await screen.findByText('Coverage: 1 linked')).toBeInTheDocument();
    expect(screen.getByText('5 locked after apply')).toBeInTheDocument();
    expect(screen.getByText('2 adds')).toBeInTheDocument();
    expect(screen.getByText('3 updates')).toBeInTheDocument();
    expect(screen.getByText('1 restore')).toBeInTheDocument();
    expect(screen.getByText('0 archives')).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it('moves focus from Continue to review progress and then the completed review', async () => {
    let resolvePreview: ((value: { data: { success: true } & PeopleSyncReview }) => void) | undefined;
    vi.mocked(peopleSyncAPI.previewAuthority).mockImplementation(() => new Promise((resolve) => {
      resolvePreview = resolve;
    }));
    render(<Harness />);

    const toggle = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));

    const progress = await screen.findByRole('status');
    await waitFor(() => expect(progress).toHaveFocus());
    expect(toggle).not.toHaveFocus();
    resolvePreview?.({ data: { success: true, ...review } });

    const reviewRegion = await screen.findByRole('region', { name: 'Elvanto authority review' });
    await waitFor(() => expect(reviewRegion).toHaveFocus());
  });

  it('checks the switch only after the reviewed authority change applies and refreshes', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 10, status: 'applied', applied: {} as never, summary: review.summary },
    });
    render(<Harness />);

    const toggle = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    expect(await screen.findByRole('region', { name: 'Elvanto authority review' })).toHaveClass(
      'rounded-lg', 'border', 'bg-gray-50/50', 'p-4', 'dark:bg-gray-900/20',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Alex Jones' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    await waitFor(() => expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledWith('elvanto', 'authority-review', {
      decisionContractVersion: 2,
      identityDecisions: { 'e-1': { outcome: 'link', individualId: 2 } },
      acceptArchiveIndividualIds: [],
      acceptFamilyRenameIds: [],
    }));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('prevents duplicate apply after success, safely retries only status refresh, and closes the review', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 10, status: 'applied', applied: {} as never, summary: review.summary },
    });
    const onRefresh = vi.fn()
      .mockRejectedValueOnce({
        response: { data: { error: 'Authority status could not be refreshed.' } },
        message: 'Request failed',
      })
      .mockResolvedValueOnce(undefined);
    render(
      <PeopleSourceControl
        provider="elvanto"
        batches={[enabledPreparedBatch]}
        settings={initialSettings}
        connections={{ planning_center: true, elvanto: true }}
        onRefresh={onRefresh}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The authority change was applied, but its status could not be refreshed: Authority status could not be refreshed.',
    );
    expect(screen.queryByRole('button', { name: /^Apply \d+ selected changes?$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry status refresh' })).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('region', { name: 'Elvanto authority review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry status refresh' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Elvanto sync review')).not.toBeInTheDocument());
  });

  it('clears stale post-apply refresh state when persisted authority catches up externally', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 10, status: 'applied', applied: {} as never, summary: review.summary },
    });
    const onRefresh = vi.fn().mockRejectedValue({
      response: { data: { error: 'Authority status could not be refreshed.' } },
    });
    const { rerender } = render(
      <PeopleSourceControl
        provider="elvanto"
        batches={[enabledPreparedBatch]}
        settings={initialSettings}
        connections={{ planning_center: true, elvanto: true }}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));
    expect(await screen.findByRole('button', { name: 'Retry status refresh' })).toBeInTheDocument();

    rerender(
      <PeopleSourceControl
        provider="elvanto"
        batches={[enabledPreparedBatch]}
        settings={{ ...initialSettings, authorityProvider: 'elvanto' }}
        connections={{ planning_center: true, elvanto: true }}
        onRefresh={onRefresh}
      />,
    );

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry status refresh' })).not.toBeInTheDocument());
    expect(screen.queryByText('Elvanto sync review')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).toBeChecked();
  });

  it('shows the curated server error when applying the authority review fails', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockRejectedValue({
      response: { data: { error: 'The review expired; refresh the plan.' } },
      message: 'Request failed with status code 409',
    });
    render(<Harness />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The review expired; refresh the plan.');
    expect(screen.queryByText(/Request failed with status code 409/i)).not.toBeInTheDocument();
  });

  it('preserves the stale-review code so the failed apply offers plan refresh', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockRejectedValue({
      response: { data: { code: 'STALE_REVIEW', error: 'The review expired; refresh the plan.' } },
      message: 'Request failed with status code 409',
    });
    render(<Harness />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    const applyError = await screen.findByRole('alert');
    expect(within(applyError).getByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();
  });

  it('preserves nested expired-review details through the authority wrapper', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockRejectedValue(Object.assign(
      new Error('Request failed with status code 409'),
      {
        code: 'ERR_BAD_REQUEST',
        response: {
          data: {
            code: 'SYNC_REVIEW_EXPIRED',
            message: 'This authority review expired on the server.',
          },
        },
      },
    ));
    render(<Harness />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    const applyError = await screen.findByRole('alert');
    expect(applyError).toHaveTextContent('This review has expired.');
    expect(applyError).toHaveTextContent('This authority review expired on the server.');
    expect(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));
    expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledTimes(1);
  });

  it('reverses provider names when switching from Elvanto to Planning Center', () => {
    render(<Harness provider="planning_center" initialAuthority="elvanto" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Planning Center as source of truth' }));

    expect(screen.getByText('Switch people management from Elvanto to Planning Center?')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Elvanto remains connected, but its batches become inactive.',
    );
  });

  it('cancels an authority review without changing persisted state', async () => {
    let resolveCancel!: (value: { data: { success: true; authority: { active: 'none'; pending: null } } }) => void;
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockImplementation(() => new Promise((resolve) => { resolveCancel = resolve; }));
    render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    await screen.findByText('Elvanto sync review');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
    expect(screen.getByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel authority change' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ })).toBeDisabled();

    await act(async () => resolveCancel({ data: { success: true, authority: { active: 'none', pending: null } } }));
    expect(screen.queryByText('Elvanto sync review')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).not.toBeChecked();
    expect(peopleSyncAPI.applyAuthority).not.toHaveBeenCalled();
  });

  it('restores an actionable review after bounded exact cancellation fails and can recover', async () => {
    const terminalFailure = {
      response: { status: 403, data: { error: 'The cancellation could not be confirmed.' } },
    };
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockRejectedValueOnce(terminalFailure)
      .mockResolvedValueOnce({ data: { success: true, authority: { active: 'none', pending: null } } });
    render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The cancellation could not be confirmed.');
    expect(screen.getByRole('button', { name: 'Cancel authority change' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Elvanto sync review')).not.toBeInTheDocument();
  });

  it('exact-cancels an accepted authority preview when the control unmounts', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    const { unmount } = render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();

    unmount();

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('retries the same exact owned preview after unmount cancellation fails', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReset();
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockRejectedValueOnce(new Error('temporary cancellation outage'))
      .mockResolvedValueOnce({ data: { success: true, authority: { active: 'none', pending: null } } });
    const { unmount } = render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    unmount();

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mock.calls).toEqual([
      ['elvanto', 'authority-preview-1'],
      ['elvanto', 'authority-preview-1'],
    ]);
  });

  it('keeps retrying an explicit exact cancel after unmount without restoring its old generation', async () => {
    let rejectFirstCancel!: (error: Error) => void;
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReset();
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirstCancel = reject; }))
      .mockResolvedValueOnce({ data: { success: true, authority: { active: 'none', pending: null } } });
    const { unmount } = render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => rejectFirstCancel(new Error('temporary cancellation outage')));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mock.calls).toEqual([
      ['elvanto', 'authority-preview-1'],
      ['elvanto', 'authority-preview-1'],
    ]);
  });

  it('exact-cancels a preview that resolves after the control unmounts', async () => {
    let resolvePreview!: (value: { data: { success: true } & PeopleSyncReview }) => void;
    vi.mocked(peopleSyncAPI.previewAuthority).mockImplementation(() => new Promise((resolve) => {
      resolvePreview = resolve;
    }));
    const { unmount } = render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));
    unmount();
    await act(async () => resolvePreview({
      data: {
        ...review,
        success: true,
        authorityPreviewId: 'authority-preview-after-unmount',
      },
    }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-after-unmount',
    ));
  });

  it('disables review actions while refreshing and cannot apply the old review', async () => {
    let resolveRefresh!: (value: { data: { success: true } & PeopleSyncReview }) => void;
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));

    expect(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel authority change' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));
    expect(peopleSyncAPI.applyAuthority).not.toHaveBeenCalled();

    await act(async () => resolveRefresh({
      data: { ...review, success: true, reviewToken: 'refreshed-review', authorityPreviewId: 'authority-preview-2' },
    }));
    expect(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ })).toBeEnabled();
  });

  it('never re-enables the old review when a refresh fails after its intent may have changed', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockRejectedValueOnce(new Error('refresh failed'));
    render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('refresh failed');
    expect(screen.queryByText('Elvanto sync review')).not.toBeInTheDocument();
    expect(peopleSyncAPI.applyAuthority).not.toHaveBeenCalled();
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('keeps the newest review when an older preview response arrives late', async () => {
    let resolveOlder!: (value: { data: { success: true } & PeopleSyncReview }) => void;
    let resolveNewest!: (value: { data: { success: true } & PeopleSyncReview }) => void;
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewest = resolve; }));
    render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    const refreshButton = screen.getByRole('button', { name: 'Refresh plan' });
    act(() => {
      refreshButton.click();
      refreshButton.click();
    });
    expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledTimes(3);

    const newestPlan = {
      ...review.plan,
      people: {
        ...review.plan.people!,
        external: {
          ...review.plan.people!.external,
          'e-1': { ...review.plan.people!.external['e-1'], firstName: 'Newest' },
        },
      },
    };
    await act(async () => resolveNewest({
      data: {
        ...review,
        success: true,
        reviewToken: 'newest-review',
        authorityPreviewId: 'authority-preview-newest',
        plan: newestPlan,
      },
    }));
    expect(screen.getAllByText('Newest Smith').length).toBeGreaterThan(0);

    const olderPlan = {
      ...review.plan,
      people: {
        ...review.plan.people!,
        external: {
          ...review.plan.people!.external,
          'e-1': { ...review.plan.people!.external['e-1'], firstName: 'Older' },
        },
      },
    };
    await act(async () => resolveOlder({
      data: {
        ...review,
        success: true,
        reviewToken: 'older-review',
        authorityPreviewId: 'authority-preview-older',
        plan: olderPlan,
      },
    }));
    expect(screen.queryAllByText('Older Smith')).toHaveLength(0);
    expect(screen.getAllByText('Newest Smith').length).toBeGreaterThan(0);
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-older',
    ));
  });

  it('requires every planned Planning Center archive to be accepted before authority apply', async () => {
    const planningCenterPlan: PeopleSyncPlan = {
      ...plan,
      provider: 'planning_center',
      people: {
        ...plan.people!,
        local: {
          ...plan.people!.local,
          '8': { firstName: 'Taylor', lastName: 'Reed', matchEligible: true, family: { state: 'none' } },
        },
      },
      archive: [{
        id: 'archive:missing:8',
        externalPersonId: 'missing-person',
        individualId: 8,
        reason: 'provider_state_archived',
      }],
    };
    const planningCenterReview: PeopleSyncReview = {
      ...review,
      authority: { active: 'none', pending: 'planning_center' },
      authorityPreviewId: 'planning-center-preview',
      plan: planningCenterPlan,
      summary: { ...review.summary, archive: 1 },
    };
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...planningCenterReview } });
    render(<Harness provider="planning_center" initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Planning Center as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Planning Center authority review' })).toBeInTheDocument();

    const apply = screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ });
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that this sync will archive people/ }));
    expect(apply).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Archive Taylor Reed' }));
    expect(apply).toBeEnabled();
  });

  it('dismisses a mixed-rollout review locally without an unscoped cancel request', async () => {
    const { authorityPreviewId: _authorityPreviewId, ...reviewWithoutIntent } = review;
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...reviewWithoutIntent } });
    render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    expect(screen.queryByText('Elvanto sync review')).not.toBeInTheDocument();
    expect(peopleSyncAPI.cancelAuthorityPreview).not.toHaveBeenCalled();
  });

  it('confirms before disabling the active provider and refreshes persisted state', async () => {
    render(<Harness provider="planning_center" />);

    const toggle = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    fireEvent.click(toggle);
    expect(screen.getByText('Pause people sync?')).toBeInTheDocument();
    expect(peopleSyncAPI.updateSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause sync' }));

    await waitFor(() => expect(peopleSyncAPI.updateSettings).toHaveBeenCalledWith({ syncEnabled: false }));
    expect(toggle).toBeChecked();
  });

  it('moves focus into the disable dialog and restores it after Escape', async () => {
    render(<Harness provider="planning_center" />);

    const toggle = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Pause people sync?' });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause sync' })).toHaveFocus());
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(toggle).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(peopleSyncAPI.updateSettings).not.toHaveBeenCalled();
  });

  it('does not repeat a successful disable when status refresh fails and can retry refresh safely', async () => {
    vi.mocked(peopleSyncAPI.disableAuthority).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    const onRefresh = vi.fn()
      .mockRejectedValueOnce({
        response: { data: { error: 'Authority status is temporarily unavailable.' } },
        message: 'Request failed',
      })
      .mockResolvedValueOnce(undefined);
    render(
      <PeopleSourceControl
        provider="planning_center"
        batches={[enabledPreparedBatch]}
        settings={initialSettings}
        connections={{ planning_center: true, elvanto: true }}
        onRefresh={onRefresh}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Pause sync' }));

    const dialog = await screen.findByRole('dialog', { name: 'Pause people sync?' });
    expect(dialog).toHaveTextContent(
      'The people source was disabled, but its status could not be refreshed: Authority status is temporarily unavailable.',
    );
    expect(toggle).toBeChecked();
    expect(peopleSyncAPI.updateSettings).toHaveBeenCalledWith({ syncEnabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry status refresh' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(peopleSyncAPI.updateSettings).toHaveBeenCalledWith({ syncEnabled: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('resets stale disable retry state after persisted authority moves away and later returns', async () => {
    vi.mocked(peopleSyncAPI.disableAuthority).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    const onRefresh = vi.fn().mockRejectedValue({
      response: { data: { error: 'Authority status is temporarily unavailable.' } },
    });
    const activeSettings = { ...initialSettings, authorityProvider: 'planning_center' as const };
    const { rerender } = render(
      <PeopleSourceControl
        provider="planning_center"
        batches={[enabledPreparedBatch]}
        settings={activeSettings}
        connections={{ planning_center: true, elvanto: true }}
        onRefresh={onRefresh}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Pause sync' }));
    expect(await screen.findByRole('button', { name: 'Retry status refresh' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    rerender(
      <PeopleSourceControl
        provider="planning_center"
        batches={[enabledPreparedBatch]}
        settings={{ ...initialSettings, authorityProvider: 'none' }}
        connections={{ planning_center: true, elvanto: true }}
        onRefresh={onRefresh}
      />,
    );
    rerender(
      <PeopleSourceControl
        provider="planning_center"
        batches={[enabledPreparedBatch]}
        settings={activeSettings}
        connections={{ planning_center: true, elvanto: true }}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Use Planning Center as source of truth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause sync' }));

    await waitFor(() => expect(peopleSyncAPI.updateSettings).toHaveBeenCalledTimes(2));
  });

  it('disables a disconnected provider and explains the prerequisite', () => {
    render(<Harness connections={{ planning_center: true, elvanto: false }} />);

    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).toBeDisabled();
    expect(screen.getByText('Connect Elvanto before using it as your people source.')).toBeInTheDocument();
  });

  it('disables a provider without an enabled batch and explains the prerequisite', () => {
    render(<Harness batches={[]} />);

    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).toBeDisabled();
    expect(screen.getByText('Create and enable an Elvanto sync batch first.')).toBeInTheDocument();
  });

  it('blocks a switch when any enabled target batch has neither a source nor a source draft', () => {
    render(<Harness batches={[
      enabledPreparedBatch,
      { ...enabledPreparedBatch, id: 21, name: 'Youth', source: null, draftSource: null },
    ]} />);

    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).toBeDisabled();
    expect(screen.getByText('Every enabled Elvanto batch needs a people source or source draft before switching.')).toBeInTheDocument();
  });

  it('keeps Planning Center batch guidance grammatical', () => {
    render(<Harness provider="planning_center" initialAuthority="none" batches={[]} />);

    expect(screen.getByRole('switch', { name: 'Use Planning Center as source of truth' })).toBeDisabled();
    expect(screen.getByText('Create a Planning Center sync batch first.')).toBeInTheDocument();
  });

  it('keeps an active disconnected provider enabled so authority can be turned off', () => {
    render(
      <Harness
        provider="planning_center"
        initialAuthority="planning_center"
        connections={{ planning_center: false, elvanto: true }}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    expect(toggle).toBeEnabled();
    expect(screen.queryByText('Connect Planning Center before using it as your people source.')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('dialog', { name: 'Pause people sync?' })).toBeInTheDocument();
  });

  it('keeps an active provider without batches enabled so authority can be turned off', () => {
    render(<Harness provider="planning_center" initialAuthority="planning_center" batches={[]} />);

    const toggle = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    expect(toggle).toBeEnabled();
    expect(screen.queryByText('Create a Planning Center sync batch first.')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('dialog', { name: 'Pause people sync?' })).toBeInTheDocument();
  });

  it('shows the server error returned by a failed preview', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockRejectedValue({
      response: { data: { error: 'Elvanto credentials need reconnecting.' } },
      message: 'Request failed',
    });
    render(<Harness initialAuthority="none" />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Elvanto credentials need reconnecting.');
  });

});
