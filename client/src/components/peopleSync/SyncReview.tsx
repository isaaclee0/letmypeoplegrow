import React, { useEffect, useMemo, useRef, useState } from 'react';
import IdentityReviewTable, {
  type CorrectionPreviewRequestContext,
  type IdentityReviewTableHandle,
} from './IdentityReviewTable';
import SyncPlanSections, { deriveSyncPlanView } from './SyncPlanSections';
import {
  isRefreshOnlyReviewError,
  peopleSyncErrorCode,
  peopleSyncErrorMessage,
} from './apiError';
import {
  buildSyncSelections,
  incompleteIdentityExternalIds,
  initializeIdentityDecisions,
  type SyncSelectionState,
  type VisitorChoice,
} from './syncSelections';
import { isReviewDirty, selectedChangeCount } from './syncReviewModel';
import type {
  AmbiguousPersonAction,
  EstablishedLinkCorrection,
  IdentityDecision,
  PeopleSyncCorrectionPreview,
  PeopleSyncReview,
  PeopleSyncSelections,
  SyncProvider,
} from './types';

const MATCH_REASON_COPY: Record<string, string> = {
  unique_name: 'Same full name',
  child_narrowing: 'Same full name and child status',
  family_corroboration: 'Same full name with a linked family member',
  duplicate_name: 'More than one person has this name',
  review_deferred: 'Previously left for review',
};

const providerLabel = (provider: SyncProvider) => provider === 'planning_center' ? 'Planning Center' : 'Elvanto';

function snapshotTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export interface CandidateSearchRenderProps {
  action: AmbiguousPersonAction;
  selectCandidate: (candidateId: number) => void;
}

export interface SyncReviewProps {
  provider: SyncProvider;
  review: PeopleSyncReview;
  batchName?: string;
  sourceName?: string;
  onRefresh: () => void | Promise<void>;
  onPreviewCorrections?: (
    baseReviewToken: string,
    corrections: Record<string, EstablishedLinkCorrection>,
  ) => Promise<PeopleSyncCorrectionPreview>;
  onApply: (reviewToken: string, selections: PeopleSyncSelections) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  applying: boolean;
  interactionDisabled?: boolean;
  renderCandidateSearch?: (props: CandidateSearchRenderProps) => React.ReactNode;
  renderCandidateLabel?: (action: AmbiguousPersonAction, candidateId: number) => React.ReactNode;
  resolveAmbiguousArchiveIndividualId?: (action: AmbiguousPersonAction) => number | undefined;
  requireAllPlannedArchivesAccepted?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id > 0);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidEstablishedLinks(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.values(value).every((link) =>
    isRecord(link) && isPositiveInteger(link.individualId)));
}

function isValidLinkCorrections(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const externalIds = new Set<string>();
  return value.every((correction) => {
    if (!isRecord(correction)
      || typeof correction.externalPersonId !== 'string'
      || correction.externalPersonId.length === 0
      || !isPositiveInteger(correction.fromIndividualId)
      || externalIds.has(correction.externalPersonId)) return false;
    externalIds.add(correction.externalPersonId);
    return correction.outcome === 'unlink'
      || (correction.outcome === 'relink' && isPositiveInteger(correction.individualId));
  });
}

function isValidCreatePerson(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.firstName === 'string'
    && typeof value.lastName === 'string'
    && (typeof value.isChild === 'boolean' || value.isChild === null)
    && (typeof value.externalFamilyId === 'string' || value.externalFamilyId === null)
    && typeof value.peopleType === 'string'
    && ['regular', 'local_visitor', 'traveller_visitor'].includes(value.peopleType);
}

function hasValidV2Context(review: PeopleSyncReview): boolean {
  const context = review.plan.reviewContext;
  if (review.decisionContractVersion !== 2
    || context?.version !== 2
    || !isPositiveIntegerArray(context.manualCandidateIndividualIds)
    || !isRecord(context.identities)
    || (context.correctionContractVersion !== undefined && context.correctionContractVersion !== 1)
    || !isValidEstablishedLinks(context.establishedLinks)
    || !isValidEstablishedLinks(context.projectedEstablishedLinks)
    || !isValidLinkCorrections(context.linkCorrections)) return false;

  return Object.values(context.identities).every((identity) => {
    if (!isRecord(identity)) return false;
    const suggestedId = identity.suggestedIndividualId;
    const validSuggestedId = suggestedId === null
      || (typeof suggestedId === 'number' && Number.isSafeInteger(suggestedId) && suggestedId > 0);
    const validCreatePerson = identity.createPerson === null || isValidCreatePerson(identity.createPerson);
    return validSuggestedId
      && isPositiveIntegerArray(identity.candidateIndividualIds)
      && isPositiveIntegerArray(identity.excludedIndividualIds)
      && typeof identity.held === 'boolean'
      && typeof identity.canCreate === 'boolean'
      && validCreatePerson
      && (identity.canCreate !== true || isValidCreatePerson(identity.createPerson));
  });
}

function correctionsForReview(review: PeopleSyncReview): Record<string, EstablishedLinkCorrection> {
  return Object.fromEntries((review.plan.reviewContext?.linkCorrections || []).map((correction) => {
    const { externalPersonId, ...value } = correction;
    return [externalPersonId, value];
  }));
}

function stateForReview(review: PeopleSyncReview): SyncSelectionState {
  const validV2Context = hasValidV2Context(review);
  return {
    identityDecisions: review.decisionContractVersion === 2
      ? (validV2Context ? initializeIdentityDecisions(review) : {})
      : undefined,
    linkCorrections: validV2Context ? correctionsForReview(review) : {},
    ambiguousChoices: {},
    skippedExternalIds: new Set(),
    visitorChoices: {},
    acceptedArchiveIds: new Set(),
    acceptedFamilyRenameIds: new Set(),
  };
}

function displayName(person: { firstName: string; lastName: string } | undefined): string {
  return `${person?.firstName || ''} ${person?.lastName || ''}`.trim();
}

function LegacySection({ title, count, children, open = false }: {
  title: string;
  count: number;
  children: React.ReactNode;
  open?: boolean;
}) {
  if (count === 0) return null;
  return (
    <details open={open} className="group overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-semibold text-gray-950 dark:text-white">{title}</span>
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{count}</span>
      </summary>
      <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">{children}</div>
    </details>
  );
}

function LegacyIdentityDecisions({
  review,
  state,
  setState,
  renderCandidateSearch,
  renderCandidateLabel,
  resolveAmbiguousArchiveIndividualId,
}: {
  review: PeopleSyncReview;
  state: SyncSelectionState;
  setState: React.Dispatch<React.SetStateAction<SyncSelectionState>>;
  renderCandidateSearch?: SyncReviewProps['renderCandidateSearch'];
  renderCandidateLabel?: SyncReviewProps['renderCandidateLabel'];
  resolveAmbiguousArchiveIndividualId?: SyncReviewProps['resolveAmbiguousArchiveIndividualId'];
}) {
  const { plan } = review;
  const externalPerson = (id: string) => displayName(plan.people?.external[id]) || 'External person';
  const localPerson = (id: number) => displayName(plan.people?.local[String(id)]) || 'Local person';
  const selectCandidate = (externalId: string, candidateId: number, archiveId?: number) => setState((previous) => {
    const acceptedArchiveIds = new Set(previous.acceptedArchiveIds);
    if (archiveId !== undefined) acceptedArchiveIds.delete(archiveId);
    return { ...previous, acceptedArchiveIds, ambiguousChoices: { ...previous.ambiguousChoices, [externalId]: candidateId } };
  });
  const chooseVisitor = (externalId: string, choice: VisitorChoice) => setState((previous) => ({
    ...previous,
    visitorChoices: { ...previous.visitorChoices, [externalId]: choice },
  }));
  const count = plan.ambiguousPeople.length
    + plan.familyConflicts.length
    + plan.promoteToRegular.filter((action) => action.reviewRequired).length;

  return (
    <LegacySection title="Decisions needed" count={count} open>
      <ul className="space-y-3">
        {plan.ambiguousPeople.map((action) => {
          const archiveId = resolveAmbiguousArchiveIndividualId?.(action);
          return (
            <li key={action.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
              <p className="mb-2 font-medium">{externalPerson(action.externalPersonId)} — {MATCH_REASON_COPY[action.reason] || 'Needs review'}</p>
              <div className="space-y-2">
                {action.candidateIndividualIds.map((candidateId) => (
                  <label key={candidateId} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`ambiguous-${action.id}`}
                      checked={state.ambiguousChoices[action.externalPersonId] === candidateId}
                      onChange={() => selectCandidate(action.externalPersonId, candidateId, archiveId)}
                    />
                    <span>{renderCandidateLabel
                      ? renderCandidateLabel(action, candidateId)
                      : `Use ${localPerson(candidateId)} for ${externalPerson(action.externalPersonId)}`}</span>
                  </label>
                ))}
                {archiveId !== undefined && (
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`ambiguous-${action.id}`}
                      checked={state.acceptedArchiveIds.has(archiveId)}
                      onChange={() => setState((previous) => ({
                        ...previous,
                        ambiguousChoices: { ...previous.ambiguousChoices, [action.externalPersonId]: null },
                        acceptedArchiveIds: new Set(previous.acceptedArchiveIds).add(archiveId),
                      }))}
                    />
                    Archive this person
                  </label>
                )}
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`ambiguous-${action.id}`}
                    checked={state.ambiguousChoices[action.externalPersonId] === null
                      && (archiveId === undefined || !state.acceptedArchiveIds.has(archiveId))}
                    onChange={() => setState((previous) => {
                      const acceptedArchiveIds = new Set(previous.acceptedArchiveIds);
                      if (archiveId !== undefined) acceptedArchiveIds.delete(archiveId);
                      return {
                        ...previous,
                        acceptedArchiveIds,
                        ambiguousChoices: { ...previous.ambiguousChoices, [action.externalPersonId]: null },
                      };
                    })}
                  />
                  Decide later
                </label>
                {renderCandidateSearch?.({
                  action,
                  selectCandidate: (candidateId) => selectCandidate(action.externalPersonId, candidateId, archiveId),
                })}
              </div>
            </li>
          );
        })}
        {plan.familyConflicts.map((conflict, index) => (
          <li key={conflict.id || index} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            Family conflict requires review
          </li>
        ))}
        {plan.promoteToRegular.filter((action) => action.reviewRequired).map((action) => (
          <li key={action.id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            <p className="mb-2 font-medium">{localPerson(action.individualId)}</p>
            <label className="mr-4">
              <input type="radio" name={`visitor-${action.id}`} checked={state.visitorChoices[action.externalPersonId] === 'promote'} onChange={() => chooseVisitor(action.externalPersonId, 'promote')} /> Promote {localPerson(action.individualId)}
            </label>
            <label>
              <input type="radio" name={`visitor-${action.id}`} checked={state.visitorChoices[action.externalPersonId] === 'keep'} onChange={() => chooseVisitor(action.externalPersonId, 'keep')} /> Keep as visitor
            </label>
          </li>
        ))}
      </ul>
    </LegacySection>
  );
}

function LegacyIdentitySummary({
  review,
  state,
  setState,
}: {
  review: PeopleSyncReview;
  state: SyncSelectionState;
  setState: React.Dispatch<React.SetStateAction<SyncSelectionState>>;
}) {
  const automaticLinks = review.plan.linkPeople.filter((action) => !action.reviewRequired);
  const externalPerson = (id: string) => displayName(review.plan.people?.external[id]) || 'External person';
  const localPerson = (id: number) => displayName(review.plan.people?.local[String(id)]) || 'Local person';
  const toggleSkipped = (externalId: string) => setState((previous) => {
    const skippedExternalIds = new Set(previous.skippedExternalIds);
    if (skippedExternalIds.has(externalId)) skippedExternalIds.delete(externalId);
    else skippedExternalIds.add(externalId);
    return { ...previous, skippedExternalIds };
  });
  const count = automaticLinks.length + review.plan.addPeople.length;

  return (
    <LegacySection title="Legacy identity changes" count={count}>
      <ul className="space-y-2 text-sm">
        {automaticLinks.map((action) => (
          <li key={action.id}>Link {externalPerson(action.externalPersonId)} to {localPerson(action.individualId)}</li>
        ))}
        {review.plan.addPeople.map((action) => (
          <li key={action.id}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!state.skippedExternalIds.has(action.externalPersonId)}
                onChange={() => toggleSkipped(action.externalPersonId)}
              />
              Add {action.firstName} {action.lastName}
            </label>
          </li>
        ))}
      </ul>
    </LegacySection>
  );
}

function SummaryChip({ label, count, tone = 'neutral', onClick }: {
  label: string;
  count: number;
  tone?: 'neutral' | 'amber';
  onClick?: () => void;
}) {
  const className = `inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${tone === 'amber'
    ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100'
    : 'border-gray-200 bg-stone-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'}`;
  if (onClick) {
    return <button type="button" onClick={onClick} className={`${className} focus:outline-none focus:ring-2 focus:ring-primary-500`}>{label} <span className="font-semibold tabular-nums">{count}</span></button>;
  }
  return <span className={className}>{label} <span className="font-semibold tabular-nums">{count}</span></span>;
}

function recordsMatch(
  left: Record<string, EstablishedLinkCorrection> | undefined,
  right: Record<string, EstablishedLinkCorrection> | undefined,
): boolean {
  const sorted = (value: Record<string, EstablishedLinkCorrection> | undefined) => Object.fromEntries(
    Object.entries(value || {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

export default function SyncReview({
  provider,
  review,
  batchName,
  sourceName,
  onRefresh,
  onPreviewCorrections,
  onApply,
  onDirtyChange,
  applying,
  interactionDisabled = false,
  renderCandidateSearch,
  renderCandidateLabel,
  resolveAmbiguousArchiveIndividualId,
  requireAllPlannedArchivesAccepted = false,
}: SyncReviewProps) {
  const initialState = stateForReview(review);
  const [effectiveReview, setEffectiveReview] = useState(review);
  const [state, setState] = useState<SyncSelectionState>(initialState);
  const [confirmedDestructiveChanges, setConfirmedDestructiveChanges] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [previewing, setPreviewing] = useState(false);
  const [baselineVersion, setBaselineVersion] = useState(0);
  const baseReviewRef = useRef(review);
  const externalReviewKeyRef = useRef(`${review.runId}:${review.reviewToken}`);
  const baselineStateRef = useRef(initialState);
  const lastReportedDirtyRef = useRef<boolean | undefined>(undefined);
  const tableRef = useRef<IdentityReviewTableHandle>(null);
  const identityReviewRootRef = useRef<HTMLDivElement>(null);

  const externalReviewKey = `${review.runId}:${review.reviewToken}`;
  useEffect(() => {
    if (externalReviewKeyRef.current === externalReviewKey) return;
    externalReviewKeyRef.current = externalReviewKey;
    baseReviewRef.current = review;
    setEffectiveReview(review);
    const nextState = stateForReview(review);
    baselineStateRef.current = nextState;
    setState(nextState);
    setBaselineVersion((version) => version + 1);
    setConfirmedDestructiveChanges(false);
    setApplyError(null);
    setPreviewing(false);
  }, [externalReviewKey, review]);

  const dirty = useMemo(
    () => isReviewDirty(baselineStateRef.current, state),
    [baselineVersion, state],
  );
  useEffect(() => {
    if (lastReportedDirtyRef.current === dirty) return;
    lastReportedDirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const markClean = () => {
    baselineStateRef.current = state;
    setBaselineVersion((version) => version + 1);
  };

  const { plan } = effectiveReview;
  const directory = plan.people || { external: {}, local: {} };
  const declaresV2 = effectiveReview.decisionContractVersion === 2;
  const validV2Context = hasValidV2Context(effectiveReview);
  const malformedV2 = declaresV2 && !validV2Context;
  const reviewContext = validV2Context ? plan.reviewContext : undefined;
  const isV2 = declaresV2 && validV2Context;
  const establishedLinksReadOnly = isV2 && !onPreviewCorrections;
  const identityTableReview = establishedLinksReadOnly && reviewContext
    ? {
      ...effectiveReview,
      plan: {
        ...effectiveReview.plan,
        reviewContext: {
          ...reviewContext,
          establishedLinks: {},
          projectedEstablishedLinks: {},
          linkCorrections: [],
        },
      },
    }
    : effectiveReview;
  const unmatchedCoverageCount = effectiveReview.coverage?.unmatchedActiveLocalRegulars ?? 0;
  const externalPerson = (id: string) => displayName(directory.external[id]) || 'External person';
  const localPerson = (id: number) => displayName(directory.local[String(id)]) || 'Local person';

  const decisionTarget = (externalId: string, decision: IdentityDecision | null | undefined): number | null => {
    if (decision?.outcome === 'accept') return reviewContext?.identities[externalId]?.suggestedIndividualId ?? null;
    if (decision?.outcome === 'link') return decision.individualId;
    return null;
  };
  const claims = useMemo(() => {
    const byIndividual = new Map<number, string[]>();
    const claim = (individualId: number | null, externalId: string) => {
      if (individualId === null) return;
      byIndividual.set(individualId, [...(byIndividual.get(individualId) || []), externalId]);
    };
    for (const [externalId, decision] of Object.entries(state.identityDecisions || {})) {
      claim(decisionTarget(externalId, decision), externalId);
    }
    for (const [externalId, established] of Object.entries(reviewContext?.establishedLinks || {})) {
      const correction = state.linkCorrections?.[externalId];
      const projected = reviewContext?.projectedEstablishedLinks?.[externalId];
      const target = correction?.outcome === 'unlink'
        ? null
        : correction?.outcome === 'relink'
          ? correction.individualId
          : projected?.individualId ?? established.individualId;
      claim(target, externalId);
    }
    return byIndividual;
  }, [reviewContext, state.identityDecisions, state.linkCorrections]);
  const collisions = [...claims.entries()].filter(([, externalIds]) => externalIds.length > 1);
  const incompleteExternalIds = incompleteIdentityExternalIds(state, reviewContext);
  const affectedExternalId = incompleteExternalIds[0] || collisions[0]?.[1][0];
  const planView = deriveSyncPlanView(effectiveReview, state);
  const signedCorrections = validV2Context ? correctionsForReview(effectiveReview) : {};
  const correctionsReady = recordsMatch(state.linkCorrections, signedCorrections);
  const requiresConfirmation = planView.archive.length > 0
    || planView.removeFromGathering.length > 0
    || state.acceptedFamilyRenameIds.size > 0
    || state.acceptedArchiveIds.size > 0;
  const allPlannedArchivesAccepted = !requireAllPlannedArchivesAccepted
    || planView.archive.every((action) => state.acceptedArchiveIds.has(action.individualId));

  const refreshOnlyError = isRefreshOnlyReviewError(applyError);
  const refreshOnlyCode = peopleSyncErrorCode(applyError);
  const reviewExpired = refreshOnlyCode === 'SYNC_REVIEW_EXPIRED';
  const reviewAlreadyApplied = refreshOnlyCode === 'SYNC_REVIEW_ALREADY_APPLIED';
  const applyDisabled = applying
    || interactionDisabled
    || previewing
    || refreshOnlyError
    || malformedV2
    || !correctionsReady
    || incompleteExternalIds.length > 0
    || collisions.length > 0
    || !allPlannedArchivesAccepted
    || (requiresConfirmation && !confirmedDestructiveChanges);
  const selectedCount = selectedChangeCount(effectiveReview, state);
  const applyLabel = applying
    ? 'Applying…'
    : isV2
      ? `Apply ${selectedCount} selected ${selectedCount === 1 ? 'change' : 'changes'}`
      : 'Apply sync';

  const submit = async () => {
    if (applyDisabled) return;
    setApplyError(null);
    try {
      await onApply(effectiveReview.reviewToken, buildSyncSelections(state));
      markClean();
    } catch (error) {
      setApplyError(error);
    }
  };

  const guardedRefresh = async () => {
    try {
      await onRefresh();
    } catch {
      // Refresh owners already expose their own provider-specific error state.
    }
  };

  const previewCorrections = async (
    corrections: Record<string, EstablishedLinkCorrection>,
    request: CorrectionPreviewRequestContext,
  ): Promise<PeopleSyncReview> => {
    if (!onPreviewCorrections) throw new Error('Correction previews are unavailable in this review.');
    const requestBase = baseReviewRef.current;
    setPreviewing(true);
    try {
      const preview = await onPreviewCorrections(requestBase.reviewToken, corrections);
      const nextReview: PeopleSyncReview = { ...preview, runId: requestBase.runId };
      if (request.isCurrent()
        && baseReviewRef.current.reviewToken === requestBase.reviewToken
        && baseReviewRef.current.runId === requestBase.runId) {
        setEffectiveReview(nextReview);
      }
      return nextReview;
    } catch (error) {
      if (request.isCurrent()
        && baseReviewRef.current.reviewToken === requestBase.reviewToken
        && baseReviewRef.current.runId === requestBase.runId
        && isRefreshOnlyReviewError(error)) {
        setApplyError(error);
      }
      throw error;
    } finally {
      if (request.isCurrent()
        && baseReviewRef.current.reviewToken === requestBase.reviewToken
        && baseReviewRef.current.runId === requestBase.runId) {
        setPreviewing(false);
      }
    }
  };

  const manualChoices = Object.entries(state.identityDecisions || {})
    .filter(([, decision]) => decision?.outcome === 'link')
    .map(([externalId, decision]) => ({
      external: externalPerson(externalId),
      local: decision?.outcome === 'link' ? localPerson(decision.individualId) : '',
    }));
  const managedCount = planView.updateManagedFields.length
    + planView.promoteToRegular.length
    + planView.demoteToLocalVisitor.length;
  const familyCount = planView.linkFamilies.length
    + planView.addFamilies.length
    + planView.moveFamily.length
    + planView.renameFamily.length;
  const gatheringCount = planView.addToGathering.length + planView.removeFromGathering.length;
  const destructiveCount = planView.archive.length
    + planView.removeFromGathering.length
    + planView.renameFamily.length;
  const fetchedAt = effectiveReview.snapshot?.fetchedAt || plan.snapshot?.fetchedAt || null;
  const allClear = Object.keys(reviewContext?.identities || {}).length === 0
    && Object.keys(reviewContext?.establishedLinks || {}).length === 0
    && Object.entries(plan).every(([key, value]) => [
      'provider', 'authoritative', 'snapshot', 'people', 'reviewContext',
    ].includes(key) || !Array.isArray(value) || value.length === 0);

  const focusVisibleIdentityRow = (externalId: string) => {
    const root = identityReviewRootRef.current;
    if (!root) return;
    const targetTestIds = new Set([
      `desktop-identity-row-${externalId}`,
      `mobile-identity-row-${externalId}`,
    ]);
    const row = [...root.querySelectorAll<HTMLElement>('[data-testid]')]
      .find((element) => targetTestIds.has(element.dataset.testid || '')
        && !element.closest('[aria-hidden="true"]'));
    row?.querySelector<HTMLButtonElement>('button[aria-label]')?.focus();
  };

  const focusAffected = (externalId = affectedExternalId) => {
    if (!externalId) return;
    if (incompleteExternalIds.includes(externalId)) {
      const filter = [...(identityReviewRootRef.current?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') || [])]
        .find((button) => button.textContent?.trim().startsWith('Needs attention'));
      if (filter) {
        filter.click();
        queueMicrotask(() => focusVisibleIdentityRow(externalId));
        return;
      }
    }
    tableRef.current?.focusExternalId(externalId);
  };

  return (
    <div className="space-y-5 text-gray-900 dark:text-gray-100">
      <fieldset disabled={applying || interactionDisabled} className="contents">
        <header className="rounded-xl border border-stone-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-950 dark:text-white">{providerLabel(provider)} sync review</h3>
              {(batchName || sourceName) && (
                <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
                  {batchName && <span className="font-medium">{batchName}</span>}
                  {batchName && sourceName && <span aria-hidden="true"> · </span>}
                  {sourceName && <span>{sourceName}</span>}
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Source snapshot: {fetchedAt ? <time dateTime={fetchedAt}>{snapshotTimeLabel(fetchedAt)}</time> : 'Unavailable'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void guardedRefresh()}
              disabled={applying || previewing}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              Refresh plan
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <SummaryChip label="Identity decisions" count={Object.keys(reviewContext?.identities || {}).length} />
            <SummaryChip
              label="Needs attention"
              count={incompleteExternalIds.length + collisions.length}
              tone={affectedExternalId ? 'amber' : 'neutral'}
              onClick={affectedExternalId ? () => focusAffected() : undefined}
            />
            <SummaryChip label="Managed updates" count={managedCount} />
            <SummaryChip label="Family changes" count={familyCount} />
            <SummaryChip label="Gathering changes" count={gatheringCount} />
            <SummaryChip label="Destructive changes" count={destructiveCount} tone={destructiveCount > 0 ? 'amber' : 'neutral'} />
          </div>
        </header>

        {allClear && (
          <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">
            No roster changes are planned in this review.
          </p>
        )}

        {unmatchedCoverageCount > 0 && (
          <div className="rounded-lg border border-gray-200 bg-stone-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
            {unmatchedCoverageCount} active LMPG regulars are not matched to any currently configured {providerLabel(provider)} source. They will remain unchanged. Add another sync batch if they should be included.
          </div>
        )}

        {malformedV2 && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
            This sync review could not be safely loaded. Refresh the plan before applying it.
          </div>
        )}

        {isV2 && reviewContext && (
          <div ref={identityReviewRootRef}>
            <IdentityReviewTable
              ref={tableRef}
              review={identityTableReview}
              state={state}
              onStateChange={setState}
              onPreviewCorrections={previewCorrections}
              onRefreshReview={guardedRefresh}
              previewing={previewing}
            />
          </div>
        )}

        {establishedLinksReadOnly && reviewContext && Object.keys(reviewContext.establishedLinks || {}).length > 0 && (
          <LegacySection title="Already linked (read-only)" count={Object.keys(reviewContext.establishedLinks || {}).length}>
            <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
              {Object.entries(reviewContext.establishedLinks || {}).map(([externalId, established]) => {
                const correction = state.linkCorrections?.[externalId];
                const projected = reviewContext.projectedEstablishedLinks?.[externalId];
                const targetId = correction?.outcome === 'unlink'
                  ? null
                  : correction?.outcome === 'relink'
                    ? correction.individualId
                    : projected?.individualId ?? established.individualId;
                return (
                  <li key={externalId}>
                    {externalPerson(externalId)} → {targetId === null ? 'Skipped for now' : localPerson(targetId)}
                  </li>
                );
              })}
            </ul>
          </LegacySection>
        )}

        {!declaresV2 && (
          <>
            <LegacyIdentityDecisions
              review={effectiveReview}
              state={state}
              setState={setState}
              renderCandidateSearch={renderCandidateSearch}
              renderCandidateLabel={renderCandidateLabel}
              resolveAmbiguousArchiveIndividualId={resolveAmbiguousArchiveIndividualId}
            />
            <LegacyIdentitySummary review={effectiveReview} state={state} setState={setState} />
          </>
        )}

        <SyncPlanSections review={effectiveReview} state={state} onStateChange={setState} />

        {requiresConfirmation && (
          <label className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
            <input
              type="checkbox"
              checked={confirmedDestructiveChanges}
              onChange={(event) => setConfirmedDestructiveChanges(event.target.checked)}
              className="mt-0.5"
            />
            I understand that this sync will archive people, remove gathering assignments, or rename families.
          </label>
        )}

        {(incompleteExternalIds.length > 0 || collisions.length > 0 || !correctionsReady || !allPlannedArchivesAccepted) && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
            {incompleteExternalIds.map((externalId) => (
              <p key={externalId}>
                {externalPerson(externalId)} needs a decision before you can apply this sync.{' '}
                <button type="button" className="font-semibold underline underline-offset-2" onClick={() => focusAffected(externalId)}>
                  Review {externalPerson(externalId)}
                </button>
              </p>
            ))}
            {collisions.map(([individualId, externalIds]) => (
              <p key={individualId}>
                {externalIds.map(externalPerson).join(' and ')} both select {localPerson(individualId)}. Choose a different person for one of them.{' '}
                <button type="button" className="font-semibold underline underline-offset-2" onClick={() => focusAffected(externalIds[0])}>Review collision</button>
              </p>
            ))}
            {!correctionsReady && <p>The latest established-link correction needs a successful signed preview before you can apply.</p>}
            {!allPlannedArchivesAccepted && <p>Review and accept every planned archive before applying this sync.</p>}
          </div>
        )}

        {applyError && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
            {refreshOnlyError ? (
              <>
                <p className="font-medium">
                  {reviewExpired
                    ? 'This review has expired.'
                    : reviewAlreadyApplied
                      ? 'This review has already been applied.'
                      : 'This review is out of date.'}
                </p>
                <p className="mt-1">At least one choice may no longer be available. Refresh the plan and review the affected people again.</p>
                <p className="mt-1">{peopleSyncErrorMessage(applyError, 'Refresh the plan before applying.')}</p>
                {manualChoices.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {manualChoices.map((choice) => <li key={`${choice.external}-${choice.local}`}>{choice.external} → {choice.local}</li>)}
                  </ul>
                )}
                <button type="button" className="mt-3 font-semibold underline underline-offset-2" onClick={() => void guardedRefresh()}>Refresh plan</button>
              </>
            ) : peopleSyncErrorMessage(applyError, 'Failed to apply sync.')}
          </div>
        )}

        <footer className="flex flex-col gap-3 border-t border-gray-200 pt-5 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-500 dark:text-gray-400">Nothing is changed until you apply this review.</p>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={applyDisabled}
            className="inline-flex items-center justify-center rounded-md bg-green-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-gray-900"
          >
            {applyLabel}
          </button>
        </footer>
      </fieldset>
    </div>
  );
}
