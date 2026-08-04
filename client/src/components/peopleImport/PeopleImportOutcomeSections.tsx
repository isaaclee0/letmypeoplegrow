import React from 'react';
import type { SyncSelectionState } from '../peopleSync/syncSelections';
import type { PeopleSyncPlan, PeopleSyncReview } from '../peopleSync/types';
import { hasForbiddenImportMutations } from './types';

function displayName(person: { firstName: string; lastName: string } | undefined): string {
  return `${person?.firstName || ''} ${person?.lastName || ''}`.trim();
}

function peopleTypeLabel(value: unknown): string {
  if (value === 'regular') return 'regular';
  if (value === 'local_visitor') return 'local visitor';
  if (value === 'traveller_visitor') return 'traveller visitor';
  return 'person';
}

function listNames(names: string[]): string {
  if (names.length < 2) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

function memberExternalIds(action: Record<string, unknown>): string[] {
  return Array.isArray(action.memberExternalIds)
    ? action.memberExternalIds.filter((value): value is string => typeof value === 'string')
    : [];
}

function operationMarkersMatch(review: PeopleSyncReview): boolean {
  const reviewMarker = (review as PeopleSyncReview & { operationKind?: unknown }).operationKind;
  const planMarker = (review.plan as PeopleSyncPlan & { operationKind?: unknown }).operationKind;
  return reviewMarker === 'people_import' && planMarker === 'people_import';
}

function ReadOnlySection({ title, count, children }: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <details open className="group overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500">
        <span className="text-sm font-semibold text-gray-950 dark:text-white">{title}</span>
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{count}</span>
      </summary>
      <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">
        {children}
      </div>
    </details>
  );
}

export default function PeopleImportOutcomeSections({ review, state }: {
  review: PeopleSyncReview;
  state: SyncSelectionState;
}) {
  if (!operationMarkersMatch(review) || hasForbiddenImportMutations(review)) return null;

  const { plan } = review;
  if (![plan.linkFamilies, plan.addFamilies, plan.familyConflicts, plan.skipped].every(Array.isArray)) {
    return null;
  }
  const directory = plan.people || { external: {}, local: {} };
  const externalPerson = (externalId: string) =>
    displayName(directory.external[externalId]) || 'External person';
  const createOutcomes = Object.entries(state.identityDecisions || {}).flatMap(([externalId, decision]) => {
    if (decision?.outcome !== 'create') return [];
    const createPerson = plan.reviewContext?.identities[externalId]?.createPerson;
    if (!createPerson) return [];
    return [{ externalId, peopleType: createPerson.peopleType }];
  });
  const familyOutcomes = [...plan.addFamilies, ...plan.linkFamilies];

  return (
    <section className="space-y-3" aria-label="Planned import outcomes">
      <ReadOnlySection title="New people" count={createOutcomes.length}>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          {createOutcomes.map(({ externalId, peopleType }) => (
            <li key={externalId}>Add {externalPerson(externalId)} as a {peopleTypeLabel(peopleType)}.</li>
          ))}
        </ul>
      </ReadOnlySection>

      <ReadOnlySection title="Family additions and links" count={familyOutcomes.length}>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          {plan.addFamilies.map((action) => <li key={action.id}>Add family {action.familyName}.</li>)}
          {plan.linkFamilies.map((action) => (
            <li key={action.id}>Link a provider household to an existing LMPG family.</li>
          ))}
        </ul>
      </ReadOnlySection>

      <ReadOnlySection title="Families needing review" count={plan.familyConflicts.length}>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          {plan.familyConflicts.map((action, index) => {
            const names = memberExternalIds(action)
              .map(externalPerson)
              .filter((name) => name !== 'External person');
            return (
              <li key={typeof action.id === 'string' ? action.id : `family-conflict-${index}`}>
                {names.length > 0
                  ? `The household containing ${listNames(names)} needs review and will not be added or linked.`
                  : 'A provider household needs review and will not be added or linked.'}
              </li>
            );
          })}
        </ul>
      </ReadOnlySection>

      <ReadOnlySection title="People not imported" count={plan.skipped.length}>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          {plan.skipped.map((action) => (
            <li key={action.id}>{externalPerson(action.externalPersonId)} will not be imported in this review.</li>
          ))}
        </ul>
      </ReadOnlySection>
    </section>
  );
}
