import React from 'react';
import type { PeopleSyncFamilyDisplay, PeopleSyncPersonDisplay } from './types';

interface PersonIdentitySummaryProps {
  label: string;
  person?: PeopleSyncPersonDisplay;
}

export function personDisplayName(person: Pick<PeopleSyncPersonDisplay, 'firstName' | 'lastName'> | undefined): string {
  return `${person?.firstName || ''} ${person?.lastName || ''}`.trim() || 'Name unavailable';
}

export function personFamilyDisplay(person: PeopleSyncPersonDisplay): PeopleSyncFamilyDisplay {
  return person.family ?? { state: 'unavailable' };
}

export default function PersonIdentitySummary({ label, person }: PersonIdentitySummaryProps) {
  if (!person) {
    return (
      <div className="min-w-0 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-800/60">
        <h5 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</h5>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">No person selected</p>
      </div>
    );
  }

  const family = personFamilyDisplay(person);
  const previewMembers = family.state === 'known' ? family.members.slice(0, 3) : [];
  const hiddenCount = family.state === 'known'
    ? Math.max(0, family.totalOtherMembers - previewMembers.length)
    : 0;

  return (
    <div className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h5 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</h5>
      <p className="mt-1 break-words text-base font-semibold text-gray-950 dark:text-white">{personDisplayName(person)}</p>

      <div className="mt-2 text-sm text-gray-600 dark:text-gray-300">
        {family.state === 'none' && <p>No family</p>}
        {family.state === 'unavailable' && <p>Household information unavailable</p>}
        {family.state === 'known' && (
          <>
            <p className="font-medium text-gray-700 dark:text-gray-200">{family.name || 'Family name unavailable'}</p>
            {previewMembers.length > 0 && (
              <p className="mt-1 break-words">
                <span className="sr-only">Other family members: </span>
                {previewMembers.map(personDisplayName).join(', ')}
              </p>
            )}
            {family.totalOtherMembers === 0 && <p className="mt-1">No other family members</p>}
            {hiddenCount > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer rounded text-sm font-medium text-gray-600 underline decoration-gray-300 underline-offset-2 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-gray-300">
                  {hiddenCount} more family {hiddenCount === 1 ? 'member' : 'members'}
                </summary>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Additional names are not included in this compact preview.
                </p>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
