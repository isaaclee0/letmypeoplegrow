import { personDisplayName } from './PersonIdentitySummary';
import { buildSyncSelections, type SyncSelectionState } from './syncSelections';
import type {
  EstablishedLinkCorrection,
  IdentityDecision,
  IdentityReviewEntry,
  PeopleSyncFamilyDisplay,
  PeopleSyncPersonDisplay,
  PeopleSyncPeopleDirectory,
  PeopleSyncReview,
  PeopleSyncReviewContext,
} from './types';

export type ReviewRowStatus =
  | 'needs_attention'
  | 'matched'
  | 'adding'
  | 'skipped'
  | 'established'
  | 'corrected';

export type ReviewRowFilter = 'all' | 'needs_attention' | 'matched' | 'adding' | 'skipped';

export const DEFAULT_REVIEW_PAGE_SIZE = 50;

export interface ReviewRowCriteria {
  query: string;
  filter: ReviewRowFilter;
}

export interface ReviewIdentityRow {
  externalId: string;
  status: ReviewRowStatus;
  decision: IdentityDecision | null;
  correction?: EstablishedLinkCorrection;
  localIndividualId: number | null;
  localLabel: string;
  externalPerson?: PeopleSyncPersonDisplay;
  externalFamily?: PeopleSyncFamilyDisplay;
  localPerson?: PeopleSyncPersonDisplay;
  localFamily?: PeopleSyncFamilyDisplay;
}

function directoryFor(review: PeopleSyncReview): PeopleSyncPeopleDirectory {
  return review.plan.people || { external: {}, local: {} };
}

function personFor(directory: PeopleSyncPeopleDirectory, scope: 'external' | 'local', id: string | number) {
  return directory[scope][String(id)];
}

function localDetails(directory: PeopleSyncPeopleDirectory, individualId: number | null, fallback: string) {
  const localPerson = individualId === null ? undefined : personFor(directory, 'local', individualId);
  return {
    localIndividualId: individualId,
    localPerson,
    localFamily: localPerson?.family,
    localLabel: localPerson ? personDisplayName(localPerson) : fallback,
  };
}

function targetForDecision(entry: IdentityReviewEntry, decision: IdentityDecision | null | undefined): number | null {
  if (decision?.outcome === 'accept') return entry.suggestedIndividualId;
  if (decision?.outcome === 'link') return decision.individualId;
  return null;
}

function statusForDecision(decision: IdentityDecision | null | undefined): ReviewRowStatus {
  if (!decision) return 'needs_attention';
  if (decision.outcome === 'accept' || decision.outcome === 'link') return 'matched';
  if (decision.outcome === 'create') return 'adding';
  return 'skipped';
}

function familySortName(row: ReviewIdentityRow): string {
  if (row.externalFamily?.state === 'known' && row.externalFamily.name.trim()) {
    return row.externalFamily.name;
  }
  return row.externalPerson?.lastName || '';
}

function compareReviewRowsByFamily(left: ReviewIdentityRow, right: ReviewIdentityRow): number {
  const compare = (leftValue: string, rightValue: string) =>
    leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' });
  return compare(familySortName(left), familySortName(right))
    || compare(left.externalPerson?.lastName || '', right.externalPerson?.lastName || '')
    || compare(left.externalPerson?.firstName || '', right.externalPerson?.firstName || '')
    || left.externalId.localeCompare(right.externalId);
}

export function buildDecisionRows(review: PeopleSyncReview, state: SyncSelectionState): ReviewIdentityRow[] {
  const context = review.plan.reviewContext;
  if (!context || review.decisionContractVersion !== 2) return [];

  const directory = directoryFor(review);
  const establishedIds = new Set(Object.keys(context.establishedLinks || {}));
  return Object.keys(context.identities)
    .filter((externalId) => !establishedIds.has(externalId))
    .map((externalId) => {
      const entry = context.identities[externalId];
      const decision = state.identityDecisions?.[externalId] ?? null;
      const status = statusForDecision(decision);
      const target = targetForDecision(entry, decision);
      const fallback = status === 'adding'
        ? 'Add new person'
        : status === 'skipped'
          ? 'Skipped for now'
          : status === 'needs_attention'
            ? 'Choose a decision'
            : 'Name unavailable';
      const externalPerson = personFor(directory, 'external', externalId);
      return {
        externalId,
        status,
        decision,
        externalPerson,
        externalFamily: externalPerson?.family,
        ...localDetails(directory, target, fallback),
      };
    })
    .sort(compareReviewRowsByFamily);
}

export function buildEstablishedRows(review: PeopleSyncReview, state: SyncSelectionState): ReviewIdentityRow[] {
  const context = review.plan.reviewContext;
  if (!context || review.decisionContractVersion !== 2) return [];

  const directory = directoryFor(review);
  return Object.keys(context.establishedLinks || {})
    .map((externalId) => {
      const established = context.establishedLinks?.[externalId];
      const correction = state.linkCorrections?.[externalId];
      const localIndividualId = correction?.outcome === 'unlink'
        ? null
        : correction?.outcome === 'relink'
          ? correction.individualId
          : established?.individualId ?? null;
      const externalPerson = personFor(directory, 'external', externalId);
      return {
        externalId,
        status: correction ? 'corrected' : 'established',
        decision: null,
        correction,
        externalPerson,
        externalFamily: externalPerson?.family,
        ...localDetails(directory, localIndividualId, correction?.outcome === 'unlink' ? 'Skipped for now' : 'Name unavailable'),
      };
    })
    .sort(compareReviewRowsByFamily);
}

export function editLinkCorrectionDraft(
  previous: Record<string, EstablishedLinkCorrection>,
  externalId: string,
  originalIndividualId: number,
  correction: EstablishedLinkCorrection | null,
): Record<string, EstablishedLinkCorrection> {
  const next = { ...previous };
  if (correction === null ||
      (correction.outcome === 'relink' && correction.individualId === originalIndividualId)) {
    delete next[externalId];
  } else {
    next[externalId] = correction;
  }
  return Object.fromEntries(
    Object.entries(next).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function searchableIdentityText(value: PeopleSyncPersonDisplay | PeopleSyncFamilyDisplay | undefined): string[] {
  if (!value) return [];
  if ('firstName' in value) return [personDisplayName(value)];
  if (value.state !== 'known') return [];
  return [value.name, ...value.members.map(personDisplayName)];
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase();
}

export function normalizedSearchText(row: ReviewIdentityRow): string {
  return [row.externalPerson, row.externalFamily, row.localPerson, row.localFamily]
    .flatMap(searchableIdentityText)
    .join(' ')
    .normalize('NFKD')
    .toLocaleLowerCase();
}

export function filterReviewRows(
  rows: ReviewIdentityRow[],
  query: string,
  filter: ReviewRowFilter,
): ReviewIdentityRow[] {
  const search = normalizeSearch(query.trim());
  return rows.filter((row) =>
    (filter === 'all' || row.status === filter)
    && (!search || normalizedSearchText(row).includes(search))
  );
}

export function pageAfterReviewCriteriaChange(
  currentPage: number,
  previous: ReviewRowCriteria,
  next: ReviewRowCriteria,
): number {
  return previous.query === next.query && previous.filter === next.filter ? currentPage : 1;
}

export function paginateReviewRows<T>(rows: T[], page: number, pageSize: number) {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 1;
  const totalPages = Math.max(1, Math.ceil(rows.length / safePageSize));
  const requestedPage = Number.isFinite(page) ? Math.floor(page) : 1;
  const safePage = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (safePage - 1) * safePageSize;
  return { rows: rows.slice(start, start + safePageSize), page: safePage, totalPages };
}

function isValidDecision(entry: IdentityReviewEntry, manualCandidateIds: Set<number>, decision: IdentityDecision | null | undefined): boolean {
  if (!decision) return false;
  if (decision.outcome === 'accept') return entry.suggestedIndividualId !== null;
  if (decision.outcome === 'link') {
    return manualCandidateIds.has(decision.individualId)
      && (decision.excludeIndividualId === undefined
        || (entry.candidateIndividualIds.includes(decision.excludeIndividualId)
          && decision.excludeIndividualId !== decision.individualId));
  }
  if (decision.outcome === 'create') {
    return entry.canCreate && entry.createPerson !== null
      && (decision.excludeIndividualId === undefined || entry.candidateIndividualIds.includes(decision.excludeIndividualId));
  }
  return decision.excludeIndividualId === undefined || entry.candidateIndividualIds.includes(decision.excludeIndividualId);
}

function signedCorrections(corrections: PeopleSyncReviewContext['linkCorrections']) {
  const entries: Array<[string, EstablishedLinkCorrection]> = [];
  for (const correction of corrections || []) {
    if (correction.outcome === 'relink') {
      entries.push([correction.externalPersonId, {
        outcome: 'relink',
        fromIndividualId: correction.fromIndividualId,
        individualId: correction.individualId,
      }]);
    } else {
      entries.push([correction.externalPersonId, {
        outcome: 'unlink',
        fromIndividualId: correction.fromIndividualId,
      }]);
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function mergeSelectionsForPreview(previous: SyncSelectionState, nextReview: PeopleSyncReview): SyncSelectionState {
  const context = nextReview.plan.reviewContext;
  if (!context || nextReview.decisionContractVersion !== 2) return previous;

  const manualCandidateIds = new Set(context.manualCandidateIndividualIds);
  const identityDecisions = Object.fromEntries(Object.keys(context.identities)
    .sort((left, right) => left.localeCompare(right))
    .map((externalId) => {
      const decision = previous.identityDecisions?.[externalId] ?? null;
      return [externalId, isValidDecision(context.identities[externalId], manualCandidateIds, decision) ? decision : null];
    }));
  const permittedArchiveIds = new Set([
    ...nextReview.plan.archive.map((action) => action.individualId),
    ...nextReview.plan.unmatchedLocalRegulars.map((action) => action.individualId),
    ...nextReview.plan.ambiguousPeople.flatMap((action) => action.candidateIndividualIds),
  ]);
  const permittedRenameIds = new Set(nextReview.plan.renameFamily.map((action) => action.id));
  return {
    ...previous,
    identityDecisions,
    linkCorrections: signedCorrections(context.linkCorrections),
    acceptedArchiveIds: new Set([...previous.acceptedArchiveIds].filter((id) => permittedArchiveIds.has(id))),
    acceptedFamilyRenameIds: new Set([...previous.acceptedFamilyRenameIds].filter((id) => permittedRenameIds.has(id))),
  };
}

export function isReviewDirty(initial: SyncSelectionState, current: SyncSelectionState): boolean {
  return JSON.stringify(buildSyncSelections(initial)) !== JSON.stringify(buildSyncSelections(current));
}

export function selectedChangeCount(review: PeopleSyncReview, state: SyncSelectionState): number {
  const identityIds = new Set(Object.keys(review.plan.reviewContext?.identities || {}));
  const identityCount = Object.entries(state.identityDecisions || {})
    .filter(([externalId, decision]) => identityIds.has(externalId) && decision !== null).length;
  return identityCount
    + Object.keys(state.linkCorrections || {}).length
    + state.acceptedArchiveIds.size
    + state.acceptedFamilyRenameIds.size;
}
