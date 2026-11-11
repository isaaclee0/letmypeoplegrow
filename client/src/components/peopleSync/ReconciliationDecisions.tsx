import React from 'react';
import type { FamilyConflictAction, PeopleSyncReview } from './types';
import type { SyncSelectionState } from './syncSelections';

const reasonCopy: Record<string, string> = {
  household_member_outside_source: 'This move would separate members of the same household. One of them is outside the source list.',
  multiple_local_families: 'These people share a household in the source but have separate families in LMPG.',
  unresolved_household_members: 'Match the household members first, then refresh this review. Members outside the source list will not be imported.',
  invalid_existing_family_link: 'The existing household link needs checking before the family can be updated.',
  missing_family_name: 'The source household needs a name before it can be added.',
  multiple_provider_households: 'Some people belong to more than one source household. LMPG supports one family per person and can’t choose between them automatically.',
  provider_has_no_household: 'The source no longer places this person in a household.',
  unknown_household_membership: 'Household details are incomplete or inconsistent in this sync. Refresh the review; if this persists, the connection or sync needs checking.',
  conflicting_family_ownership: 'This LMPG family is already linked to a different source household. Check those household links first.',
};

export function reconciliationCounts(review: PeopleSyncReview, state: SyncSelectionState) {
  const families = review.plan.familyConflicts;
  const removals = review.plan.removeFromGathering.filter((action) => action.reviewRequired);
  const selectedFamilies = families.filter((action) => action.id && action.resolution
    && state.acceptedFamilyResolutionIds?.has(action.id)).length;
  const selectedRemovals = removals.filter((action) => state.acceptedGatheringRemovalIds?.has(action.id)).length;
  return { selectedFamilies, selectedRemovals, pending: families.length + removals.length - selectedFamilies - selectedRemovals };
}

function name(person: { firstName: string; lastName: string } | undefined) {
  return person ? `${person.firstName} ${person.lastName}`.trim() : 'Person awaiting a match';
}

export default function ReconciliationDecisions({ review, state, onStateChange }: {
  review: PeopleSyncReview;
  state: SyncSelectionState;
  onStateChange: (state: SyncSelectionState) => void;
}) {
  const provider = review.plan.provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
  const directory = review.plan.people || { external: {}, local: {} };
  const removals = review.plan.removeFromGathering.filter((action) => action.reviewRequired);
  const toggle = (key: 'acceptedFamilyResolutionIds' | 'acceptedGatheringRemovalIds', id: string) => {
    const ids = new Set(state[key]);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    onStateChange({ ...state, [key]: ids });
  };
  const householdName = (action: FamilyConflictAction) => {
    const family = directory.external[action.memberExternalIds?.[0] || '']?.family;
    return action.externalFamilyName || (family?.state === 'known' ? family.name : '')
      || (action.resolution?.kind === 'single_person' ? 'Single-person family' : '')
      || (action.resolution?.kind === 'detach' ? 'No source household' : 'Household needs review');
  };
  const localParticipants = (action: FamilyConflictAction) => {
    const people = new Map<number, { individualId: number; fromFamilyId?: number | null; candidate: boolean }>();
    const context = review.plan.reviewContext;
    const links = context?.projectedEstablishedLinks ?? context?.establishedLinks ?? {};
    for (const externalId of action.memberExternalIds || []) {
      const established = links[externalId]?.individualId;
      const legacyLink = review.plan.linkPeople.find((link) => link.externalPersonId === externalId && !link.reviewRequired)?.individualId;
      const linkedId = established ?? legacyLink;
      if (linkedId !== undefined) people.set(linkedId, { individualId: linkedId, candidate: false });
      else {
        const candidates = context?.identities[externalId]?.candidateIndividualIds
          || review.plan.ambiguousPeople.find((person) => person.externalPersonId === externalId)?.candidateIndividualIds || [];
        for (const individualId of candidates) {
          if (!people.has(individualId)) people.set(individualId, { individualId, candidate: true });
        }
      }
    }
    for (const move of action.resolution?.moves || []) people.set(move.individualId, { ...move, candidate: false });
    return [...people.values()];
  };
  const panel = 'overflow-hidden rounded-xl border border-amber-200 bg-white dark:border-amber-800 dark:bg-gray-800';
  return <div className="space-y-5">
    {review.plan.familyConflicts.length > 0 && (
      <section aria-label="Household decisions" className={panel}>
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
          <h4 className="font-semibold">Household decisions <span className="ml-2 text-sm font-normal">{review.plan.familyConflicts.length}</span></h4>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">Choose which families to update. Unselected households stay unchanged and remain available for review.</p>
        </div>
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {review.plan.familyConflicts.map((action, index) => {
            const resolution = action.resolution;
            const members = resolution?.moves || [];
            const participants = localParticipants(action);
            const selected = !!action.id && !!resolution && !!state.acceptedFamilyResolutionIds?.has(action.id);
            const title = householdName(action);
            const destination = resolution?.destination;
            const result = destination?.kind === 'none' ? 'Separate from the current family'
              : destination?.kind === 'create' ? destination.familyName
                : destination?.kind === 'existing' ? destination.familyName || title : null;
            return <li key={action.id || index} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="font-semibold">{title}</h5>
                <span className={`text-xs font-medium ${selected ? 'text-green-700 dark:text-green-300' : 'text-amber-800 dark:text-amber-200'}`}>
                  {selected ? 'Selected for update' : resolution ? 'Waiting for your choice' : 'Needs more information'}
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {resolution?.kind === 'single_person'
                  ? `Create a family in LMPG using this person’s name. A household added in ${provider} later will still be reviewed.`
                  : reasonCopy[action.reason || ''] || 'The source household and LMPG family do not agree. Review the people below before updating.'}
              </p>
              <div className="grid gap-3 rounded-lg bg-stone-50 p-3 text-sm dark:bg-gray-900/50 md:grid-cols-3">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{provider}</p>
                  <p>{resolution?.kind === 'single_person' ? `No household in ${provider}` : resolution?.kind === 'detach' ? 'No household' : title}</p>
                  <p className="mt-1 text-gray-600 dark:text-gray-300">{(action.memberExternalIds || []).map((id) => name(directory.external[id])).join(', ')}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">LMPG now</p>
                  {participants.length > 0 ? <ul className="space-y-2">{participants.map((member) => {
                    const person = directory.local[String(member.individualId)];
                    return <li key={member.individualId}>
                      <p className="font-medium">{name(person)}{member.candidate && <span className="ml-1 font-normal text-amber-800 dark:text-amber-200">(possible match)</span>}</p>
                      <p className="text-gray-600 dark:text-gray-300">{person?.family?.state === 'known' ? person.family.name : person?.family?.state === 'none' || member.fromFamilyId === null ? 'No family' : 'Family details unavailable'}</p>
                    </li>;
                  })}</ul> : <p>Household membership needs checking.</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">After applying</p>
                  <p className="font-medium">{result || 'Leave unchanged for now'}</p>
                  {resolution && <p className="mt-1 text-gray-600 dark:text-gray-300">Attendance is kept. People outside this action stay in their current families.</p>}
                </div>
              </div>
              {resolution && action.id ? <label className="flex cursor-pointer items-start gap-3 text-sm font-semibold">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={selected}
                  onChange={() => toggle('acceptedFamilyResolutionIds', action.id!)} />
                {resolution.kind === 'single_person'
                  ? `Create a single-person family for ${members.map((member) => name(directory.local[String(member.individualId)])).join(' and ')}`
                  : resolution.kind === 'detach'
                  ? `Separate ${members.map((member) => name(directory.local[String(member.individualId)])).join(' and ')} from their current family`
                  : `Use ${provider} household for ${members.map((member) => name(directory.local[String(member.individualId)])).join(' and ')}`}
              </label> : <p className="text-sm font-medium text-amber-900 dark:text-amber-200">No household changes will be applied for this issue.</p>}
            </li>;
          })}
        </ul>
      </section>
    )}
    {removals.length > 0 && <section aria-label="Attendance-list decisions" className={panel}>
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
        <h4 className="font-semibold">Attendance-list decisions <span className="ml-2 text-sm font-normal">{removals.length}</span></h4>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">These older list entries are no longer included by a source for this gathering. Choose who should leave the attendance list.</p>
        <p className="mt-1 text-sm font-medium">Past attendance is kept. People remain in LMPG and are not archived.</p>
      </div>
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {removals.map((action) => <li key={action.id} className="p-4">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={!!state.acceptedGatheringRemovalIds?.has(action.id)}
              onChange={() => toggle('acceptedGatheringRemovalIds', action.id)} />
            <span>
              <span className="block font-semibold">Remove {name(directory.local[String(action.individualId)])} from {action.gatheringName || action.sourceNames?.join(' / ') || 'this attendance list'}</span>
              <span className="mt-1 block text-gray-600 dark:text-gray-300">{provider}: outside the source list · LMPG: still on the attendance list</span>
            </span>
          </label>
        </li>)}
      </ul>
    </section>}
  </div>;
}
