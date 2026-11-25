import React from 'react';
import type { PeopleSyncReview } from './types';

export function unresolvedLinkedPeople(review: PeopleSyncReview) {
  return review.plan.ambiguousPeople.filter((action) => action.staleLinkedIndividualIds?.length
    && !review.plan.reviewContext?.identities[action.externalPersonId]);
}

// Invalid links outside every source cannot enter the source-scoped identity
// picker. Keep the held records visible without offering an unsafe new match.
export default function UnresolvedLinkWarnings({ review }: { review: PeopleSyncReview }) {
  const issues = unresolvedLinkedPeople(review);
  if (!issues.length) return null;
  const directory = review.plan.people?.local || {};
  return <section aria-label="Linked people needing review" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
    <h4 className="font-semibold">Linked people needing review</h4>
    <p className="mt-1">These links conflict with the current LMPG records. Check the linked people before syncing them. They will remain unchanged.</p>
    <ul className="mt-2 list-disc pl-5">{issues.map((action) => <li key={action.id}>
      {action.staleLinkedIndividualIds!.map((id) => {
        const person = directory[String(id)];
        return person ? `${person.firstName} ${person.lastName}`.trim() : `Linked LMPG record #${id}`;
      }).join(' and ')}
    </li>)}</ul>
  </section>;
}
