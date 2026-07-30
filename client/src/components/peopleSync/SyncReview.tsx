import React, { useEffect, useState } from 'react';
import { buildSyncSelections, type SyncSelectionState, type VisitorChoice } from './syncSelections';
import type { AmbiguousPersonAction, PeopleSyncReview, PeopleSyncSelections, SyncProvider } from './types';

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

const emptyState = (): SyncSelectionState => ({
  ambiguousChoices: {},
  skippedExternalIds: new Set(),
  visitorChoices: {},
  acceptedArchiveIds: new Set(),
  acceptedFamilyRenameIds: new Set(),
});

function PlanItem({ children }: { children: React.ReactNode; key?: React.Key }) {
  return <li className="border border-gray-200 dark:border-gray-700 rounded-md p-3 text-sm text-gray-900 dark:text-gray-100">{children}</li>;
}

function ErrorMessage({ error, onRefresh }: { error: unknown; onRefresh: () => void | Promise<void> }) {
  const message = error instanceof Error ? error.message : 'Failed to apply sync.';
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: string; response?: { data?: { code?: string } } }).code
      || (error as { response?: { data?: { code?: string } } }).response?.data?.code
    : undefined;
  const stale = code === 'STALE_REVIEW' || /stale/i.test(message);

  return (
    <div className="text-sm text-red-600 dark:text-red-400" role="alert">
      {message}{' '}
      {stale && <button type="button" className="underline" onClick={() => void onRefresh()}>Refresh plan</button>}
    </div>
  );
}

export default function SyncReview({ provider, review, onRefresh, onApply, applying, renderCandidateSearch, renderCandidateLabel, resolveAmbiguousArchiveIndividualId, requireAllPlannedArchivesAccepted = false }: SyncReviewProps) {
  const [state, setState] = useState<SyncSelectionState>(emptyState);
  const [confirmedDestructiveChanges, setConfirmedDestructiveChanges] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const { plan } = review;
  const unmatchedCoverageCount = review.coverage?.unmatchedActiveLocalRegulars ?? 0;
  const displayName = (person: { firstName: string; lastName: string } | undefined) =>
    `${person?.firstName || ''} ${person?.lastName || ''}`.trim();
  const externalPerson = (externalPersonId: string) =>
    displayName(plan.people?.external[externalPersonId]) || `external person ${externalPersonId}`;
  const localPerson = (individualId: number) =>
    displayName(plan.people?.local[String(individualId)]) || `person ${individualId}`;

  useEffect(() => {
    setState(emptyState());
    setConfirmedDestructiveChanges(false);
    setApplyError(null);
  }, [review.reviewToken]);

  const toggleSkipped = (externalId: string) => setState((previous) => {
    const skippedExternalIds = new Set(previous.skippedExternalIds);
    if (skippedExternalIds.has(externalId)) skippedExternalIds.delete(externalId); else skippedExternalIds.add(externalId);
    return { ...previous, skippedExternalIds };
  });
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
  const selectCandidate = (externalPersonId: string, candidateId: number, archiveIndividualId?: number) => setState((previous) => {
    const acceptedArchiveIds = new Set(previous.acceptedArchiveIds);
    if (archiveIndividualId !== undefined) acceptedArchiveIds.delete(archiveIndividualId);
    return { ...previous, acceptedArchiveIds, ambiguousChoices: { ...previous.ambiguousChoices, [externalPersonId]: candidateId } };
  });
  const chooseVisitor = (externalPersonId: string, choice: VisitorChoice | null) => setState((previous) => ({
    ...previous,
    visitorChoices: { ...previous.visitorChoices, [externalPersonId]: choice },
  }));

  const requiresConfirmation = plan.archive.length > 0
    || plan.removeFromGathering.length > 0
    || state.acceptedFamilyRenameIds.size > 0
    || state.acceptedArchiveIds.size > 0;
  const allPlannedArchivesAccepted = !requireAllPlannedArchivesAccepted || plan.archive.every((action) => state.acceptedArchiveIds.has(action.individualId));
  const submit = async () => {
    setApplyError(null);
    try {
      await onApply(review.reviewToken, buildSyncSelections(state));
    } catch (error) {
      setApplyError(error);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{providerLabel(provider)} sync review</h3>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {Object.entries(review.summary).map(([bucket, count]) => (
            <span key={bucket} className="rounded bg-gray-100 px-2 py-1 text-gray-800 dark:bg-gray-700 dark:text-gray-100">{bucket}: {count}</span>
          ))}
        </div>
      </div>

      {unmatchedCoverageCount > 0 && (
        <section className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          {unmatchedCoverageCount} active LMPG regulars are not matched to any currently configured {providerLabel(provider)} source. They will remain unchanged. Add another sync batch if they should be included.
        </section>
      )}

      {(plan.ambiguousPeople.length > 0 || plan.familyConflicts.length > 0 || plan.promoteToRegular.some((action) => action.reviewRequired)) && (
        <section>
          <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Needs your decision</h4>
          <ul className="space-y-3">
            {plan.ambiguousPeople.map((action) => (
              <PlanItem key={action.id}>
                <p className="mb-2">{externalPerson(action.externalPersonId)} — {action.reason}</p>
                <div className="space-y-1">
                  {(() => {
                    const archiveIndividualId = resolveAmbiguousArchiveIndividualId?.(action);
                    return <>
                  {(action.candidateIndividualIds || []).map((candidateId) => (
                    <label key={candidateId} className="flex items-center gap-2">
                      <input type="radio" name={`ambiguous-${action.id}`} checked={state.ambiguousChoices[action.externalPersonId] === candidateId}
                        onChange={() => selectCandidate(action.externalPersonId, candidateId, archiveIndividualId)} />
                      <span>{renderCandidateLabel ? renderCandidateLabel(action, candidateId) : `Use ${localPerson(candidateId)} for ${externalPerson(action.externalPersonId)}`}</span>
                    </label>
                  ))}
                  {archiveIndividualId !== undefined && <label className="flex items-center gap-2">
                    <input type="radio" name={`ambiguous-${action.id}`} checked={state.acceptedArchiveIds.has(archiveIndividualId)} onChange={() => setState((previous) => ({
                      ...previous,
                      ambiguousChoices: { ...previous.ambiguousChoices, [action.externalPersonId]: null },
                      acceptedArchiveIds: new Set(previous.acceptedArchiveIds).add(archiveIndividualId),
                    }))} />
                    <span>Archive this person</span>
                  </label>}
                  <label className="flex items-center gap-2">
                    <input type="radio" name={`ambiguous-${action.id}`} checked={state.ambiguousChoices[action.externalPersonId] === null}
                      onChange={() => setState((previous) => {
                        const acceptedArchiveIds = new Set(previous.acceptedArchiveIds);
                        if (archiveIndividualId !== undefined) acceptedArchiveIds.delete(archiveIndividualId);
                        return { ...previous, acceptedArchiveIds, ambiguousChoices: { ...previous.ambiguousChoices, [action.externalPersonId]: null } };
                      })} />
                    <span>Decide later</span>
                  </label>
                  {renderCandidateSearch?.({ action, selectCandidate: (candidateId) => selectCandidate(action.externalPersonId, candidateId, archiveIndividualId) })}
                    </>;
                  })()}
                </div>
              </PlanItem>
            ))}
            {plan.familyConflicts.map((conflict, index) => <PlanItem key={conflict.id || index}>{String(conflict.reason || 'Family conflict requires review')}</PlanItem>)}
            {plan.promoteToRegular.filter((action) => action.reviewRequired).map((action) => (
              <PlanItem key={action.id}>
                <p className="mb-2">{localPerson(action.individualId)} — {action.reason}</p>
                <label className="mr-4"><input type="radio" name={`visitor-${action.id}`} checked={state.visitorChoices[action.externalPersonId] === 'promote'} onChange={() => chooseVisitor(action.externalPersonId, 'promote')} /> Promote {localPerson(action.individualId)}</label>
                <label><input type="radio" name={`visitor-${action.id}`} checked={state.visitorChoices[action.externalPersonId] === 'keep'} onChange={() => chooseVisitor(action.externalPersonId, 'keep')} /> Keep as visitor</label>
              </PlanItem>
            ))}
          </ul>
        </section>
      )}

      {(plan.archive.length > 0 || plan.removeFromGathering.length > 0 || plan.renameFamily.length > 0) && (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30">
          <h4 className="mb-1 text-sm font-semibold text-amber-900 dark:text-amber-100">Destructive changes</h4>
          <p className="mb-3 text-xs text-amber-800 dark:text-amber-200">This will archive people or remove them from gatherings. Review every change before applying.</p>
          <ul className="space-y-2">
            {plan.archive.map((action) => <li key={action.id}><label className="flex items-center gap-2"><input type="checkbox" checked={state.acceptedArchiveIds.has(action.individualId)} onChange={() => toggleArchive(action.individualId)} />Archive {localPerson(action.individualId)}</label><span className="ml-6 text-xs">{action.reason}</span></li>)}
            {plan.removeFromGathering.map((action) => <li key={action.id}>Remove {localPerson(action.individualId)} from gathering {action.gatheringTypeId}: {action.reason}</li>)}
            {plan.renameFamily.map((action) => <li key={action.id}><label className="flex items-center gap-2"><input type="checkbox" checked={state.acceptedFamilyRenameIds.has(action.id)} onChange={() => toggleRename(action.id)} />Accept family rename to {action.familyName}</label></li>)}
          </ul>
        </section>
      )}

      {(plan.linkPeople.length > 0 || plan.linkFamilies.length > 0 || plan.reactivate.length > 0) && <section><h4 className="mb-2 text-sm font-semibold">Links and restores</h4><ul className="space-y-1 text-sm">{plan.linkPeople.map((action) => <li key={action.id}>Link {externalPerson(action.externalPersonId)} to {localPerson(action.individualId)}</li>)}{plan.linkFamilies.map((action) => <li key={action.id}>Link external family {action.externalFamilyId} to family {action.familyId}</li>)}{plan.reactivate.map((action) => <li key={action.id}>Restore {localPerson(action.individualId)}</li>)}</ul></section>}
      {(plan.addPeople.length > 0 || plan.addFamilies.length > 0) && <section><h4 className="mb-2 text-sm font-semibold">Adds</h4><ul className="space-y-1 text-sm">{plan.addPeople.map((action) => <li key={action.id}><label className="flex items-center gap-2"><input type="checkbox" checked={!state.skippedExternalIds.has(action.externalPersonId)} onChange={() => toggleSkipped(action.externalPersonId)} />Add {action.firstName} {action.lastName}</label></li>)}{plan.addFamilies.map((action) => <li key={action.id}>Add family {action.familyName}</li>)}</ul></section>}
      {(plan.updateManagedFields.length > 0 || plan.promoteToRegular.some((action) => !action.reviewRequired) || plan.demoteToLocalVisitor.length > 0 || plan.moveFamily.length > 0) && <section><h4 className="mb-2 text-sm font-semibold">Managed updates</h4><ul className="space-y-1 text-sm">{plan.updateManagedFields.map((action) => <li key={action.id}>Update {localPerson(action.individualId)}: {action.reason}</li>)}{plan.promoteToRegular.filter((action) => !action.reviewRequired).map((action) => <li key={action.id}>Promote {localPerson(action.individualId)}</li>)}{plan.demoteToLocalVisitor.map((action) => <li key={action.id}>Make {localPerson(action.individualId)} a local visitor</li>)}{plan.moveFamily.map((action) => <li key={action.id}>Move {localPerson(action.individualId)} to family {action.familyId}</li>)}</ul></section>}
      {(plan.addToGathering.length > 0 || plan.removeFromGathering.length > 0) && <section><h4 className="mb-2 text-sm font-semibold">Gathering changes</h4><ul className="space-y-1 text-sm">{plan.addToGathering.map((action) => <li key={action.id}>Add {externalPerson(action.externalPersonId)} to gathering {action.gatheringTypeId}</li>)}{plan.removeFromGathering.map((action) => <li key={action.id}>Remove {localPerson(action.individualId)} from gathering {action.gatheringTypeId}</li>)}</ul></section>}
      {plan.skipped.length > 0 && <section><h4 className="mb-2 text-sm font-semibold">Skipped</h4><ul className="space-y-1 text-sm">{plan.skipped.map((action) => <li key={action.id}>{externalPerson(action.externalPersonId)}: {action.reason}</li>)}</ul></section>}

      {requiresConfirmation && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmedDestructiveChanges} onChange={(event) => setConfirmedDestructiveChanges(event.target.checked)} />I understand that this sync will archive people, remove gathering assignments, or rename families.</label>}
      {applyError && <ErrorMessage error={applyError} onRefresh={onRefresh} />}
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void submit()} disabled={applying || !allPlannedArchivesAccepted || (requiresConfirmation && !confirmedDestructiveChanges)} className="inline-flex items-center rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">{applying ? 'Applying…' : 'Apply sync'}</button>
        <button type="button" onClick={() => void onRefresh()} disabled={applying} className="text-sm underline text-gray-600 dark:text-gray-300">Refresh plan</button>
      </div>
    </div>
  );
}
