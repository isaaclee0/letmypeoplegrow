import React, { createRef, useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IdentityReviewTable, { type IdentityReviewTableHandle } from './IdentityReviewTable';
import type { SyncSelectionState } from './syncSelections';
import type {
  EstablishedLinkCorrection,
  PeopleSyncPlan,
  PeopleSyncPlanSummary,
  PeopleSyncReview,
} from './types';

const emptyPlanBuckets = (): Omit<PeopleSyncPlan, 'provider' | 'authoritative' | 'snapshot'> => ({
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
});

function summaryFor(plan: PeopleSyncPlan): PeopleSyncPlanSummary {
  return Object.fromEntries(
    Object.entries(plan)
      .filter(([key]) => !['provider', 'authoritative', 'snapshot', 'people', 'reviewContext'].includes(key))
      .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
  ) as PeopleSyncPlanSummary;
}

function reviewFixture(): PeopleSyncReview {
  const external = Object.fromEntries(Array.from({ length: 55 }, (_, offset) => {
    const index = offset + 1;
    const externalId = `ext-${String(index).padStart(2, '0')}`;
    return [externalId, {
      firstName: index === 1 ? 'Alex' : `Provider${index}`,
      lastName: index === 1 ? 'Smith' : 'Person',
      family: index === 1
        ? {
          state: 'known' as const,
          name: 'Smith household',
          members: [
            { firstName: 'Source', lastName: 'Sibling' },
            { firstName: 'Second', lastName: 'Sibling' },
            { firstName: 'Third', lastName: 'Sibling' },
            { firstName: 'Fourth', lastName: 'Sibling' },
          ],
          totalOtherMembers: 5,
        }
        : index === 3
          ? { state: 'unavailable' as const }
          : { state: 'none' as const },
    }];
  }));
  external['ext-established'] = {
    firstName: 'Established', lastName: 'Source', family: { state: 'none' },
  };

  const identities = Object.fromEntries(Array.from({ length: 55 }, (_, offset) => {
    const index = offset + 1;
    const externalId = `ext-${String(index).padStart(2, '0')}`;
    return [externalId, {
      suggestedIndividualId: index === 1 ? 10 : null,
      candidateIndividualIds: index === 4 ? [10] : [],
      excludedIndividualIds: index === 5 ? [30] : [],
      held: index === 3,
      canCreate: true,
      createPerson: {
        firstName: index === 1 ? 'Alex' : `Provider${index}`,
        lastName: index === 1 ? 'Smith' : 'Person',
        isChild: false,
        externalFamilyId: null,
        peopleType: 'regular' as const,
      },
    }];
  }));

  const plan: PeopleSyncPlan = {
    ...emptyPlanBuckets(),
    provider: 'planning_center',
    authoritative: false,
    snapshot: { fetchedAt: '2026-08-02T00:00:00.000Z', mode: 'full' },
    people: {
      external,
      local: {
        '10': { firstName: 'Suggested', lastName: 'Local', matchEligible: true, family: { state: 'none' } },
        '20': {
          firstName: 'Claimed', lastName: 'Local', matchEligible: true,
          family: {
            state: 'known', name: 'Local family',
            members: [{ firstName: 'Local', lastName: 'Sibling' }], totalOtherMembers: 1,
          },
        },
        '30': { firstName: 'Replacement', lastName: 'Local', matchEligible: true, family: { state: 'unavailable' } },
        '40': { firstName: 'Current', lastName: 'Link', matchEligible: false, family: { state: 'none' } },
        '41': { firstName: 'Durable', lastName: 'Link', matchEligible: false, family: { state: 'none' } },
        '42': { firstName: 'Alternative', lastName: 'Local', matchEligible: true, family: { state: 'none' } },
      },
    },
    reviewContext: {
      version: 2,
      correctionContractVersion: 1,
      manualCandidateIndividualIds: [10, 20, 30, 42],
      establishedLinks: { 'ext-established': { individualId: 40 } },
      projectedEstablishedLinks: { 'ext-established': { individualId: 40 } },
      identities,
    },
  };
  return {
    runId: 1,
    reviewToken: 'review-token',
    decisionContractVersion: 2,
    summary: summaryFor(plan),
    plan,
    snapshot: plan.snapshot,
  };
}

function stateFixture(): SyncSelectionState {
  const identityDecisions: NonNullable<SyncSelectionState['identityDecisions']> = {};
  for (let index = 1; index <= 55; index += 1) {
    const externalId = `ext-${String(index).padStart(2, '0')}`;
    identityDecisions[externalId] = index === 1
      ? { outcome: 'accept' }
      : index === 2 || index >= 6
        ? { outcome: 'create' }
        : index === 4
          ? { outcome: 'defer' }
          : index === 5
            ? { outcome: 'link', individualId: 20 }
            : null;
  }
  return {
    identityDecisions,
    linkCorrections: {},
    ambiguousChoices: {},
    skippedExternalIds: new Set(),
    visitorChoices: {},
    acceptedArchiveIds: new Set(),
    acceptedFamilyRenameIds: new Set(),
  };
}

function correctionPreview(correction: EstablishedLinkCorrection): PeopleSyncReview {
  const review = reviewFixture();
  review.reviewToken = correction.outcome === 'relink' ? `preview-${correction.individualId}` : 'preview-unlink';
  review.plan.reviewContext!.linkCorrections = [{ externalPersonId: 'ext-established', ...correction }];
  review.plan.reviewContext!.projectedEstablishedLinks = correction.outcome === 'relink'
    ? { 'ext-established': { individualId: correction.individualId } }
    : {};
  return review;
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

function TableHarness({
  onPreviewCorrections = async () => reviewFixture(),
  previewing = false,
  tableRef,
}: {
  onPreviewCorrections?: (corrections: Record<string, EstablishedLinkCorrection>) => Promise<PeopleSyncReview>;
  previewing?: boolean;
  tableRef?: React.Ref<IdentityReviewTableHandle>;
}) {
  const [state, setState] = useState(stateFixture());
  return (
    <>
      <output data-testid="selection-state">{JSON.stringify(state.identityDecisions)}</output>
      <output data-testid="correction-state">{JSON.stringify(state.linkCorrections)}</output>
      <IdentityReviewTable
        ref={tableRef}
        review={reviewFixture()}
        state={state}
        onStateChange={setState}
        onPreviewCorrections={onPreviewCorrections}
        previewing={previewing}
      />
    </>
  );
}

function RefreshableTableHarness({
  onPreviewCorrections,
}: {
  onPreviewCorrections: (corrections: Record<string, EstablishedLinkCorrection>) => Promise<PeopleSyncReview>;
}) {
  const [review, setReview] = useState(reviewFixture());
  const [state, setState] = useState(stateFixture());
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const replacement = reviewFixture();
          replacement.runId = 2;
          replacement.reviewToken = 'replacement-review-token';
          setReview(replacement);
          setState(stateFixture());
        }}
      >
        Replace base review
      </button>
      <output data-testid="refreshable-correction-state">{JSON.stringify(state.linkCorrections)}</output>
      <IdentityReviewTable
        review={review}
        state={state}
        onStateChange={setState}
        onPreviewCorrections={onPreviewCorrections}
        previewing={false}
      />
    </>
  );
}

function desktopRow(externalId: string) {
  return screen.getByTestId(`desktop-identity-row-${externalId}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IdentityReviewTable rendering', () => {
  it('renders the semantic five-column desktop table and compact mobile comparison rows', () => {
    render(<TableHarness />);

    const table = screen.getByTestId('desktop-identity-table');
    expect(table).toHaveClass('hidden', 'md:table');
    expect(table.closest('[class*="overflow-x"]')).toBeNull();
    expect(within(table).getByRole('columnheader', { name: 'Integration source name' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Integration source family/household' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'LMPG name' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'LMPG family' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Row action' })).toBeVisible();

    const row = desktopRow('ext-01');
    expect(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' })).toHaveTextContent('Suggested Local');
    expect(screen.getByRole('button', { name: 'Remove matching decision for Alex Smith' })).toHaveTextContent('×');
    expect(within(row).getByText('Smith household')).toBeVisible();
    expect(within(row).getByText('Source Sibling, Second Sibling, Third Sibling')).toBeVisible();
    expect(within(row).getByText('No family')).toBeVisible();

    const mobile = screen.getByTestId('mobile-identity-row-ext-01');
    expect(mobile).toHaveClass('md:hidden');
    expect(within(mobile).getByText('Integration source')).toBeVisible();
    expect(within(mobile).getByText('LMPG')).toBeVisible();
  });

  it('makes the compact row controls accessible at narrow viewport widths', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      media: '(min-width: 768px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(<TableHarness />);

    const mobile = screen.getByTestId('mobile-identity-row-ext-01');
    expect(within(mobile).getByRole('button', { name: 'Change LMPG match for Alex Smith' })).toBeVisible();
    expect(within(mobile).getByRole('button', { name: 'Remove matching decision for Alex Smith' })).toBeVisible();
    expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
  });

  it('separates decisions from source-visible established links and shows complete counts', async () => {
    const user = userEvent.setup();
    render(<TableHarness />);

    const decisionsTab = screen.getByRole('tab', { name: 'Decisions 55' });
    const establishedTab = screen.getByRole('tab', { name: 'Already linked 1' });
    expect(decisionsTab).toHaveAttribute('aria-selected', 'true');
    expect(establishedTab).toHaveAttribute('aria-selected', 'false');
    const decisionsPanel = screen.getByRole('tabpanel', { name: 'Decisions 55' });
    expect(decisionsTab).toHaveAttribute('aria-controls', decisionsPanel.id);
    expect(establishedTab).toHaveAttribute('aria-controls', decisionsPanel.id);
    expect(decisionsPanel).toContainElement(screen.getByRole('table', { name: 'Identity decisions' }));
    expect(screen.getByRole('button', { name: 'All 55' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Needs attention 1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Matched 2' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Adding 51' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Skipped 1' })).toBeVisible();
    expect(screen.queryByText('Established Source')).not.toBeInTheDocument();

    decisionsTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(establishedTab).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Needs attention 1' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Established Source')).not.toHaveLength(0);
    expect(screen.queryByText('Alex Smith')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Already linked identities' })).toBeInTheDocument();
  });

  it('searches complete person and family context before pagination and resets changed criteria to page one', async () => {
    const user = userEvent.setup();
    render(<TableHarness />);

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 2')).toBeVisible();
    await user.type(screen.getByRole('searchbox', { name: 'Search identities' }), 'Source Sibling');

    expect(screen.getByText('Page 1 of 1')).toBeVisible();
    expect(screen.getAllByText('Alex Smith')).not.toHaveLength(0);
    expect(screen.queryByText('Provider55 Person')).not.toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search identities' }));
    await user.click(screen.getByRole('button', { name: 'Needs attention 1' }));
    expect(screen.getByText('Showing 1–1 of 1')).toBeVisible();
    expect(screen.getAllByText('Provider3 Person')).not.toHaveLength(0);
  });

  it('defaults to fifty rows, supports rows-per-page selection, and retains decisions across pages', async () => {
    const user = userEvent.setup();
    render(<TableHarness />);

    expect(screen.getByRole('combobox', { name: 'Rows per page' })).toHaveValue('50');
    expect(screen.getByText('Showing 1–50 of 55')).toBeVisible();
    expect(screen.queryByText('Provider55 Person')).not.toBeInTheDocument();

    await user.click(within(desktopRow('ext-01')).getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add new person' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(desktopRow('ext-01')).getByRole('button', { name: 'Change LMPG match for Alex Smith' })).toHaveTextContent('Add new person');

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Showing 51–55 of 55')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(within(desktopRow('ext-01')).getByRole('button', { name: 'Change LMPG match for Alex Smith' })).toHaveTextContent('Add new person');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Rows per page' }), '25');
    expect(screen.getByText('Page 1 of 3')).toBeVisible();
    expect(screen.getByText('Showing 1–25 of 55')).toBeVisible();
  });
});

describe('IdentityReviewTable decisions', () => {
  it('changes an addition to a manual match and a match back to an addition', async () => {
    const user = userEvent.setup();
    render(<TableHarness />);

    await user.click(within(desktopRow('ext-02')).getByRole('button', { name: 'Change LMPG match for Provider2 Person' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Replacement Local' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-02":{"outcome":"link","individualId":30}');
    expect(within(desktopRow('ext-02')).getByRole('button', { name: 'Change LMPG match for Provider2 Person' })).toHaveTextContent('Replacement Local');

    await user.click(within(desktopRow('ext-01')).getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add new person' }));
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-01":{"outcome":"create"}');
  });

  it('uses the row action dialog to reject only a pair or defer an addition', async () => {
    const user = userEvent.setup();
    render(<TableHarness />);

    await user.click(within(desktopRow('ext-01')).getByRole('button', { name: 'Remove matching decision for Alex Smith' }));
    const pairedDialog = screen.getByRole('dialog', { name: 'Remove matching decision for Alex Smith' });
    await user.click(within(pairedDialog).getByRole('button', { name: 'Reject this match' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-01":{"outcome":"defer","excludeIndividualId":10}');

    await user.click(within(desktopRow('ext-02')).getByRole('button', { name: 'Remove matching decision for Provider2 Person' }));
    const additionDialog = screen.getByRole('dialog', { name: 'Remove matching decision for Provider2 Person' });
    expect(within(additionDialog).queryByRole('button', { name: 'Reject this match' })).not.toBeInTheDocument();
    await user.click(within(additionDialog).getByRole('button', { name: 'Skip and ask again' }));
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-02":{"outcome":"defer"}');
  });

  it('preserves a rejected exact pair for another match or addition and confirms before restoring it', async () => {
    const user = userEvent.setup();
    render(<TableHarness />);

    await user.click(within(desktopRow('ext-01')).getByRole('button', { name: 'Remove matching decision for Alex Smith' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject this match' }));
    await user.click(within(desktopRow('ext-01')).getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Alternative Local' }));
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-01":{"outcome":"link","individualId":42,"excludeIndividualId":10}');

    await user.click(within(desktopRow('ext-01')).getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add new person' }));
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-01":{"outcome":"create","excludeIndividualId":10}');

    await user.click(within(desktopRow('ext-01')).getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Suggested Local' }));

    expect(screen.getByText('This exact pairing was previously rejected.')).toBeVisible();
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-01":{"outcome":"create","excludeIndividualId":10}');
    await user.click(screen.getByRole('button', { name: 'Confirm match to Suggested Local' }));
    expect(screen.getByTestId('selection-state')).toHaveTextContent('"ext-01":{"outcome":"link","individualId":10}');
  });

  it('focuses an off-page affected identity through its imperative handle', async () => {
    const tableRef = createRef<IdentityReviewTableHandle>();
    render(<TableHarness tableRef={tableRef} />);

    act(() => tableRef.current?.focusExternalId('ext-55'));

    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeVisible());
    await waitFor(() => expect(
      within(desktopRow('ext-55')).getByRole('button', { name: 'Change LMPG match for Provider55 Person' }),
    ).toHaveFocus());
  });
});

describe('IdentityReviewTable established-link correction previews', () => {
  it('relinks an established identity, disables claimed targets, and shows preview loading', async () => {
    const user = userEvent.setup();
    const pending = deferred<PeopleSyncReview>();
    const onPreviewCorrections = vi.fn(() => pending.promise);
    render(<TableHarness onPreviewCorrections={onPreviewCorrections} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));

    await user.click(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' }));
    const dialog = screen.getByRole('dialog', { name: 'Correct linked person for Established Source' });
    await user.click(within(dialog).getByRole('button', { name: 'Change linked person' }));
    expect(within(dialog).getByRole('button', { name: 'Select Claimed Local' })).toBeDisabled();
    expect(within(dialog).getAllByText('Already selected for another provider person')).not.toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Select Durable Link' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Select Replacement Local' }));

    expect(onPreviewCorrections).toHaveBeenCalledWith({
      'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
    }, expect.any(Object));
    expect(screen.getByText('Refreshing correction preview…')).toBeVisible();
    expect(screen.getByTestId('correction-state')).toHaveTextContent('"individualId":30');

    pending.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 30 }));
    await waitFor(() => expect(screen.queryByText('Refreshing correction preview…')).not.toBeInTheDocument());
    expect(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' })).toHaveTextContent('Replacement Local');
  });

  it('unlinks an established identity and adopts the signed unlink preview', async () => {
    const user = userEvent.setup();
    const onPreviewCorrections = vi.fn(async () => correctionPreview({ outcome: 'unlink', fromIndividualId: 40 }));
    render(<TableHarness onPreviewCorrections={onPreviewCorrections} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));

    await user.click(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink and review again' }));

    await waitFor(() => expect(onPreviewCorrections).toHaveBeenCalledWith({
      'ext-established': { outcome: 'unlink', fromIndividualId: 40 },
    }, expect.any(Object)));
    await waitFor(() => expect(screen.getByTestId('correction-state')).toHaveTextContent('"outcome":"unlink"'));
    expect(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' })).toHaveTextContent('Skipped for now');
  });

  it('keeps a failed draft correction and supports retry and local revert', async () => {
    const user = userEvent.setup();
    const first = deferred<PeopleSyncReview>();
    const retry = deferred<PeopleSyncReview>();
    const onPreviewCorrections = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => retry.promise);
    render(<TableHarness onPreviewCorrections={onPreviewCorrections} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));

    await user.click(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink and review again' }));
    first.reject(new Error('preview unavailable'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The correction is still drafted, but its updated sync preview could not be loaded.');
    expect(screen.getByTestId('correction-state')).toHaveTextContent('"outcome":"unlink"');
    await user.click(within(alert).getByRole('button', { name: 'Retry preview' }));
    expect(onPreviewCorrections).toHaveBeenCalledTimes(2);
    retry.reject(new Error('still unavailable'));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Revert correction' }));
    expect(screen.getByTestId('correction-state')).toHaveTextContent('{}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onPreviewCorrections).toHaveBeenCalledTimes(2);
    expect(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' })).toHaveTextContent('Current Link');
  });

  it('ignores a late correction preview after a newer correction has succeeded', async () => {
    const user = userEvent.setup();
    const older = deferred<PeopleSyncReview>();
    const newer = deferred<PeopleSyncReview>();
    const onPreviewCorrections = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    render(<TableHarness onPreviewCorrections={onPreviewCorrections} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));

    await user.click(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Replacement Local' }));

    await user.click(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Alternative Local' }));

    newer.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 42 }));
    await waitFor(() => expect(screen.getByTestId('correction-state')).toHaveTextContent('"individualId":42'));
    older.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 30 }));
    await waitFor(() => expect(screen.queryByText('Refreshing correction preview…')).not.toBeInTheDocument());

    expect(screen.getByTestId('correction-state')).toHaveTextContent('"individualId":42');
    expect(screen.getByTestId('correction-state')).not.toHaveTextContent('"individualId":30');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('aborts older callback work and exposes a current-generation guard to the preview owner', async () => {
    const user = userEvent.setup();
    const older = deferred<PeopleSyncReview>();
    const newer = deferred<PeopleSyncReview>();
    const onPreviewCorrections = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    render(<TableHarness onPreviewCorrections={onPreviewCorrections} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));

    await user.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Replacement Local' }));
    const firstRequest = (onPreviewCorrections.mock.calls as unknown[][])[0][1] as {
      signal: AbortSignal;
      isCurrent: () => boolean;
    };
    expect(firstRequest.isCurrent()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Alternative Local' }));
    const secondRequest = (onPreviewCorrections.mock.calls as unknown[][])[1][1] as {
      signal: AbortSignal;
      isCurrent: () => boolean;
    };

    expect(firstRequest.signal.aborted).toBe(true);
    expect(firstRequest.isCurrent()).toBe(false);
    expect(secondRequest.signal.aborted).toBe(false);
    expect(secondRequest.isCurrent()).toBe(true);
    await act(async () => {
      newer.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 42 }));
      await newer.promise;
      older.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 30 }));
      await older.promise;
    });
  });

  it('reverts a failed newer draft to the last signed mapping, not an older in-flight draft', async () => {
    const user = userEvent.setup();
    const older = deferred<PeopleSyncReview>();
    const newer = deferred<PeopleSyncReview>();
    const onPreviewCorrections = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    render(<TableHarness onPreviewCorrections={onPreviewCorrections} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));

    await user.click(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Replacement Local' }));

    await user.click(within(desktopRow('ext-established')).getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Alternative Local' }));
    newer.reject(new Error('newest preview failed'));

    await user.click(await screen.findByRole('button', { name: 'Revert correction' }));
    expect(screen.getByTestId('correction-state')).toHaveTextContent('{}');

    older.resolve(correctionPreview({ outcome: 'relink', fromIndividualId: 40, individualId: 30 }));
    await waitFor(() => expect(screen.queryByText('Refreshing correction preview…')).not.toBeInTheDocument());
    expect(screen.getByTestId('correction-state')).toHaveTextContent('{}');
  });

  it('invalidates an in-flight correction when the parent replaces the base review', async () => {
    const user = userEvent.setup();
    const pending = deferred<PeopleSyncReview>();
    render(<RefreshableTableHarness onPreviewCorrections={() => pending.promise} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));
    await user.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink and review again' }));

    await user.click(screen.getByRole('button', { name: 'Replace base review' }));
    await act(async () => {
      pending.resolve(correctionPreview({ outcome: 'unlink', fromIndividualId: 40 }));
      await pending.promise;
    });

    expect(screen.getByTestId('refreshable-correction-state')).toHaveTextContent('{}');
    expect(screen.queryByText('Refreshing correction preview…')).not.toBeInTheDocument();
  });

  it('clears correction errors when the parent replaces the base review', async () => {
    const user = userEvent.setup();
    const pending = deferred<PeopleSyncReview>();
    render(<RefreshableTableHarness onPreviewCorrections={() => pending.promise} />);
    await user.click(screen.getByRole('tab', { name: 'Already linked 1' }));
    await user.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink and review again' }));
    pending.reject(new Error('preview failed'));
    expect(await screen.findByRole('alert')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Replace base review' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revert correction' })).not.toBeInTheDocument();
  });

  it('reflects parent-owned preview loading even before a local request is started', () => {
    render(<TableHarness previewing />);

    expect(screen.getByText('Refreshing correction preview…')).toBeVisible();
  });
});
