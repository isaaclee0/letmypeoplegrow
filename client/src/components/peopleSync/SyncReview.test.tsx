import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from './SyncReview';
import type {
  EstablishedLinkCorrection,
  IdentityReviewEntry,
  PeopleSyncCorrectionPreview,
  PeopleSyncPlan,
  PeopleSyncPlanSummary,
  PeopleSyncReview,
} from './types';

const emptyBuckets = (): Omit<PeopleSyncPlan, 'provider' | 'authoritative' | 'snapshot'> => ({
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
});

const summaryFor = (plan: PeopleSyncPlan): PeopleSyncPlanSummary => Object.fromEntries(
  Object.entries(plan)
    .filter(([key]) => !['provider', 'authoritative', 'snapshot', 'people', 'reviewContext'].includes(key))
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
) as PeopleSyncPlanSummary;

const identity = (overrides: Partial<IdentityReviewEntry> = {}): IdentityReviewEntry => ({
  suggestedIndividualId: 7,
  candidateIndividualIds: [7],
  excludedIndividualIds: [],
  held: false,
  canCreate: true,
  createPerson: {
    firstName: 'Alex', lastName: 'Smith', isChild: false,
    externalFamilyId: null, peopleType: 'regular',
  },
  ...overrides,
});

function v2Review({
  attention = true,
  established = false,
  planOverrides = {},
  token = 'review-token',
  runId = 1,
}: {
  attention?: boolean;
  established?: boolean;
  planOverrides?: Partial<PeopleSyncPlan>;
  token?: string;
  runId?: number;
} = {}): PeopleSyncReview {
  const identities: Record<string, IdentityReviewEntry> = {
    'ext-auto': identity(),
    ...(attention ? {
      'ext-attention': identity({
        suggestedIndividualId: null,
        candidateIndividualIds: [8, 9],
        held: true,
        createPerson: {
          firstName: 'Blair', lastName: 'Jones', isChild: false,
          externalFamilyId: null, peopleType: 'regular',
        },
      }),
    } : {}),
  };
  const plan: PeopleSyncPlan = {
    ...emptyBuckets(),
    provider: 'planning_center',
    authoritative: true,
    snapshot: { fetchedAt: '2026-08-02T01:00:00.000Z', mode: 'full' },
    people: {
      external: {
        'ext-auto': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } },
        ...(attention ? { 'ext-attention': { firstName: 'Blair', lastName: 'Jones', family: { state: 'none' } } } : {}),
        ...(established ? { 'ext-established': { firstName: 'Established', lastName: 'Source', family: { state: 'none' } } } : {}),
      },
      local: {
        '7': { firstName: 'Alex', lastName: 'Smith', matchEligible: true, family: { state: 'none' } },
        '8': { firstName: 'Taylor', lastName: 'Reed', matchEligible: true, family: { state: 'none' } },
        '9': { firstName: 'Jordan', lastName: 'Lee', matchEligible: true, family: { state: 'none' } },
        '30': { firstName: 'Replacement', lastName: 'Local', matchEligible: true, family: { state: 'none' } },
        '40': { firstName: 'Current', lastName: 'Link', matchEligible: false, family: { state: 'none' } },
        '42': { firstName: 'Alternative', lastName: 'Local', matchEligible: true, family: { state: 'none' } },
      },
    },
    reviewContext: {
      version: 2,
      correctionContractVersion: 1,
      manualCandidateIndividualIds: [7, 8, 9, 30, 42],
      ...(established ? {
        establishedLinks: { 'ext-established': { individualId: 40 } },
        projectedEstablishedLinks: { 'ext-established': { individualId: 40 } },
      } : {}),
      identities,
    },
    linkPeople: [{
      id: 'link:ext-auto', externalPersonId: 'ext-auto', individualId: 7,
      reason: 'unique_name', reviewRequired: false,
    }],
    ...(attention ? {
      ambiguousPeople: [{
        id: 'ambiguous:ext-attention', externalPersonId: 'ext-attention',
        reason: 'duplicate_name', candidateIndividualIds: [8, 9],
      }],
    } : {}),
    ...planOverrides,
  };
  return {
    runId,
    reviewToken: token,
    decisionContractVersion: 2,
    summary: summaryFor(plan),
    plan,
    snapshot: plan.snapshot,
  };
}

function correctionPreview(
  correction: EstablishedLinkCorrection,
  token: string,
): PeopleSyncCorrectionPreview {
  const target = correction.outcome === 'relink' ? correction.individualId : null;
  const review = v2Review({
    attention: false,
    established: true,
    token,
    planOverrides: {
      updateManagedFields: target === null ? [] : [{
        id: `update:${target}`, externalPersonId: 'ext-established', individualId: target,
        changes: [{ field: 'firstName', localValue: 'Old', externalValue: 'Updated' }],
        reason: 'provider_managed_fields', reviewRequired: false,
      }],
    },
  });
  review.plan.reviewContext!.linkCorrections = [{ externalPersonId: 'ext-established', ...correction }];
  review.plan.reviewContext!.projectedEstablishedLinks = target === null
    ? {}
    : { 'ext-established': { individualId: target } };
  const { runId: _runId, ...preview } = review;
  return preview;
}

function serverCanonicalCorrectionPreview(
  token: string,
): PeopleSyncCorrectionPreview {
  const preview = correctionPreview(
    { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
    token,
  );
  // This deliberately matches the server's canonical serialization order.
  preview.plan.reviewContext!.linkCorrections = [{
    externalPersonId: 'ext-established',
    fromIndividualId: 40,
    outcome: 'relink',
    individualId: 30,
  }];
  return preview;
}

function swapCorrectionPreview(
  corrections: Record<string, EstablishedLinkCorrection>,
): PeopleSyncCorrectionPreview {
  const review = v2Review({ attention: false, established: true, token: 'swap-preview' });
  review.plan.people!.external['ext-second-established'] = {
    firstName: 'Second', lastName: 'Source', family: { state: 'none' },
  };
  review.plan.people!.local['41'] = {
    firstName: 'Durable', lastName: 'Link', matchEligible: false, family: { state: 'none' },
  };
  review.plan.reviewContext!.establishedLinks = {
    'ext-established': { individualId: 40 },
    'ext-second-established': { individualId: 41 },
  };
  review.plan.reviewContext!.projectedEstablishedLinks = Object.fromEntries(
    Object.entries(review.plan.reviewContext!.establishedLinks).flatMap(([externalId, established]) => {
      const correction = corrections[externalId];
      if (correction?.outcome === 'unlink') return [];
      return [[externalId, {
        individualId: correction?.outcome === 'relink' ? correction.individualId : established.individualId,
      }]];
    }),
  );
  review.plan.reviewContext!.linkCorrections = Object.entries(corrections)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([externalPersonId, correction]) => ({ externalPersonId, ...correction }));
  const projectedTargetIds = new Set(
    Object.values(review.plan.reviewContext!.projectedEstablishedLinks).map(({ individualId }) => individualId),
  );
  review.plan.reviewContext!.manualCandidateIndividualIds =
    review.plan.reviewContext!.manualCandidateIndividualIds.filter((id) => !projectedTargetIds.has(id));
  const { runId: _runId, ...preview } = review;
  return preview;
}

function legacyReview(): PeopleSyncReview {
  const plan: PeopleSyncPlan = {
    ...emptyBuckets(),
    provider: 'elvanto',
    authoritative: true,
    snapshot: { fetchedAt: '2026-08-02T01:00:00.000Z', mode: 'full' },
    people: {
      external: { 'ext-legacy': { firstName: 'Legacy', lastName: 'Person', family: { state: 'none' } } },
      local: { '11': { firstName: 'Local', lastName: 'Archived', family: { state: 'none' } } },
    },
    archive: [{
      id: 'archive:11', externalPersonId: 'ext-legacy', individualId: 11,
      reason: 'confirmed_missing_full_sync', missingFullSyncCount: 2,
    }],
    ambiguousPeople: [{
      id: 'ambiguous:legacy', externalPersonId: 'ext-legacy',
      reason: 'duplicate_name', candidateIndividualIds: [11],
    }],
  };
  return { runId: 2, reviewToken: 'legacy-token', summary: summaryFor(plan), plan, snapshot: plan.snapshot };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function chooseAlternativeForAttention() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Change LMPG match for Blair Jones' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Taylor Reed' }));
  return user;
}

async function beginEstablishedCorrection(target: 'Replacement Local' | 'Alternative Local' | 'unlink') {
  const user = userEvent.setup();
  if (screen.getByRole('tab', { name: /Already linked/ }).getAttribute('aria-selected') !== 'true') {
    await user.click(screen.getByRole('tab', { name: /Already linked/ }));
  }
  await user.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
  if (target === 'unlink') {
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink and review again' }));
    return user;
  }
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: `Select ${target}` }));
  return user;
}

describe('SyncReview compact V2 workflow', () => {
  it('renders the table, compact metadata, and one bottom-only apply action', async () => {
    const user = userEvent.setup();
    const review = v2Review({
      attention: false,
      planOverrides: {
        archive: [{
          id: 'archive:8', externalPersonId: 'missing', individualId: 8,
          reason: 'confirmed_missing_full_sync', missingFullSyncCount: 2,
        }],
        renameFamily: [{ id: 'renameFamily:20', familyId: 20, familyName: 'Renamed family' }],
      },
    });
    render(<SyncReview
      provider="planning_center"
      batchName="Members"
      sourceName="Active members"
      review={review}
      onRefresh={vi.fn()}
      onApply={vi.fn()}
      applying={false}
    />);

    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Active members')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Identity decisions' })).toBeInTheDocument();
    expect(screen.queryByText('Accept suggested match')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Archive Taylor Reed' }));
    await user.click(screen.getByRole('checkbox', { name: 'Accept family rename to Renamed family' }));
    const apply = screen.getByRole('button', { name: 'Apply 3 selected changes' });
    expect(screen.getAllByRole('button', { name: /Apply .*selected changes|Apply sync/ })).toHaveLength(1);
    const destructive = screen.getByText(/I understand that this sync will archive people/i);
    expect(destructive.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('requires incomplete decisions and focuses guidance on the affected row', async () => {
    const user = userEvent.setup();
    const review = v2Review();
    render(<SyncReview provider="planning_center" review={review} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Blair Jones needs a decision');
    const apply = screen.getByRole('button', { name: 'Apply 1 selected change' });
    expect(apply).toBeDisabled();
    await user.click(within(alert).getByRole('button', { name: /Review Blair Jones/ }));
    const needsAttentionFilter = screen.getAllByRole('button', { name: 'Needs attention 1' })
      .find((button) => button.hasAttribute('aria-pressed'));
    expect(needsAttentionFilter).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change LMPG match for Blair Jones' })).toHaveFocus());

  });

  it('identifies client-known claim collisions by person name', () => {
    const collision = v2Review({ attention: false });
    collision.plan.reviewContext!.identities['ext-other'] = identity({
      createPerson: {
        firstName: 'Other', lastName: 'Person', isChild: false,
        externalFamilyId: null, peopleType: 'regular',
      },
    });
    collision.plan.people!.external['ext-other'] = { firstName: 'Other', lastName: 'Person', family: { state: 'none' } };
    render(<SyncReview provider="planning_center" review={{ ...collision, runId: 3, reviewToken: 'collision' }} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Alex Smith.*Other Person|Other Person.*Alex Smith/);
    expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeDisabled();
  });

  it('retries after an ordinary apply failure, then makes a stale review refresh-only', async () => {
    const user = userEvent.setup();
    const ordinary = Object.assign(new Error('Temporary network problem.'), { code: 'NETWORK_ERROR' });
    const stale = Object.assign(new Error('The reviewed plan was out of date.'), { code: 'SYNC_PLAN_STALE' });
    const onApply = vi.fn().mockRejectedValueOnce(ordinary).mockRejectedValueOnce(stale);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview provider="planning_center" review={v2Review({ attention: false })} onRefresh={onRefresh} onApply={onApply} applying={false} />);

    const apply = screen.getByRole('button', { name: 'Apply 1 selected change' });
    await user.click(apply);
    expect(await screen.findByText('Temporary network problem.')).toBeInTheDocument();
    expect(apply).toBeEnabled();
    await user.click(apply);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This review is out of date.');
    expect(apply).toBeDisabled();
    await user.click(within(alert).getByRole('button', { name: 'Refresh plan' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it('keeps a stale review locked when its owner catches and resolves a failed refresh', async () => {
    const user = userEvent.setup();
    const stale = Object.assign(new Error('The reviewed plan was out of date.'), { code: 'SYNC_PLAN_STALE' });
    const onApply = vi.fn().mockRejectedValue(stale);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false })}
      onRefresh={onRefresh}
      onApply={onApply}
      applying={false}
    />);

    const apply = screen.getByRole('button', { name: 'Apply 1 selected change' });
    await user.click(apply);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This review is out of date.');

    await user.click(within(alert).getByRole('button', { name: 'Refresh plan' }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText('This review is out of date.')).toBeInTheDocument();
    expect(apply).toBeDisabled();
  });

  it('makes an already-applied review refresh-only', async () => {
    const user = userEvent.setup();
    const replay = Object.assign(new Error('Request failed'), {
      response: { data: { code: 'SYNC_REVIEW_ALREADY_APPLIED', error: 'Refresh before applying another sync.' } },
    });
    const onApply = vi.fn().mockRejectedValue(replay);
    render(<SyncReview provider="planning_center" review={v2Review({ attention: false })} onRefresh={vi.fn()} onApply={onApply} applying={false} />);

    await user.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This review has already been applied.');
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeDisabled();
  });

  it('fails closed for malformed V2 review context and disables all interactions on request', () => {
    const malformed = v2Review();
    malformed.plan.reviewContext = undefined;
    const { rerender } = render(<SyncReview provider="planning_center" review={malformed} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    expect(screen.getByRole('alert')).toHaveTextContent('could not be safely loaded');
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();

    rerender(<SyncReview provider="planning_center" review={v2Review({ attention: false, runId: 5, token: 'disabled' })} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} interactionDisabled />);
    expect(screen.getByRole('button', { name: 'Refresh plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
  });

  it.each([
    ['an object instead of a correction list', {}],
    ['a relink with a non-numeric source person', [{ externalPersonId: 'ext-established', outcome: 'relink', fromIndividualId: '40', individualId: 30 }]],
    ['a correction with an unknown outcome', [{ externalPersonId: 'ext-established', outcome: 'replace', fromIndividualId: 40, individualId: 30 }]],
    ['an unlink with an unexpected target person', [{ externalPersonId: 'ext-established', outcome: 'unlink', fromIndividualId: 40, individualId: 30 }]],
  ])('fails closed for malformed link corrections: %s', (_label, linkCorrections) => {
    const malformed = v2Review({ attention: false });
    malformed.plan.reviewContext!.linkCorrections = linkCorrections as never;

    render(<SyncReview
      provider="planning_center"
      review={malformed}
      onRefresh={vi.fn()}
      onApply={vi.fn()}
      applying={false}
    />);

    expect(screen.getByRole('alert')).toHaveTextContent('could not be safely loaded');
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
  });

  it('fails closed when an established-link target is malformed', () => {
    const malformed = v2Review({ attention: false });
    malformed.plan.reviewContext!.establishedLinks = {
      'ext-established': { individualId: '40' },
    } as never;

    render(<SyncReview
      provider="planning_center"
      review={malformed}
      onRefresh={vi.fn()}
      onApply={vi.fn()}
      applying={false}
    />);

    expect(screen.getByRole('alert')).toHaveTextContent('could not be safely loaded');
    expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
  });

  it('resets local decisions for an explicit refreshed review token', async () => {
    const base = v2Review();
    const { rerender } = render(<SyncReview provider="planning_center" review={base} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);
    await chooseAlternativeForAttention();
    expect(screen.getByRole('button', { name: 'Change LMPG match for Blair Jones' })).toHaveTextContent('Taylor Reed');

    rerender(<SyncReview
      provider="planning_center"
      review={v2Review({ token: 'fresh-token', runId: 6 })}
      onRefresh={vi.fn()}
      onApply={vi.fn()}
      applying={false}
    />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change LMPG match for Blair Jones' })).toHaveTextContent('Choose a decision'));
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeDisabled();
  });

  it('shows source coverage only when positive', () => {
    const review = { ...v2Review({ attention: false }), coverage: { unmatchedActiveLocalRegulars: 208 } };
    const { rerender } = render(<SyncReview provider="planning_center" review={review} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);
    expect(screen.getByText(/208 active LMPG regulars/)).toBeInTheDocument();
    rerender(<SyncReview provider="planning_center" review={{ ...review, runId: 7, reviewToken: 'fresh', coverage: { unmatchedActiveLocalRegulars: 0 } }} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);
    expect(screen.queryByText(/208 active LMPG regulars/)).not.toBeInTheDocument();
  });

  it('keeps archive acceptance and the destructive acknowledgement immediately before apply', async () => {
    const user = userEvent.setup();
    const review = v2Review({
      attention: false,
      planOverrides: {
        archive: [{
          id: 'archive:8', externalPersonId: 'missing', individualId: 8,
          reason: 'confirmed_missing_full_sync', missingFullSyncCount: 2,
        }],
      },
    });
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview provider="planning_center" review={review} onRefresh={vi.fn()} onApply={onApply} applying={false} requireAllPlannedArchivesAccepted />);

    const apply = screen.getByRole('button', { name: 'Apply 1 selected change' });
    expect(apply).toBeDisabled();
    expect(screen.getByText('Missing from two complete provider syncs')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Archive Taylor Reed' }));
    await user.click(screen.getByRole('checkbox', { name: /I understand that this sync will archive people/ }));
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(onApply).toHaveBeenCalledWith('review-token', expect.objectContaining({ acceptArchiveIndividualIds: [8] }));
  });

  it('accepts every terminal-state archive proposal without selecting an unrelated local-only person', async () => {
    const user = userEvent.setup();
    const review = v2Review({
      attention: false,
      planOverrides: {
        archive: [
          {
            id: 'archive:8', externalPersonId: 'ext-archived', individualId: 8,
            reason: 'provider_state_archived', missingFullSyncCount: null,
          },
          {
            id: 'archive:9', externalPersonId: 'ext-deceased', individualId: 9,
            reason: 'provider_state_deceased', missingFullSyncCount: null,
          },
        ],
        unmatchedLocalRegulars: [{
          id: 'unmatchedLocalRegular:30', individualId: 30,
          reason: 'no_authority_link', reviewRequired: true,
        }],
      },
    });
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview
      provider="planning_center"
      review={review}
      onRefresh={vi.fn()}
      onApply={onApply}
      applying={false}
      requireAllPlannedArchivesAccepted
    />);

    expect(screen.getByText('Lifecycle review')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept all proposed archives' }));
    expect(screen.getByRole('checkbox', { name: 'Archive Taylor Reed' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Archive Jordan Lee' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Archive Replacement Local' })).not.toBeInTheDocument();

    const apply = screen.getByRole('button', { name: 'Apply 3 selected changes' });
    expect(apply).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I understand that this sync will archive people/ }));
    expect(apply).toBeEnabled();
    await user.click(apply);

    expect(onApply).toHaveBeenCalledWith('review-token', expect.objectContaining({
      acceptArchiveIndividualIds: [8, 9],
    }));
    expect(screen.getAllByRole('button', { name: /Apply .*selected changes|Apply sync/ })).toHaveLength(1);
  });

  it('omits lifecycle review when the plan has no archive proposals', () => {
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false })}
      onRefresh={vi.fn()}
      onApply={vi.fn()}
      applying={false}
    />);

    expect(screen.queryByText('Lifecycle review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept all proposed archives' })).not.toBeInTheDocument();
  });
});

describe('SyncReview correction previews and dirty state', () => {
  it('shows established links read-only when the review owner cannot preview corrections', () => {
    render(<SyncReview
      provider="elvanto"
      review={v2Review({ attention: false, established: true })}
      onRefresh={vi.fn()}
      onApply={vi.fn()}
      applying={false}
    />);

    expect(screen.getByText('Already linked (read-only)')).toBeInTheDocument();
    expect(screen.getByText(/Established Source.*Current Link/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Correct linked person for Established Source' })).not.toBeInTheDocument();
  });

  it('uses the base token, disables apply while pending, and applies the signed preview token', async () => {
    const pending = deferred<PeopleSyncCorrectionPreview>();
    const onPreviewCorrections = vi.fn(() => pending.promise);
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false, established: true })}
      onRefresh={vi.fn()}
      onPreviewCorrections={onPreviewCorrections}
      onApply={onApply}
      applying={false}
    />);

    const user = await beginEstablishedCorrection('Replacement Local');
    expect(onPreviewCorrections).toHaveBeenCalledWith('review-token', {
      'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
    });
    expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeDisabled();

    pending.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 30 }, 'preview-30'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(onApply).toHaveBeenCalledWith('preview-30', expect.objectContaining({
      linkCorrections: { 'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 } },
    }));
  });

  it('enables apply after a server-canonical correction preview', async () => {
    const onPreviewCorrections = vi.fn().mockResolvedValue(serverCanonicalCorrectionPreview('preview-30'));
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false, established: true })}
      onRefresh={vi.fn()}
      onPreviewCorrections={onPreviewCorrections}
      onApply={vi.fn()}
      applying={false}
    />);

    await beginEstablishedCorrection('Replacement Local');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeEnabled());
  });

  it('does not treat an unlink preview with an unexpected target as signed', async () => {
    const preview = correctionPreview(
      { outcome: 'unlink', fromIndividualId: 40, individualId: 30 },
      'preview-unlink-with-target',
    );
    const onPreviewCorrections = vi.fn().mockResolvedValue(preview);
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false, established: true })}
      onRefresh={vi.fn()}
      onPreviewCorrections={onPreviewCorrections}
      onApply={vi.fn()}
      applying={false}
    />);

    await beginEstablishedCorrection('unlink');

    expect(await screen.findByText('The latest established-link correction needs a successful signed preview before you can apply.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply sync' })).toBeDisabled();
  });

  it('blocks a half-swap, then applies both explicit corrections with the signed swap preview token', async () => {
    const base = v2Review({ attention: false, established: true });
    base.plan.people!.external['ext-second-established'] = {
      firstName: 'Second', lastName: 'Source', family: { state: 'none' },
    };
    base.plan.people!.local['41'] = {
      firstName: 'Durable', lastName: 'Link', matchEligible: false, family: { state: 'none' },
    };
    base.plan.reviewContext!.establishedLinks = {
      'ext-established': { individualId: 40 },
      'ext-second-established': { individualId: 41 },
    };
    base.plan.reviewContext!.projectedEstablishedLinks = {
      'ext-established': { individualId: 40 },
      'ext-second-established': { individualId: 41 },
    };
    const onPreviewCorrections = vi.fn(async (
      _baseToken: string,
      corrections: Record<string, EstablishedLinkCorrection>,
    ) => swapCorrectionPreview(corrections));
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview
      provider="planning_center"
      review={base}
      onRefresh={vi.fn()}
      onPreviewCorrections={onPreviewCorrections}
      onApply={onApply}
      applying={false}
    />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Already linked 2' }));
    await user.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
    let dialog = screen.getByRole('dialog', { name: 'Correct linked person for Established Source' });
    await user.click(within(dialog).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(dialog).getByRole('button', { name: 'Select Durable Link' }));

    expect(onPreviewCorrections).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Apply \d+ selected changes/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Correct linked person for Second Source' }));
    dialog = screen.getByRole('dialog', { name: 'Correct linked person for Second Source' });
    await user.click(within(dialog).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(dialog).getByRole('button', { name: 'Select Current Link' }));

    await waitFor(() => expect(onPreviewCorrections).toHaveBeenCalledWith('review-token', {
      'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 41 },
      'ext-second-established': { outcome: 'relink', fromIndividualId: 41, individualId: 40 },
    }));
    const apply = screen.getByRole('button', { name: /Apply \d+ selected changes/ });
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);

    expect(onApply).toHaveBeenCalledWith('swap-preview', expect.objectContaining({
      linkCorrections: {
        'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 41 },
        'ext-second-established': { outcome: 'relink', fromIndividualId: 41, individualId: 40 },
      },
    }));
  });

  it('keeps apply disabled after preview failure until the correction is reverted', async () => {
    const onPreviewCorrections = vi.fn().mockRejectedValue(new Error('preview unavailable'));
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false, established: true })}
      onRefresh={vi.fn()}
      onPreviewCorrections={onPreviewCorrections}
      onApply={vi.fn()}
      applying={false}
    />);

    const user = await beginEstablishedCorrection('unlink');
    const alert = (await screen.findByText(/The correction is still drafted/)).closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent('updated sync preview could not be loaded');
    expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeDisabled();
    await user.click(within(alert as HTMLElement).getByRole('button', { name: 'Revert correction' }));
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeEnabled();
  });

  it.each([
    'SYNC_PLAN_STALE',
    'SYNC_REVIEW_EXPIRED',
    'SYNC_REVIEW_INVALID',
  ])('requires a full-plan refresh when correction preview returns %s', async (code) => {
    const onRefresh = vi.fn();
    const onPreviewCorrections = vi.fn().mockRejectedValue({
      response: { data: { code, error: 'The signed review can no longer be used.' } },
    });
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false, established: true })}
      onRefresh={onRefresh}
      onPreviewCorrections={onPreviewCorrections}
      onApply={vi.fn()}
      applying={false}
    />);

    const user = await beginEstablishedCorrection('unlink');
    const guidance = await screen.findByText(/Refresh the full plan before applying/);
    const alert = guidance.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(within(alert as HTMLElement).queryByRole('button', { name: 'Retry preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeDisabled();

    await user.click(within(alert as HTMLElement).getByRole('button', { name: 'Refresh plan' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onPreviewCorrections).toHaveBeenCalledTimes(1);
    await user.click(within(alert as HTMLElement).getByRole('button', { name: 'Revert correction' }));
    expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeDisabled();
  });

  it('does not let an older API response replace the latest effective review', async () => {
    const older = deferred<PeopleSyncCorrectionPreview>();
    const newer = deferred<PeopleSyncCorrectionPreview>();
    const onPreviewCorrections = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview
      provider="planning_center"
      review={v2Review({ attention: false, established: true })}
      onRefresh={vi.fn()}
      onPreviewCorrections={onPreviewCorrections}
      onApply={onApply}
      applying={false}
    />);

    const user = await beginEstablishedCorrection('Replacement Local');
    await beginEstablishedCorrection('Alternative Local');
    newer.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 42 }, 'preview-42'));
    await waitFor(() => expect(screen.getByText('Update Alternative Local')).toBeInTheDocument());

    older.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 30 }, 'preview-30'));
    await waitFor(() => expect(screen.queryByText('Refreshing correction preview…')).not.toBeInTheDocument());
    expect(screen.getByText('Update Alternative Local')).toBeInTheDocument();
    expect(screen.queryByText('Update Replacement Local')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(onApply).toHaveBeenCalledWith('preview-42', expect.objectContaining({
      linkCorrections: { 'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 42 } },
    }));
  });

  it('reports only real review edits as dirty and clears dirty after a successful apply', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview
      provider="planning_center"
      review={v2Review()}
      onRefresh={vi.fn()}
      onApply={onApply}
      onDirtyChange={onDirtyChange}
      applying={false}
    />);

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    const callsBeforeSearch = onDirtyChange.mock.calls.length;
    await user.type(screen.getByRole('searchbox', { name: 'Search identities' }), 'Alex');
    expect(onDirtyChange).toHaveBeenCalledTimes(callsBeforeSearch);
    await user.clear(screen.getByRole('searchbox', { name: 'Search identities' }));

    await chooseAlternativeForAttention();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('clears dirty state after the review owner accepts a successful plan refresh', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const onRefresh = vi.fn();
    function RefreshOwner() {
      const [ownedReview, setOwnedReview] = React.useState(v2Review());
      return <SyncReview
        provider="planning_center"
        review={ownedReview}
        onRefresh={() => {
          onRefresh();
          setOwnedReview(v2Review({ token: 'refreshed-token', runId: 2 }));
        }}
        onApply={vi.fn()}
        onDirtyChange={onDirtyChange}
        applying={false}
      />;
    }
    render(<RefreshOwner />);

    await chooseAlternativeForAttention();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole('button', { name: 'Refresh plan' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
});

describe('SyncReview legacy compatibility', () => {
  it('keeps the local pre-V2 decision renderer and destructive safeguards', async () => {
    const user = userEvent.setup();
    const review = legacyReview();
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview
      provider="elvanto"
      review={review}
      onRefresh={vi.fn()}
      onApply={onApply}
      applying={false}
      resolveAmbiguousArchiveIndividualId={() => 11}
      requireAllPlannedArchivesAccepted
    />);

    expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Archive this person' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Apply sync' })).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: 'Archive this person' }));
    await user.click(screen.getByRole('checkbox', { name: /I understand that this sync will archive people/ }));
    await user.click(screen.getByRole('button', { name: 'Apply sync' }));
    expect(onApply).toHaveBeenCalledWith('legacy-token', expect.objectContaining({ acceptArchiveIndividualIds: [11] }));
  });
});
