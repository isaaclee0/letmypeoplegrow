import React from 'react';
import type { SyncSelectionState } from './syncSelections';
import type { ArchiveAction, IdentityDecision, PeopleSyncReview } from './types';

const ARCHIVE_REASON_COPY: Record<string, string> = {
  provider_state_archived: 'Archived in the provider',
  provider_state_deceased: 'Marked deceased in the provider',
};

function isTerminalArchive(action: ArchiveAction): boolean {
  return action.reason === 'provider_state_archived' || action.reason === 'provider_state_deceased';
}

function providerLabel(provider: PeopleSyncReview['plan']['provider']): string {
  return provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
}

function archiveReasonLabel(reason: string): string {
  if (ARCHIVE_REASON_COPY[reason]) return ARCHIVE_REASON_COPY[reason];
  if (!reason.includes('_')) return reason;
  const words = reason.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function displayName(person: { firstName: string; lastName: string } | undefined): string {
  return `${person?.firstName || ''} ${person?.lastName || ''}`.trim();
}

function decisionTarget(
  review: PeopleSyncReview,
  externalId: string,
  decision: IdentityDecision | null | undefined,
): number | null {
  if (decision?.outcome === 'accept') {
    return review.plan.reviewContext?.identities[externalId]?.suggestedIndividualId ?? null;
  }
  if (decision?.outcome === 'link') return decision.individualId;
  return null;
}

export function deriveSyncPlanView(review: PeopleSyncReview, state: SyncSelectionState) {
  const { plan } = review;
  const isV2 = review.decisionContractVersion === 2 && plan.reviewContext?.version === 2;
  const rejectedSuggestedExternalIds = new Set<string>();
  const rejectedSuggestedIndividualIds = new Set<number>();
  const deferredExternalIds: string[] = [];

  if (isV2 && plan.reviewContext) {
    for (const [externalId, entry] of Object.entries(plan.reviewContext.identities)) {
      const decision = state.identityDecisions?.[externalId];
      if (decision?.outcome === 'defer') deferredExternalIds.push(externalId);
      if (entry.suggestedIndividualId !== null
        && decisionTarget(review, externalId, decision) !== entry.suggestedIndividualId) {
        rejectedSuggestedExternalIds.add(externalId);
        rejectedSuggestedIndividualIds.add(entry.suggestedIndividualId);
      }
    }
  }

  const suggestionStillAccepted = (action: { externalPersonId?: string; individualId?: number | null }) =>
    !(action.externalPersonId && rejectedSuggestedExternalIds.has(action.externalPersonId))
    && !(action.individualId != null && rejectedSuggestedIndividualIds.has(action.individualId));
  const gatheringAdditionStillSelected = (action: { externalPersonId: string; individualId: number | null }) => {
    if (!suggestionStillAccepted(action)) return false;
    if (action.individualId !== null) return true;
    return state.identityDecisions?.[action.externalPersonId]?.outcome === 'create';
  };

  return {
    updateManagedFields: isV2 ? plan.updateManagedFields.filter(suggestionStillAccepted) : plan.updateManagedFields,
    promoteToRegular: isV2
      ? plan.promoteToRegular.filter(suggestionStillAccepted)
      : plan.promoteToRegular.filter((action) => !action.reviewRequired),
    demoteToLocalVisitor: isV2 ? plan.demoteToLocalVisitor.filter(suggestionStillAccepted) : plan.demoteToLocalVisitor,
    moveFamily: isV2 ? plan.moveFamily.filter(suggestionStillAccepted) : plan.moveFamily,
    linkFamilies: plan.linkFamilies,
    addFamilies: plan.addFamilies,
    renameFamily: plan.renameFamily,
    addToGathering: isV2 ? plan.addToGathering.filter(gatheringAdditionStillSelected) : plan.addToGathering,
    removeFromGathering: isV2 ? plan.removeFromGathering.filter(suggestionStillAccepted) : plan.removeFromGathering,
    archive: (isV2 ? plan.archive.filter(suggestionStillAccepted) : plan.archive).filter(isTerminalArchive),
    reactivate: isV2 ? plan.reactivate.filter(suggestionStillAccepted) : plan.reactivate,
    skipped: plan.skipped,
    unmatchedLocalRegulars: plan.unmatchedLocalRegulars,
    deferredExternalIds,
  };
}

function CompactSection({
  title,
  count,
  children,
  tone = 'neutral',
  open = false,
}: {
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
    <details open={open} className={`group overflow-hidden rounded-lg border ${toneClasses}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500">
        <span className="text-sm font-semibold text-gray-950 dark:text-white">{title}</span>
        <span className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          {count}
          <span aria-hidden="true" className="text-base transition-transform group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">{children}</div>
    </details>
  );
}

function DenseChangeList({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">{children}</ul>;
}

export interface SyncPlanSectionsProps {
  review: PeopleSyncReview;
  state: SyncSelectionState;
  archiveActions: ArchiveAction[];
  onStateChange: (state: SyncSelectionState) => void;
  onAcceptAllArchives: () => void;
}

export default function SyncPlanSections({
  review,
  state,
  archiveActions,
  onStateChange,
  onAcceptAllArchives,
}: SyncPlanSectionsProps) {
  const view = deriveSyncPlanView(review, state);
  const directory = review.plan.people || { external: {}, local: {} };
  const terminalArchiveActions = archiveActions.filter(isTerminalArchive);
  const localOnlyCount = review.coverage?.unlinkedActiveLocalRegulars ?? 0;
  const externalPerson = (id: string) => displayName(directory.external[id]) || 'External person';
  const localPerson = (id: number) => displayName(directory.local[String(id)]) || 'Local person';

  const toggleArchive = (individualId: number) => {
    const acceptedArchiveIds = new Set(state.acceptedArchiveIds);
    if (acceptedArchiveIds.has(individualId)) acceptedArchiveIds.delete(individualId);
    else acceptedArchiveIds.add(individualId);
    onStateChange({ ...state, acceptedArchiveIds });
  };
  const toggleRename = (actionId: string) => {
    const acceptedFamilyRenameIds = new Set(state.acceptedFamilyRenameIds);
    if (acceptedFamilyRenameIds.has(actionId)) acceptedFamilyRenameIds.delete(actionId);
    else acceptedFamilyRenameIds.add(actionId);
    onStateChange({ ...state, acceptedFamilyRenameIds });
  };

  const managedCount = view.updateManagedFields.length
    + view.promoteToRegular.length
    + view.demoteToLocalVisitor.length;
  const familyCount = view.linkFamilies.length
    + view.addFamilies.length
    + view.moveFamily.length
    + view.renameFamily.length;
  const gatheringCount = view.addToGathering.length + view.removeFromGathering.length;
  const lifecycleCount = terminalArchiveActions.length + localOnlyCount;
  const skippedCount = view.skipped.length
    + view.unmatchedLocalRegulars.length
    + view.deferredExternalIds.length;

  return (
    <div className="space-y-3" aria-label="Planned non-identity changes">
      <CompactSection title="Managed person updates" count={managedCount}>
        <DenseChangeList>
          {view.updateManagedFields.map((action) => <li key={action.id}>Update {localPerson(action.individualId)}</li>)}
          {view.promoteToRegular.map((action) => <li key={action.id}>Make {localPerson(action.individualId)} a regular</li>)}
          {view.demoteToLocalVisitor.map((action) => <li key={action.id}>Make {localPerson(action.individualId)} a local visitor</li>)}
        </DenseChangeList>
      </CompactSection>

      <CompactSection
        title="Family changes"
        count={familyCount}
        open={view.renameFamily.length > 0}
        tone={view.renameFamily.length > 0 ? 'amber' : 'neutral'}
      >
        <DenseChangeList>
          {view.linkFamilies.map((action) => <li key={action.id}>Link a provider family to an LMPG family</li>)}
          {view.addFamilies.map((action) => <li key={action.id}>Add family {action.familyName}</li>)}
          {view.moveFamily.map((action) => <li key={action.id}>Move {localPerson(action.individualId)} to another family</li>)}
          {view.renameFamily.map((action) => (
            <li key={action.id}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.acceptedFamilyRenameIds.has(action.id)}
                  onChange={() => toggleRename(action.id)}
                />
                Accept family rename to {action.familyName}
              </label>
            </li>
          ))}
        </DenseChangeList>
      </CompactSection>

      <CompactSection
        title="Gathering changes"
        count={gatheringCount}
        open={view.removeFromGathering.length > 0}
        tone={view.removeFromGathering.length > 0 ? 'amber' : 'neutral'}
      >
        <DenseChangeList>
          {view.addToGathering.map((action) => <li key={action.id}>Add {externalPerson(action.externalPersonId)} to a gathering</li>)}
          {view.removeFromGathering.map((action) => <li key={action.id}>Remove {localPerson(action.individualId)} from a gathering</li>)}
        </DenseChangeList>
      </CompactSection>

      <CompactSection
        title="Lifecycle review"
        count={lifecycleCount}
        open
        tone={terminalArchiveActions.length > 0 ? 'amber' : 'neutral'}
      >
        {terminalArchiveActions.length > 0 && (
          <div>
            <h4 className="mb-2 text-sm font-semibold text-gray-950 dark:text-white">Proposed archives</h4>
            <button
              type="button"
              onClick={onAcceptAllArchives}
              className="mb-3 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-600 dark:bg-gray-800 dark:text-amber-100 dark:hover:bg-amber-950/50"
            >
              Accept all proposed archives
            </button>
            <DenseChangeList>
              {terminalArchiveActions.map((action) => (
                <li key={action.id}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Archive ${localPerson(action.individualId)}`}
                      checked={state.acceptedArchiveIds.has(action.individualId)}
                      onChange={() => toggleArchive(action.individualId)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block font-medium">Archive {localPerson(action.individualId)}</span>
                      <span className="text-xs text-amber-800 dark:text-amber-200">{archiveReasonLabel(action.reason)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </DenseChangeList>
          </div>
        )}

        {localOnlyCount > 0 && (
          <div className={terminalArchiveActions.length > 0 ? 'mt-4 border-t border-gray-200 pt-4 dark:border-gray-700' : ''}>
            <h4 className="text-sm font-semibold text-gray-950 dark:text-white">Local-only people</h4>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
              {localOnlyCount} active LMPG regular {localOnlyCount === 1 ? 'person is' : 'people are'} not linked to {providerLabel(review.plan.provider)}. They are retained in LMPG until you decide otherwise.
            </p>
            <a
              href="/app/people?externalSource=unlinked"
              className="mt-2 inline-flex text-sm font-semibold text-primary-700 hover:underline dark:text-primary-300"
            >
              Review Not linked people
            </a>
          </div>
        )}
      </CompactSection>

      <CompactSection title="Reactivations" count={view.reactivate.length}>
        <DenseChangeList>
          {view.reactivate.map((action) => <li key={action.id}>Reactivate {localPerson(action.individualId)}</li>)}
        </DenseChangeList>
      </CompactSection>

      <CompactSection title="Skipped or unchanged" count={skippedCount}>
        <DenseChangeList>
          {view.skipped.map((action) => <li key={action.id}>{externalPerson(action.externalPersonId)} will remain unchanged.</li>)}
          {view.unmatchedLocalRegulars.map((action) => <li key={action.id}>{localPerson(action.individualId)} will remain unchanged.</li>)}
          {view.deferredExternalIds.map((externalId) => <li key={`deferred:${externalId}`}>{externalPerson(externalId)} will be skipped for now.</li>)}
        </DenseChangeList>
      </CompactSection>
    </div>
  );
}
