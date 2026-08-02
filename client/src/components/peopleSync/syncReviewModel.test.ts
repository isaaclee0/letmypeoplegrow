import { describe, expect, it } from 'vitest';
import type { SyncSelectionState } from './syncSelections';
import {
  buildDecisionRows,
  buildEstablishedRows,
  DEFAULT_REVIEW_PAGE_SIZE,
  filterReviewRows,
  isReviewDirty,
  mergeSelectionsForPreview,
  paginateReviewRows,
  pageAfterReviewCriteriaChange,
  selectedChangeCount,
} from './syncReviewModel';
import type { PeopleSyncPlan, PeopleSyncPlanSummary, PeopleSyncReview } from './types';

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

function stateWith(overrides: Partial<SyncSelectionState> = {}): SyncSelectionState {
  const identityDecisions: NonNullable<SyncSelectionState['identityDecisions']> = {};
  for (let index = 1; index <= 55; index += 1) {
    const id = `ext-${String(index).padStart(2, '0')}`;
    identityDecisions[id] = index === 1
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
    ...overrides,
  };
}

function reviewWith55Identities(): PeopleSyncReview {
  const external = Object.fromEntries(Array.from({ length: 55 }, (_, offset) => {
    const index = offset + 1;
    const id = `ext-${String(index).padStart(2, '0')}`;
    return [id, {
      firstName: index === 1 ? 'Provider' : `Provider${index}`,
      lastName: index === 1 ? 'One' : 'Person',
      family: index === 1
        ? {
          state: 'known' as const,
          name: 'Source Household',
          members: [{ firstName: 'Source', lastName: 'Sibling' }],
          totalOtherMembers: 1,
        }
        : { state: 'none' as const },
    }];
  }));
  external['ext-established'] = {
    firstName: 'Established', lastName: 'Provider', family: { state: 'none' },
  };

  const identities = Object.fromEntries(Array.from({ length: 55 }, (_, offset) => {
    const index = offset + 1;
    const id = `ext-${String(index).padStart(2, '0')}`;
    return [id, {
      suggestedIndividualId: index === 1 ? 10 : null,
      candidateIndividualIds: index === 4 ? [10] : [],
      excludedIndividualIds: [],
      held: index === 3,
      canCreate: true,
      createPerson: { firstName: `Created${index}`, lastName: 'Person', isChild: false, externalFamilyId: null, peopleType: 'regular' as const },
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
        '10': { firstName: 'Matched', lastName: 'Local', family: { state: 'none' } },
        '20': {
          firstName: 'Search', lastName: 'Local',
          family: {
            state: 'known', name: 'Local Family',
            members: [{ firstName: 'Family', lastName: 'Member' }], totalOtherMembers: 1,
          },
        },
        '30': { firstName: 'Projected', lastName: 'Target', family: { state: 'none' } },
        '40': { firstName: 'Current', lastName: 'Link', family: { state: 'none' } },
      },
    },
    reviewContext: {
      version: 2,
      correctionContractVersion: 1,
      manualCandidateIndividualIds: [10, 20, 30],
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

describe('review identity row model', () => {
  it('assigns decision status from each selected identity outcome', () => {
    const rows = buildDecisionRows(reviewWith55Identities(), stateWith());

    expect(rows.find((row) => row.externalId === 'ext-01')).toMatchObject({ status: 'matched', localIndividualId: 10 });
    expect(rows.find((row) => row.externalId === 'ext-02')).toMatchObject({ status: 'adding', localLabel: 'Add new person' });
    expect(rows.find((row) => row.externalId === 'ext-03')).toMatchObject({ status: 'needs_attention' });
    expect(rows.find((row) => row.externalId === 'ext-04')).toMatchObject({ status: 'skipped', localLabel: 'Skipped for now' });
  });

  it('keeps source-visible established links out of the decision rows', () => {
    const review = reviewWith55Identities();
    const decisions = buildDecisionRows(review, stateWith());
    const established = buildEstablishedRows(review, stateWith());

    expect(decisions).toHaveLength(55);
    expect(decisions.some((row) => row.externalId === 'ext-established')).toBe(false);
    expect(established.map((row) => row.externalId)).toEqual(['ext-established']);
  });

  it('shows the signed projected target for a relink and a skip label for an unlink', () => {
    const review = reviewWith55Identities();
    const relinked = buildEstablishedRows(review, stateWith({
      linkCorrections: {
        'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
      },
    }));
    const unlinked = buildEstablishedRows(review, stateWith({
      linkCorrections: {
        'ext-established': { outcome: 'unlink', fromIndividualId: 40 },
      },
    }));

    expect(relinked[0]).toMatchObject({ status: 'corrected', localIndividualId: 30, localLabel: 'Projected Target' });
    expect(unlinked[0]).toMatchObject({ status: 'corrected', localIndividualId: null, localLabel: 'Skipped for now' });
  });

  it.each([
    ['provider person', 'provider one', 'ext-01'],
    ['provider household member', 'source sibling', 'ext-01'],
    ['LMPG person', 'search local', 'ext-05'],
    ['LMPG family member', 'family member', 'ext-05'],
  ])('searches the %s across complete identity context', (_label, query, externalId) => {
    const rows = buildDecisionRows(reviewWith55Identities(), stateWith());

    expect(filterReviewRows(rows, query, 'all').map((row) => row.externalId)).toContain(externalId);
  });

  it('filters statuses before pagination and exposes complete filter counts', () => {
    const rows = buildDecisionRows(reviewWith55Identities(), stateWith());
    const adding = filterReviewRows(rows, '', 'adding');

    expect(filterReviewRows(rows, '', 'needs_attention')).toHaveLength(1);
    expect(filterReviewRows(rows, '', 'matched')).toHaveLength(2);
    expect(adding).toHaveLength(51);
    expect(filterReviewRows(rows, '', 'skipped')).toHaveLength(1);
    expect(paginateReviewRows(adding, 1, 50).rows).toHaveLength(50);
  });

  it('paginates at the exported fifty-row default and resets a changed filter to page one', () => {
    const rows = buildDecisionRows(reviewWith55Identities(), stateWith());
    const adding = filterReviewRows(rows, '', 'adding');
    const resetPage = pageAfterReviewCriteriaChange(
      2,
      { query: '', filter: 'all' },
      { query: '', filter: 'adding' },
    );
    const searchResetPage = pageAfterReviewCriteriaChange(
      2,
      { query: '', filter: 'all' },
      { query: 'provider', filter: 'all' },
    );

    expect(DEFAULT_REVIEW_PAGE_SIZE).toBe(50);
    expect(paginateReviewRows(rows, 1, DEFAULT_REVIEW_PAGE_SIZE)).toMatchObject({ page: 1, totalPages: 2, rows: expect.any(Array) });
    expect(paginateReviewRows(rows, 1, DEFAULT_REVIEW_PAGE_SIZE).rows).toHaveLength(DEFAULT_REVIEW_PAGE_SIZE);
    expect(paginateReviewRows(rows, 2, DEFAULT_REVIEW_PAGE_SIZE).rows).toHaveLength(5);
    expect(resetPage).toBe(1);
    expect(searchResetPage).toBe(1);
    expect(paginateReviewRows(adding, resetPage, DEFAULT_REVIEW_PAGE_SIZE).rows).toHaveLength(DEFAULT_REVIEW_PAGE_SIZE);
    expect(paginateReviewRows(filterReviewRows(rows, 'provider one', 'all'), 2, DEFAULT_REVIEW_PAGE_SIZE)).toMatchObject({ page: 1, totalPages: 1 });
  });

  it('retains only decisions that are valid in the corrected signed context', () => {
    const previous = stateWith({
      identityDecisions: {
        'ext-01': { outcome: 'accept' },
        'ext-02': { outcome: 'create' },
        'ext-04': { outcome: 'defer', excludeIndividualId: 10 },
      },
      linkCorrections: { 'ext-established': { outcome: 'unlink', fromIndividualId: 40 } },
    });
    const nextReview = reviewWith55Identities();
    nextReview.plan.reviewContext!.identities['ext-02'] = {
      ...nextReview.plan.reviewContext!.identities['ext-02'], canCreate: false, createPerson: null,
    };
    nextReview.plan.reviewContext!.identities['ext-04'] = {
      ...nextReview.plan.reviewContext!.identities['ext-04'], candidateIndividualIds: [],
    };

    const merged = mergeSelectionsForPreview(previous, nextReview);

    expect(merged.identityDecisions).toMatchObject({
      'ext-01': { outcome: 'accept' },
      'ext-02': null,
      'ext-04': null,
    });
    expect(merged.linkCorrections).toEqual({});
  });

  it('retains only canonical corrections signed by the next preview', () => {
    const previous = stateWith({
      linkCorrections: {
        'ext-stale': { outcome: 'unlink', fromIndividualId: 99 },
        'ext-established': { outcome: 'unlink', fromIndividualId: 40 },
      },
    });
    const nextReview = reviewWith55Identities();
    nextReview.plan.reviewContext!.linkCorrections = [{
      externalPersonId: 'ext-established', outcome: 'relink', fromIndividualId: 40, individualId: 30,
    }];

    expect(mergeSelectionsForPreview(previous, nextReview).linkCorrections).toEqual({
      'ext-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
    });
  });

  it('compares only selectable review state and counts current selected outcomes', () => {
    const initial = stateWith({ identityDecisions: { 'ext-01': { outcome: 'accept' } } });
    const navigated = { ...initial, query: 'provider', page: 2 };
    const selected = stateWith({
      identityDecisions: {
        'ext-01': { outcome: 'accept' },
        'ext-02': { outcome: 'create' },
        'ext-03': { outcome: 'defer' },
      },
      linkCorrections: { 'ext-established': { outcome: 'unlink', fromIndividualId: 40 } },
      acceptedArchiveIds: new Set([88]),
      acceptedFamilyRenameIds: new Set(['renameFamily:99']),
    });

    expect(isReviewDirty(initial, navigated)).toBe(false);
    expect(isReviewDirty(initial, selected)).toBe(true);
    expect(selectedChangeCount(reviewWith55Identities(), selected)).toBe(6);
  });
});
