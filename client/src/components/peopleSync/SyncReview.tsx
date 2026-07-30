import React, { useEffect, useMemo, useState } from 'react';
import MatchDecisionCard from './MatchDecisionCard';
import { personDisplayName } from './PersonIdentitySummary';
import {
  buildSyncSelections,
  incompleteIdentityExternalIds,
  initializeIdentityDecisions,
  type SyncSelectionState,
  type VisitorChoice,
} from './syncSelections';
import type {
  AmbiguousPersonAction,
  IdentityDecision,
  PeopleSyncPeopleDirectory,
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

export interface CandidateSearchRenderProps {
  action: AmbiguousPersonAction;
  selectCandidate: (candidateId: number) => void;
}

interface SyncReviewProps {
  provider: SyncProvider;
  review: PeopleSyncReview;
  onRefresh: () => void | Promise<void>;
  onApply: (reviewToken: string, selections: PeopleSyncSelections) => void | Promise<void>;
  applying: boolean;
  renderCandidateSearch?: (props: CandidateSearchRenderProps) => React.ReactNode;
  renderCandidateLabel?: (action: AmbiguousPersonAction, candidateId: number) => React.ReactNode;
  resolveAmbiguousArchiveIndividualId?: (action: AmbiguousPersonAction) => number | undefined;
  requireAllPlannedArchivesAccepted?: boolean;
}

function stateForReview(review: PeopleSyncReview): SyncSelectionState {
  return {
    identityDecisions: review.decisionContractVersion === 2 ? initializeIdentityDecisions(review) : undefined,
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { code?: string }).code
    || (error as { response?: { data?: { code?: string } } }).response?.data?.code;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const responseText = (error as { response?: { data?: { error?: string; message?: string } } }).response?.data;
    if (responseText?.error) return responseText.error;
    if (responseText?.message) return responseText.message;
  }
  return 'Failed to apply sync.';
}

function Section({ title, count, children, tone = 'neutral', open = false }: {
  title: string;
  count: number;
  children: React.ReactNode;
  tone?: 'neutral' | 'amber';
  open?: boolean;
}) {
  if (count === 0) return null;
  const toneClasses = tone === 'amber'
    ? 'border-amber-300 bg-amber-50/80 dark:border-amber-700 dark:bg-amber-950/30'
    : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800';
  return (
    <details open={open} className={`group overflow-hidden rounded-xl border shadow-sm ${toneClasses}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500 sm:px-5">
        <span className="text-sm font-semibold text-gray-950 dark:text-white">{title}</span>
        <span className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          {count}
          <span aria-hidden="true" className="text-base transition-transform group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <div className="border-t border-gray-200 px-4 py-4 dark:border-gray-700 sm:px-5">{children}</div>
    </details>
  );
}

function SummaryCard({ label, count, tone = 'neutral' }: { label: string; count: number; tone?: 'neutral' | 'amber' }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === 'amber'
      ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
      : 'border-stone-200 bg-stone-50 dark:border-gray-700 dark:bg-gray-800'}`}>
      <p className="text-xs font-medium text-gray-600 dark:text-gray-300">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-950 dark:text-white">{count}</p>
    </div>
  );
}

function ApplyControls({ applying, disabled, onApply, onRefresh }: {
  applying: boolean;
  disabled: boolean;
  onApply: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <button
        type="button"
        onClick={onApply}
        disabled={disabled}
        className="inline-flex w-full items-center justify-center rounded-md bg-green-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-gray-900 sm:w-auto"
      >
        {applying ? 'Applying…' : 'Apply sync'}
      </button>
      <button
        type="button"
        onClick={() => void onRefresh()}
        disabled={applying}
        className="inline-flex w-full items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 sm:w-auto"
      >
        Refresh plan
      </button>
    </div>
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
  const count = plan.ambiguousPeople.length + plan.familyConflicts.length + plan.promoteToRegular.filter((action) => action.reviewRequired).length;

  return (
    <Section title="Decisions needed" count={count} open>
      <ul className="space-y-3">
        {plan.ambiguousPeople.map((action) => {
          const archiveId = resolveAmbiguousArchiveIndividualId?.(action);
          return (
            <li key={action.id} className="rounded-lg border border-gray-200 p-3 text-sm text-gray-900 dark:border-gray-700 dark:text-gray-100">
              <p className="mb-2 font-medium">{externalPerson(action.externalPersonId)} — {MATCH_REASON_COPY[action.reason] || 'Needs review'}</p>
              <div className="space-y-2">
                {(action.candidateIndividualIds || []).map((candidateId) => (
                  <label key={candidateId} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`ambiguous-${action.id}`}
                      checked={state.ambiguousChoices[action.externalPersonId] === candidateId}
                      onChange={() => selectCandidate(action.externalPersonId, candidateId, archiveId)}
                    />
                    <span>{renderCandidateLabel ? renderCandidateLabel(action, candidateId) : `Use ${localPerson(candidateId)} for ${externalPerson(action.externalPersonId)}`}</span>
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
                    checked={state.ambiguousChoices[action.externalPersonId] === null}
                    onChange={() => setState((previous) => ({
                      ...previous,
                      ambiguousChoices: { ...previous.ambiguousChoices, [action.externalPersonId]: null },
                    }))}
                  />
                  Decide later
                </label>
                {renderCandidateSearch?.({ action, selectCandidate: (candidateId) => selectCandidate(action.externalPersonId, candidateId, archiveId) })}
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
            <label className="mr-4"><input type="radio" name={`visitor-${action.id}`} checked={state.visitorChoices[action.externalPersonId] === 'promote'} onChange={() => chooseVisitor(action.externalPersonId, 'promote')} /> Promote {localPerson(action.individualId)}</label>
            <label><input type="radio" name={`visitor-${action.id}`} checked={state.visitorChoices[action.externalPersonId] === 'keep'} onChange={() => chooseVisitor(action.externalPersonId, 'keep')} /> Keep as visitor</label>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default function SyncReview({
  provider,
  review,
  onRefresh,
  onApply,
  applying,
  renderCandidateSearch,
  renderCandidateLabel,
  resolveAmbiguousArchiveIndividualId,
  requireAllPlannedArchivesAccepted = false,
}: SyncReviewProps) {
  const [state, setState] = useState<SyncSelectionState>(() => stateForReview(review));
  const [confirmedDestructiveChanges, setConfirmedDestructiveChanges] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const { plan } = review;
  const directory: PeopleSyncPeopleDirectory = plan.people || { external: {}, local: {} };
  const reviewContext = review.decisionContractVersion === 2 ? plan.reviewContext : undefined;
  const isV2 = review.decisionContractVersion === 2 && reviewContext?.version === 2;
  const unmatchedCoverageCount = review.coverage?.unmatchedActiveLocalRegulars ?? 0;

  const externalPerson = (id: string) => displayName(directory.external[id]) || 'External person';
  const localPerson = (id: number) => displayName(directory.local[String(id)]) || 'Local person';

  useEffect(() => {
    setState(stateForReview(review));
    setConfirmedDestructiveChanges(false);
    setApplyError(null);
  }, [review.reviewToken]);

  const decisionTarget = (externalId: string, decision: IdentityDecision | null | undefined): number | null => {
    if (decision?.outcome === 'accept') return reviewContext?.identities[externalId]?.suggestedIndividualId ?? null;
    if (decision?.outcome === 'link') return decision.individualId;
    return null;
  };

  const claims = useMemo(() => {
    const byIndividual = new Map<number, string[]>();
    for (const [externalId, decision] of Object.entries(state.identityDecisions || {})) {
      const target = decisionTarget(externalId, decision);
      if (target === null) continue;
      const claimants = byIndividual.get(target) || [];
      claimants.push(externalId);
      byIndividual.set(target, claimants);
    }
    return byIndividual;
  }, [reviewContext, state.identityDecisions]);

  const collisions = [...claims.entries()].filter(([, externalIds]) => externalIds.length > 1);
  const incompleteExternalIds = incompleteIdentityExternalIds(state, reviewContext);
  const requiresConfirmation = plan.archive.length > 0
    || plan.removeFromGathering.length > 0
    || state.acceptedFamilyRenameIds.size > 0
    || state.acceptedArchiveIds.size > 0;
  const allPlannedArchivesAccepted = !requireAllPlannedArchivesAccepted
    || plan.archive.every((action) => state.acceptedArchiveIds.has(action.individualId));
  const applyDisabled = applying
    || incompleteExternalIds.length > 0
    || collisions.length > 0
    || !allPlannedArchivesAccepted
    || (requiresConfirmation && !confirmedDestructiveChanges);

  const setIdentityDecision = (externalId: string, decision: IdentityDecision | null) => setState((previous) => ({
    ...previous,
    identityDecisions: { ...previous.identityDecisions, [externalId]: decision },
  }));
  const toggleArchive = (individualId: number) => setState((previous) => {
    const acceptedArchiveIds = new Set(previous.acceptedArchiveIds);
    if (acceptedArchiveIds.has(individualId)) acceptedArchiveIds.delete(individualId); else acceptedArchiveIds.add(individualId);
    return { ...previous, acceptedArchiveIds };
  });
  const toggleRename = (actionId: string) => setState((previous) => {
    const acceptedFamilyRenameIds = new Set(previous.acceptedFamilyRenameIds);
    if (acceptedFamilyRenameIds.has(actionId)) acceptedFamilyRenameIds.delete(actionId); else acceptedFamilyRenameIds.add(actionId);
    return { ...previous, acceptedFamilyRenameIds };
  });
  const toggleSkipped = (externalId: string) => setState((previous) => {
    const skippedExternalIds = new Set(previous.skippedExternalIds);
    if (skippedExternalIds.has(externalId)) skippedExternalIds.delete(externalId); else skippedExternalIds.add(externalId);
    return { ...previous, skippedExternalIds };
  });

  const submit = async () => {
    setApplyError(null);
    try {
      await onApply(review.reviewToken, buildSyncSelections(state));
    } catch (error) {
      setApplyError(error);
    }
  };

  const stale = errorCode(applyError) === 'SYNC_PLAN_STALE' || errorCode(applyError) === 'STALE_REVIEW';
  const manualChoices = Object.entries(state.identityDecisions || {})
    .filter(([, decision]) => decision?.outcome === 'link')
    .map(([externalId, decision]) => ({
      external: externalPerson(externalId),
      local: decision?.outcome === 'link' ? localPerson(decision.individualId) : '',
    }));

  const suggestedCount = isV2 ? Object.values(state.identityDecisions || {}).filter((decision) => decision?.outcome === 'accept').length : plan.linkPeople.length;
  const neededCount = isV2 ? incompleteExternalIds.length : plan.ambiguousPeople.length + plan.familyConflicts.length;
  const managedCount = plan.updateManagedFields.length + plan.promoteToRegular.length + plan.demoteToLocalVisitor.length + plan.moveFamily.length + plan.reactivate.length;
  const gatheringCount = plan.addToGathering.length + plan.removeFromGathering.length;
  const destructiveCount = plan.archive.length + plan.removeFromGathering.length + plan.renameFamily.length;
  const skippedCount = plan.skipped.length + plan.unmatchedLocalRegulars.length;

  return (
    <div className="space-y-5 text-gray-900 dark:text-gray-100">
      <header className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-950 dark:text-white">{providerLabel(provider)} sync review</h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-300">
              Compare people and household context, then confirm the changes you want to apply.
            </p>
          </div>
          <ApplyControls applying={applying} disabled={applyDisabled} onApply={() => void submit()} onRefresh={onRefresh} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryCard label="Suggested matches" count={suggestedCount} />
          <SummaryCard label="Decisions needed" count={neededCount} tone={neededCount > 0 ? 'amber' : 'neutral'} />
          <SummaryCard label="New people" count={plan.addPeople.length} />
          <SummaryCard label="Managed updates" count={managedCount} />
          <SummaryCard label="Gathering changes" count={gatheringCount} />
          <SummaryCard label="Destructive changes" count={destructiveCount} tone={destructiveCount > 0 ? 'amber' : 'neutral'} />
        </div>
      </header>

      {unmatchedCoverageCount > 0 && (
        <div className="rounded-lg border border-gray-200 bg-stone-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          {unmatchedCoverageCount} active LMPG regulars are not matched to any currently configured {providerLabel(provider)} source. They will remain unchanged. Add another sync batch if they should be included.
        </div>
      )}

      {isV2 && reviewContext && (
        <Section title="Match decisions" count={Object.keys(reviewContext.identities).length} open>
          <div className="space-y-4">
            {Object.entries(reviewContext.identities).map(([externalId, entry]) => {
              const reason = plan.linkPeople.find((action) => action.externalPersonId === externalId)?.reason
                || plan.ambiguousPeople.find((action) => action.externalPersonId === externalId)?.reason
                || (entry.held ? 'review_deferred' : '');
              const claimedByOthers = new Set<number>();
              for (const [individualId, externalIds] of claims) {
                if (externalIds.some((candidateExternalId) => candidateExternalId !== externalId)) claimedByOthers.add(individualId);
              }
              return (
                <div key={externalId}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{externalPerson(externalId)}</p>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                      {MATCH_REASON_COPY[reason] || 'Needs review'}
                    </span>
                  </div>
                  <MatchDecisionCard
                    key={`${review.reviewToken}-${externalId}`}
                    provider={provider}
                    externalId={externalId}
                    entry={entry}
                    directory={directory}
                    decision={state.identityDecisions?.[externalId] ?? null}
                    claimedIndividualIds={claimedByOthers}
                    onChange={(decision) => setIdentityDecision(externalId, decision)}
                  />
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {!isV2 && (
        <LegacyIdentityDecisions
          review={review}
          state={state}
          setState={setState}
          renderCandidateSearch={renderCandidateSearch}
          renderCandidateLabel={renderCandidateLabel}
          resolveAmbiguousArchiveIndividualId={resolveAmbiguousArchiveIndividualId}
        />
      )}

      <Section title="New people" count={plan.addPeople.length + plan.addFamilies.length}>
        <ul className="space-y-2 text-sm">
          {plan.addPeople.map((action) => (
            <li key={action.id} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              {isV2 ? (
                <span>Add {action.firstName} {action.lastName}</span>
              ) : (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={!state.skippedExternalIds.has(action.externalPersonId)} onChange={() => toggleSkipped(action.externalPersonId)} />
                  Add {action.firstName} {action.lastName}
                </label>
              )}
            </li>
          ))}
          {plan.addFamilies.map((action) => <li key={action.id}>Add family {action.familyName}</li>)}
        </ul>
      </Section>

      <Section title="Managed updates" count={managedCount}>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          {plan.updateManagedFields.map((action) => <li key={action.id}>Update {localPerson(action.individualId)}</li>)}
          {plan.promoteToRegular.map((action) => <li key={action.id}>Make {localPerson(action.individualId)} a regular</li>)}
          {plan.demoteToLocalVisitor.map((action) => <li key={action.id}>Make {localPerson(action.individualId)} a local visitor</li>)}
          {plan.moveFamily.map((action) => <li key={action.id}>Move {localPerson(action.individualId)} to another family</li>)}
          {plan.reactivate.map((action) => <li key={action.id}>Reactivate {localPerson(action.individualId)}</li>)}
        </ul>
      </Section>

      <Section title="Gathering changes" count={gatheringCount}>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          {plan.addToGathering.map((action) => <li key={action.id}>Add {externalPerson(action.externalPersonId)} to a gathering</li>)}
          {plan.removeFromGathering.map((action) => <li key={action.id}>Remove {localPerson(action.individualId)} from a gathering</li>)}
        </ul>
      </Section>

      <Section title="Destructive changes" count={destructiveCount} tone="amber" open>
        <p className="mb-3 text-sm text-amber-900 dark:text-amber-100">This will archive people or remove them from gatherings. Review every change before applying.</p>
        <ul className="space-y-3 text-sm">
          {plan.archive.map((action) => (
            <li key={action.id}>
              <label className="flex items-start gap-2">
                <input type="checkbox" aria-label={`Archive ${localPerson(action.individualId)}`} checked={state.acceptedArchiveIds.has(action.individualId)} onChange={() => toggleArchive(action.individualId)} className="mt-0.5" />
                <span><span className="block font-medium">Archive {localPerson(action.individualId)}</span><span className="text-xs text-amber-800 dark:text-amber-200">{action.reason}</span></span>
              </label>
            </li>
          ))}
          {plan.removeFromGathering.map((action) => <li key={action.id}>Remove {localPerson(action.individualId)} from a gathering</li>)}
          {plan.renameFamily.map((action) => (
            <li key={action.id}>
              <label className="flex items-center gap-2"><input type="checkbox" checked={state.acceptedFamilyRenameIds.has(action.id)} onChange={() => toggleRename(action.id)} />Accept family rename to {action.familyName}</label>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Skipped or unchanged" count={skippedCount}>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          {plan.skipped.map((action) => <li key={action.id}>{externalPerson(action.externalPersonId)} will remain unchanged.</li>)}
          {plan.unmatchedLocalRegulars.map((action) => <li key={action.id}>{localPerson(action.individualId)} will remain unchanged.</li>)}
        </ul>
      </Section>

      {requiresConfirmation && (
        <label className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          <input type="checkbox" checked={confirmedDestructiveChanges} onChange={(event) => setConfirmedDestructiveChanges(event.target.checked)} className="mt-0.5" />
          I understand that this sync will archive people, remove gathering assignments, or rename families.
        </label>
      )}

      {(incompleteExternalIds.length > 0 || collisions.length > 0) && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          {incompleteExternalIds.map((externalId) => <p key={externalId}>{externalPerson(externalId)} needs a decision before you can apply this sync.</p>)}
          {collisions.map(([individualId, externalIds]) => (
            <p key={individualId}>{externalIds.map(externalPerson).join(' and ')} both select {localPerson(individualId)}. Choose a different person for one of them.</p>
          ))}
        </div>
      )}

      {applyError && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          {stale ? (
            <>
              <p className="font-medium">This review is out of date.</p>
              <p className="mt-1">At least one choice may no longer be available. Refresh the plan and review the affected people again.</p>
              {manualChoices.length > 0 && (
                <ul className="mt-2 list-disc pl-5">
                  {manualChoices.map((choice) => <li key={`${choice.external}-${choice.local}`}>{choice.external} → {choice.local}</li>)}
                </ul>
              )}
              <button type="button" className="mt-3 font-semibold underline underline-offset-2" onClick={() => void onRefresh()}>Refresh plan</button>
            </>
          ) : errorText(applyError)}
        </div>
      )}

      <footer className="flex flex-col gap-3 border-t border-gray-200 pt-5 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400">Nothing is changed until you apply this review.</p>
        <ApplyControls applying={applying} disabled={applyDisabled} onApply={() => void submit()} onRefresh={onRefresh} />
      </footer>
    </div>
  );
}
