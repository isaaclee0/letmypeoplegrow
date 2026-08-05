import React, {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import EstablishedLinkDialog from './EstablishedLinkDialog';
import IdentityRemovalDialog from './IdentityRemovalDialog';
import PeoplePickerDialog from './PeoplePickerDialog';
import { FamilyContext, personDisplayName } from './PersonIdentitySummary';
import { isRefreshOnlyReviewError } from './apiError';
import type { SyncSelectionState } from './syncSelections';
import {
  buildDecisionRows,
  buildEstablishedRows,
  DEFAULT_REVIEW_PAGE_SIZE,
  editLinkCorrectionDraft,
  filterReviewRows,
  mergeSelectionsForPreview,
  paginateReviewRows,
  type ReviewIdentityRow,
  type ReviewRowFilter,
  type ReviewRowStatus,
} from './syncReviewModel';
import type {
  EstablishedLinkCorrection,
  IdentityDecision,
  PeopleSyncEstablishedLink,
  PeopleSyncFamilyDisplay,
  PeopleSyncReview,
} from './types';

type IdentityTab = 'decisions' | 'established';

export interface IdentityReviewTableHandle {
  focusExternalId: (externalId: string) => void;
}

export interface CorrectionPreviewRequestContext {
  generation: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface IdentityReviewTableProps {
  review: PeopleSyncReview;
  state: SyncSelectionState;
  onStateChange: (state: SyncSelectionState) => void;
  onPreviewCorrections: (
    corrections: Record<string, EstablishedLinkCorrection>,
    request: CorrectionPreviewRequestContext,
  ) => Promise<PeopleSyncReview>;
  onRefreshReview?: () => void | Promise<void>;
  onPreviewCancelled?: () => void;
  previewing: boolean;
}

interface CorrectionFailure {
  externalId: string;
  attemptedCorrections: Record<string, EstablishedLinkCorrection>;
  previousCorrections: Record<string, EstablishedLinkCorrection>;
  cause: unknown;
}

const filterOptions: Array<{ value: ReviewRowFilter; label: string; status?: ReviewRowStatus }> = [
  { value: 'all', label: 'All' },
  { value: 'needs_attention', label: 'Needs attention', status: 'needs_attention' },
  { value: 'matched', label: 'Matched', status: 'matched' },
  { value: 'adding', label: 'Adding', status: 'adding' },
  { value: 'skipped', label: 'Skipped', status: 'skipped' },
];

const rowStatusLabels: Record<ReviewRowStatus, string> = {
  needs_attention: 'Needs attention',
  matched: 'Matched',
  adding: 'Adding',
  skipped: 'Skipped',
  established: 'Already linked',
  corrected: 'Correction drafted',
};

function selectedIndividualId(row: ReviewIdentityRow): number | null {
  return row.localIndividualId;
}

function localFamilyFor(row: ReviewIdentityRow): PeopleSyncFamilyDisplay | undefined {
  if (row.localPerson) return row.localFamily;
  if (row.status === 'adding' || row.status === 'skipped' || row.status === 'corrected') {
    return { state: 'none' };
  }
  return undefined;
}

function pageRange(page: number, pageSize: number, count: number): string {
  if (count === 0) return 'Showing 0 of 0';
  const first = ((page - 1) * pageSize) + 1;
  const last = Math.min(count, page * pageSize);
  return `Showing ${first}–${last} of ${count}`;
}

function copyCorrections(
  corrections: Record<string, EstablishedLinkCorrection> | undefined,
): Record<string, EstablishedLinkCorrection> {
  return { ...(corrections || {}) };
}

function signedCorrectionsForReview(review: PeopleSyncReview): Record<string, EstablishedLinkCorrection> {
  return Object.fromEntries((review.plan.reviewContext?.linkCorrections || []).map((correction) => {
    const { externalPersonId, ...value } = correction;
    return [externalPersonId, value];
  }));
}

function desktopLayoutMatches(): boolean {
  return typeof window.matchMedia !== 'function'
    || window.matchMedia('(min-width: 768px)').matches;
}

function correctionDraftHasEstablishedCollision(
  establishedLinks: Record<string, PeopleSyncEstablishedLink> | undefined,
  corrections: Record<string, EstablishedLinkCorrection>,
): boolean {
  const claimed = new Set<number>();
  for (const [externalId, established] of Object.entries(establishedLinks || {})) {
    const correction = corrections[externalId];
    if (correction?.outcome === 'unlink') continue;
    const target = correction?.outcome === 'relink'
      ? correction.individualId
      : established.individualId;
    if (claimed.has(target)) return true;
    claimed.add(target);
  }
  return false;
}

const IdentityReviewTable = forwardRef<IdentityReviewTableHandle, IdentityReviewTableProps>(function IdentityReviewTable({
  review,
  state,
  onStateChange,
  onPreviewCorrections,
  onRefreshReview,
  onPreviewCancelled,
  previewing,
}, ref) {
  const [activeTab, setActiveTab] = useState<IdentityTab>('decisions');
  const [queries, setQueries] = useState<Record<IdentityTab, string>>({ decisions: '', established: '' });
  const [filter, setFilter] = useState<ReviewRowFilter>('all');
  const [pages, setPages] = useState<Record<IdentityTab, number>>({ decisions: 1, established: 1 });
  const [pageSize, setPageSize] = useState(DEFAULT_REVIEW_PAGE_SIZE);
  const [pickerExternalId, setPickerExternalId] = useState<string | null>(null);
  const [removalExternalId, setRemovalExternalId] = useState<string | null>(null);
  const [establishedExternalId, setEstablishedExternalId] = useState<string | null>(null);
  const [localPreviewing, setLocalPreviewing] = useState(false);
  const [correctionFailure, setCorrectionFailure] = useState<CorrectionFailure | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [desktopLayout, setDesktopLayout] = useState(desktopLayoutMatches);
  const tabGroupId = useId();
  const stateRef = useRef(state);
  const previewGenerationRef = useRef(0);
  const previewControllerRef = useRef<AbortController | null>(null);
  const baseRunIdRef = useRef(review.runId);
  const signedCorrectionsRef = useRef(signedCorrectionsForReview(review));
  const desktopFocusRefs = useRef(new Map<string, HTMLButtonElement>());
  const mobileFocusRefs = useRef(new Map<string, HTMLButtonElement>());
  const decisionsTabRef = useRef<HTMLButtonElement>(null);
  const establishedTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    signedCorrectionsRef.current = signedCorrectionsForReview(review);
  }, [review.reviewToken]);

  useEffect(() => () => {
    previewGenerationRef.current += 1;
    previewControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (baseRunIdRef.current === review.runId) return;
    baseRunIdRef.current = review.runId;
    previewGenerationRef.current += 1;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    signedCorrectionsRef.current = signedCorrectionsForReview(review);
    setLocalPreviewing(false);
    setCorrectionFailure(null);
    setPickerExternalId(null);
    setRemovalExternalId(null);
    setEstablishedExternalId(null);
  }, [review]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(min-width: 768px)');
    const updateLayout = (event: MediaQueryListEvent) => setDesktopLayout(event.matches);
    media.addEventListener('change', updateLayout);
    return () => media.removeEventListener('change', updateLayout);
  }, []);

  const decisionRows = useMemo(() => buildDecisionRows(review, state), [review, state]);
  const establishedRows = useMemo(() => buildEstablishedRows(review, state), [review, state]);
  const query = queries[activeTab];
  const filteredRows = useMemo(
    () => activeTab === 'decisions'
      ? filterReviewRows(decisionRows, query, filter)
      : filterReviewRows(establishedRows, query, 'all'),
    [activeTab, decisionRows, establishedRows, filter, query],
  );
  const pagination = paginateReviewRows(filteredRows, pages[activeTab], pageSize);
  const visibleRows = pagination.rows;

  const filterCounts = useMemo(() => Object.fromEntries(filterOptions.map((option) => [
    option.value,
    option.status
      ? decisionRows.filter((row) => row.status === option.status).length
      : decisionRows.length,
  ])) as Record<ReviewRowFilter, number>, [decisionRows]);

  const availableIndividualIds = useMemo(
    () => new Set(review.plan.reviewContext?.manualCandidateIndividualIds || []),
    [review],
  );
  const claimedBy = useMemo(() => {
    const claims = new Map<number, string>();
    for (const row of [...decisionRows, ...establishedRows]) {
      if (row.localIndividualId !== null) claims.set(row.localIndividualId, row.externalId);
    }
    return claims;
  }, [decisionRows, establishedRows]);
  const directory = review.plan.people || { external: {}, local: {} };
  const reviewContext = review.plan.reviewContext;
  const correctableClaimByIndividualId = useMemo(() => {
    const claims = new Map<number, string>();
    for (const [externalId, established] of Object.entries(reviewContext?.establishedLinks || {})) {
      claims.set(established.individualId, externalId);
    }
    for (const [externalId, established] of Object.entries(reviewContext?.projectedEstablishedLinks || {})) {
      claims.set(established.individualId, externalId);
    }
    return claims;
  }, [reviewContext]);

  const commitState = (nextState: SyncSelectionState) => {
    stateRef.current = nextState;
    onStateChange(nextState);
  };

  const setDecision = (externalId: string, decision: IdentityDecision) => {
    const latest = stateRef.current;
    commitState({
      ...latest,
      identityDecisions: { ...(latest.identityDecisions || {}), [externalId]: decision },
    });
  };

  const runCorrectionPreview = async (
    externalId: string,
    attemptedCorrections: Record<string, EstablishedLinkCorrection>,
    previousCorrections: Record<string, EstablishedLinkCorrection>,
  ) => {
    previewControllerRef.current?.abort();
    const controller = new AbortController();
    previewControllerRef.current = controller;
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    const request: CorrectionPreviewRequestContext = {
      generation,
      signal: controller.signal,
      isCurrent: () => previewGenerationRef.current === generation && !controller.signal.aborted,
    };
    setCorrectionFailure(null);
    setLocalPreviewing(true);
    try {
      const nextReview = await onPreviewCorrections(attemptedCorrections, request);
      if (!request.isCurrent()) return;
      const latest = stateRef.current;
      const merged = mergeSelectionsForPreview({
        ...latest,
        linkCorrections: attemptedCorrections,
      }, nextReview);
      signedCorrectionsRef.current = copyCorrections(merged.linkCorrections);
      commitState(merged);
      previewControllerRef.current = null;
      setCorrectionFailure(null);
      setLocalPreviewing(false);
    } catch (cause) {
      if (!request.isCurrent()) return;
      previewControllerRef.current = null;
      setLocalPreviewing(false);
      setCorrectionFailure({ externalId, attemptedCorrections, previousCorrections, cause });
    }
  };

  const cancelCorrectionPreview = () => {
    const hadPreview = previewControllerRef.current !== null;
    previewGenerationRef.current += 1;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    setLocalPreviewing(false);
    if (hadPreview) onPreviewCancelled?.();
  };

  const commitCorrection = (
    externalId: string,
    originalIndividualId: number,
    correction: EstablishedLinkCorrection | null,
  ) => {
    const latest = stateRef.current;
    const previousCorrections = copyCorrections(signedCorrectionsRef.current);
    const attemptedCorrections = editLinkCorrectionDraft(
      copyCorrections(latest.linkCorrections),
      externalId,
      originalIndividualId,
      correction,
    );
    commitState({ ...latest, linkCorrections: attemptedCorrections });
    if (correctionDraftHasEstablishedCollision(reviewContext?.establishedLinks, attemptedCorrections)) {
      cancelCorrectionPreview();
      setCorrectionFailure(null);
      return;
    }
    void runCorrectionPreview(externalId, attemptedCorrections, previousCorrections);
  };

  const retryCorrectionPreview = () => {
    if (!correctionFailure) return;
    void runCorrectionPreview(
      correctionFailure.externalId,
      correctionFailure.attemptedCorrections,
      correctionFailure.previousCorrections,
    );
  };

  const revertCorrection = () => {
    if (!correctionFailure) return;
    previewGenerationRef.current += 1;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    setLocalPreviewing(false);
    const latest = stateRef.current;
    commitState({ ...latest, linkCorrections: correctionFailure.previousCorrections });
    setCorrectionFailure(null);
  };

  const focusExternalId = (externalId: string) => {
    const decisionIndex = decisionRows.findIndex((row) => row.externalId === externalId);
    const targetTab: IdentityTab = decisionIndex >= 0 ? 'decisions' : 'established';
    const targetRows = targetTab === 'decisions' ? decisionRows : establishedRows;
    const targetIndex = targetTab === 'decisions'
      ? decisionIndex
      : targetRows.findIndex((row) => row.externalId === externalId);
    if (targetIndex < 0) return;
    setActiveTab(targetTab);
    setQueries((current) => ({ ...current, [targetTab]: '' }));
    if (targetTab === 'decisions') setFilter('all');
    setPages((current) => ({ ...current, [targetTab]: Math.floor(targetIndex / pageSize) + 1 }));
    setPendingFocusId(externalId);
  };

  useImperativeHandle(ref, () => ({ focusExternalId }), [decisionRows, establishedRows, pageSize]);

  useEffect(() => {
    if (!pendingFocusId) return;
    const useDesktop = typeof window.matchMedia !== 'function'
      || window.matchMedia('(min-width: 768px)').matches;
    const preferred = useDesktop ? desktopFocusRefs.current : mobileFocusRefs.current;
    const fallback = useDesktop ? mobileFocusRefs.current : desktopFocusRefs.current;
    const target = preferred.get(pendingFocusId) || fallback.get(pendingFocusId);
    if (!target) return;
    target.focus();
    setPendingFocusId(null);
  }, [activeTab, filter, pageSize, pages, pendingFocusId, queries, visibleRows]);

  const changeTab = (tab: IdentityTab) => {
    setActiveTab(tab);
    setPickerExternalId(null);
    setRemovalExternalId(null);
    setEstablishedExternalId(null);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextTab: IdentityTab = event.key === 'Home'
      ? 'decisions'
      : event.key === 'End'
        ? 'established'
        : activeTab === 'decisions' ? 'established' : 'decisions';
    changeTab(nextTab);
    (nextTab === 'decisions' ? decisionsTabRef : establishedTabRef).current?.focus();
  };

  const changeQuery = (nextQuery: string) => {
    const decisionMatches = filterReviewRows(decisionRows, nextQuery, filter);
    const establishedMatches = filterReviewRows(establishedRows, nextQuery, 'all');
    const otherTab: IdentityTab = activeTab === 'decisions' ? 'established' : 'decisions';
    const activeMatches = activeTab === 'decisions' ? decisionMatches : establishedMatches;
    const otherMatches = otherTab === 'decisions' ? decisionMatches : establishedMatches;

    setQueries({ decisions: nextQuery, established: nextQuery });
    setPages({ decisions: 1, established: 1 });
    if (activeMatches.length === 0 && otherMatches.length > 0) setActiveTab(otherTab);
  };

  const changeFilter = (nextFilter: ReviewRowFilter) => {
    setFilter(nextFilter);
    setPages((current) => ({ ...current, decisions: 1 }));
  };

  const movePage = (nextPage: number) => {
    setPages((current) => ({ ...current, [activeTab]: nextPage }));
  };

  const openPrimaryAction = (row: ReviewIdentityRow) => {
    if (activeTab === 'decisions') setPickerExternalId(row.externalId);
    else setEstablishedExternalId(row.externalId);
  };

  const openRowAction = (row: ReviewIdentityRow) => {
    if (activeTab === 'decisions') setRemovalExternalId(row.externalId);
    else setEstablishedExternalId(row.externalId);
  };

  const setFocusRef = (
    map: React.MutableRefObject<Map<string, HTMLButtonElement>>,
    externalId: string,
    element: HTMLButtonElement | null,
  ) => {
    if (element) map.current.set(externalId, element);
    else map.current.delete(externalId);
  };

  const primaryButton = (row: ReviewIdentityRow, mobile: boolean) => {
    const externalName = personDisplayName(row.externalPerson);
    const label = activeTab === 'decisions'
      ? `Change LMPG match for ${externalName}`
      : `Correct linked person for ${externalName}`;
    const map = mobile ? mobileFocusRefs : desktopFocusRefs;
    return (
      <button
        ref={(element) => setFocusRef(map, row.externalId, element)}
        type="button"
        aria-label={label}
        onClick={() => openPrimaryAction(row)}
        className="max-w-full rounded-md text-left font-semibold text-primary-700 underline decoration-primary-300 underline-offset-2 hover:text-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-primary-300 dark:hover:text-primary-200"
      >
        {row.localLabel}
      </button>
    );
  };

  const rowActionButton = (row: ReviewIdentityRow) => {
    const externalName = personDisplayName(row.externalPerson);
    const label = activeTab === 'decisions'
      ? `Remove matching decision for ${externalName}`
      : `Correct established link for ${externalName}`;
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => openRowAction(row)}
        className="rounded-md px-2 py-1 text-xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
      >
        <span aria-hidden="true">×</span>
      </button>
    );
  };

  const sourceFamily = (row: ReviewIdentityRow) => (
    <FamilyContext
      family={row.externalFamily}
      noneLabel="No household"
      unavailableLabel="Household unavailable"
      unnamedLabel="Unnamed household"
    />
  );
  const localFamily = (row: ReviewIdentityRow) => (
    <FamilyContext
      family={localFamilyFor(row)}
      noneLabel="No family"
      unavailableLabel="Family unavailable"
      unnamedLabel="Unnamed family"
    />
  );

  const pickerRow = pickerExternalId === null
    ? undefined
    : decisionRows.find((row) => row.externalId === pickerExternalId);
  const pickerEntry = pickerRow ? reviewContext?.identities[pickerRow.externalId] : undefined;
  const pickerExcludedIndividualIds = pickerEntry
    ? [...new Set([
      ...pickerEntry.excludedIndividualIds,
      ...(pickerRow?.decision?.excludeIndividualId === undefined
        ? []
        : [pickerRow.decision.excludeIndividualId]),
    ])]
    : [];
  const removalRow = removalExternalId === null
    ? undefined
    : decisionRows.find((row) => row.externalId === removalExternalId);
  const correctionRow = establishedExternalId === null
    ? undefined
    : establishedRows.find((row) => row.externalId === establishedExternalId);
  const correctionBaseId = correctionRow
    ? reviewContext?.establishedLinks?.[correctionRow.externalId]?.individualId ?? null
    : null;
  const correctionCurrentId = correctionRow?.localIndividualId ?? null;

  return (
    <section aria-label="Identity review" className="space-y-4">
      <div role="tablist" aria-label="Identity review sections" className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-gray-700">
        <button
          ref={decisionsTabRef}
          id={`${tabGroupId}-decisions-tab`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'decisions'}
          aria-controls={`${tabGroupId}-panel`}
          tabIndex={activeTab === 'decisions' ? 0 : -1}
          onClick={() => changeTab('decisions')}
          onKeyDown={handleTabKeyDown}
          className={`rounded-t-md border-b-2 px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary-500 ${
            activeTab === 'decisions'
              ? 'border-primary-600 text-primary-700 dark:text-primary-300'
              : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
          }`}
        >
          Decisions {decisionRows.length}
        </button>
        <button
          ref={establishedTabRef}
          id={`${tabGroupId}-established-tab`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'established'}
          aria-controls={`${tabGroupId}-panel`}
          tabIndex={activeTab === 'established' ? 0 : -1}
          onClick={() => changeTab('established')}
          onKeyDown={handleTabKeyDown}
          className={`rounded-t-md border-b-2 px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary-500 ${
            activeTab === 'established'
              ? 'border-primary-600 text-primary-700 dark:text-primary-300'
              : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
          }`}
        >
          Already linked {establishedRows.length}
        </button>
      </div>

      <div
        id={`${tabGroupId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabGroupId}-${activeTab}-tab`}
        tabIndex={0}
        className="space-y-4"
      >
      <div className="grid gap-3 lg:grid-cols-[minmax(16rem,1fr)_auto] lg:items-end">
        <div>
          <label htmlFor="identity-review-search" className="block text-sm font-medium text-gray-800 dark:text-gray-100">
            Search identities
          </label>
          <input
            id="identity-review-search"
            type="search"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder="Search people, families, and household members"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          />
        </div>
        {activeTab === 'decisions' && (
          <div aria-label="Decision status filters" className="flex flex-wrap gap-2">
            {filterOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => changeFilter(option.value)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                  filter === option.value
                    ? 'border-primary-600 bg-primary-50 text-primary-800 dark:border-primary-500 dark:bg-primary-950/30 dark:text-primary-200'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200'
                }`}
              >
                {option.label} {filterCounts[option.value]}
              </button>
            ))}
          </div>
        )}
      </div>

      {(previewing || localPreviewing) && (
        <p role="status" className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100">
          Refreshing correction preview…
        </p>
      )}

      {correctionFailure && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100">
          {isRefreshOnlyReviewError(correctionFailure.cause) ? (
            <>
              <p className="font-semibold">The current review can no longer preview this correction.</p>
              <p className="mt-1">Refresh the full plan before applying, then review the affected people again.</p>
            </>
          ) : (
            <>
              <p className="font-semibold">The correction is still drafted, but its updated sync preview could not be loaded.</p>
              <p className="mt-1">Retry the preview before applying, or revert this correction to the last signed mapping.</p>
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {isRefreshOnlyReviewError(correctionFailure.cause) ? (
              <button
                type="button"
                onClick={() => void onRefreshReview?.()}
                className="rounded-md bg-primary-600 px-3 py-2 font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                Refresh plan
              </button>
            ) : (
              <button
                type="button"
                onClick={() => retryCorrectionPreview()}
                className="rounded-md bg-primary-600 px-3 py-2 font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                Retry preview
              </button>
            )}
            <button
              type="button"
              onClick={() => revertCorrection()}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 font-semibold text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              Revert correction
            </button>
          </div>
        </div>
      )}

      <table
        data-testid="desktop-identity-table"
        aria-hidden={!desktopLayout}
        aria-label={activeTab === 'decisions' ? 'Identity decisions' : 'Already linked identities'}
        className="hidden w-full table-fixed border-separate border-spacing-0 md:table"
      >
        <colgroup>
          <col className="w-[19%]" />
          <col className="w-[25%]" />
          <col className="w-[19%]" />
          <col className="w-[29%]" />
          <col className="w-[8%]" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th scope="col" className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">Integration source name</th>
            <th scope="col" className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">Integration source family/household</th>
            <th scope="col" className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">LMPG name</th>
            <th scope="col" className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">LMPG family</th>
            <th scope="col" className="border-b border-gray-200 px-3 py-2 text-center dark:border-gray-700">
              <span className="sr-only">Row action</span>
              <span aria-hidden="true">×</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => (
            <tr
              key={row.externalId}
              data-testid={`desktop-identity-row-${row.externalId}`}
              className="align-top text-sm text-gray-700 dark:text-gray-200"
            >
              <td className="break-words border-b border-gray-200 px-3 py-3 font-semibold text-gray-950 dark:border-gray-700 dark:text-white">
                {personDisplayName(row.externalPerson)}
              </td>
              <td className="break-words border-b border-gray-200 px-3 py-3 text-gray-600 dark:border-gray-700 dark:text-gray-300">
                {sourceFamily(row)}
              </td>
              <td className="break-words border-b border-gray-200 px-3 py-3 dark:border-gray-700">
                {primaryButton(row, false)}
                <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{rowStatusLabels[row.status]}</span>
              </td>
              <td className="break-words border-b border-gray-200 px-3 py-3 text-gray-600 dark:border-gray-700 dark:text-gray-300">
                {localFamily(row)}
              </td>
              <td className="border-b border-gray-200 px-3 py-3 text-center dark:border-gray-700">
                {rowActionButton(row)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul
        aria-hidden={desktopLayout}
        aria-label={activeTab === 'decisions' ? 'Identity decisions' : 'Already linked identities'}
        className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white md:hidden dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800"
      >
        {visibleRows.map((row) => (
          <li
            key={row.externalId}
            data-testid={`mobile-identity-row-${row.externalId}`}
            className="relative space-y-3 p-3 pr-11 md:hidden"
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Integration source</p>
              <p className="mt-1 break-words text-sm font-semibold text-gray-950 dark:text-white">{personDisplayName(row.externalPerson)}</p>
              <div className="mt-1 break-words text-sm text-gray-600 dark:text-gray-300">{sourceFamily(row)}</div>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">LMPG</p>
              <div className="mt-1">{primaryButton(row, true)}</div>
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{rowStatusLabels[row.status]}</span>
              <div className="mt-1 break-words text-sm text-gray-600 dark:text-gray-300">{localFamily(row)}</div>
            </div>
            <div className="absolute right-2 top-2">{rowActionButton(row)}</div>
          </li>
        ))}
      </ul>

      {visibleRows.length === 0 && (
        <p className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300">
          No identities match this search and filter.
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-gray-200 pt-3 text-sm text-gray-600 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700 dark:text-gray-300">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="identity-review-page-size" className="font-medium">Rows per page</label>
          <select
            id="identity-review-page-size"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPages({ decisions: 1, established: 1 });
            }}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
          <span>{pageRange(pagination.page, pageSize, filteredRows.length)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous page"
            disabled={pagination.page <= 1}
            onClick={() => movePage(pagination.page - 1)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            Previous
          </button>
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <button
            type="button"
            aria-label="Next page"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => movePage(pagination.page + 1)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            Next
          </button>
        </div>
      </div>
      </div>

      {pickerRow && reviewContext && (
        <PeoplePickerDialog
          open
          externalId={pickerRow.externalId}
          directory={directory}
          availableIndividualIds={availableIndividualIds}
          claimedBy={claimedBy}
          allowCreate={pickerEntry?.canCreate === true}
          selectedIndividualId={selectedIndividualId(pickerRow)}
          excludedIndividualIds={pickerExcludedIndividualIds}
          onSelectPerson={(individualId) => {
            setPickerExternalId(null);
            const excludeIndividualId = pickerRow.decision?.excludeIndividualId;
            setDecision(pickerRow.externalId, excludeIndividualId !== undefined && excludeIndividualId !== individualId
              ? { outcome: 'link', individualId, excludeIndividualId }
              : { outcome: 'link', individualId });
          }}
          onSelectCreate={() => {
            setPickerExternalId(null);
            const excludeIndividualId = pickerRow.decision?.excludeIndividualId;
            setDecision(pickerRow.externalId, excludeIndividualId === undefined
              ? { outcome: 'create' }
              : { outcome: 'create', excludeIndividualId });
          }}
          onClose={() => setPickerExternalId(null)}
        />
      )}

      {removalRow && (
        <IdentityRemovalDialog
          open
          externalName={personDisplayName(removalRow.externalPerson)}
          pairedIndividualId={removalRow.localIndividualId}
          onRejectPair={(individualId) => {
            setRemovalExternalId(null);
            setDecision(removalRow.externalId, { outcome: 'defer', excludeIndividualId: individualId });
          }}
          onSkip={() => {
            setRemovalExternalId(null);
            setDecision(removalRow.externalId, { outcome: 'defer' });
          }}
          onClose={() => setRemovalExternalId(null)}
        />
      )}

      {correctionRow && correctionBaseId !== null && (
        <EstablishedLinkDialog
          open
          externalId={correctionRow.externalId}
          currentIndividualId={correctionCurrentId}
          originalIndividualId={correctionBaseId}
          directory={directory}
          availableIndividualIds={availableIndividualIds}
          claimedBy={claimedBy}
          correctableClaimByIndividualId={correctableClaimByIndividualId}
          onRelink={(individualId) => {
            setEstablishedExternalId(null);
            commitCorrection(correctionRow.externalId, correctionBaseId, {
              outcome: 'relink',
              fromIndividualId: correctionBaseId,
              individualId,
            });
          }}
          onUnlink={() => {
            setEstablishedExternalId(null);
            commitCorrection(correctionRow.externalId, correctionBaseId, {
              outcome: 'unlink',
              fromIndividualId: correctionBaseId,
            });
          }}
          onRestore={correctionRow.correction ? () => {
            setEstablishedExternalId(null);
            commitCorrection(correctionRow.externalId, correctionBaseId, null);
          } : undefined}
          onClose={() => setEstablishedExternalId(null)}
        />
      )}
    </section>
  );
});

export default IdentityReviewTable;
