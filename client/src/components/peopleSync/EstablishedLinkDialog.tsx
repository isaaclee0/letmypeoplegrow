import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import PersonIdentitySummary, {
  personDisplayName,
  personFamilyDisplay,
} from './PersonIdentitySummary';
import type { PeopleSyncPeopleDirectory, PeopleSyncPersonDisplay } from './types';

export interface EstablishedLinkDialogProps {
  open: boolean;
  externalId: string;
  currentIndividualId: number;
  directory: PeopleSyncPeopleDirectory;
  availableIndividualIds: ReadonlySet<number>;
  claimedBy: ReadonlyMap<number, string>;
  onRelink: (individualId: number) => void;
  onUnlink: () => void;
  onClose: () => void;
}

function searchableText(person: PeopleSyncPersonDisplay): string {
  const family = personFamilyDisplay(person);
  const familyText = family.state === 'known'
    ? [family.name, ...family.members.flatMap((member) => [member.firstName, member.lastName])].join(' ')
    : '';
  return `${person.firstName} ${person.lastName} ${familyText}`.normalize('NFKD').toLocaleLowerCase();
}

export default function EstablishedLinkDialog({
  open,
  externalId,
  currentIndividualId,
  directory,
  availableIndividualIds,
  claimedBy,
  onRelink,
  onUnlink,
  onClose,
}: EstablishedLinkDialogProps) {
  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const externalName = personDisplayName(directory.external[externalId]);
  const currentPerson = directory.local[String(currentIndividualId)];

  useEffect(() => {
    if (open) return;
    setChanging(false);
    setQuery('');
  }, [open]);

  useEffect(() => {
    if (changing) searchRef.current?.focus();
  }, [changing]);

  const people = useMemo(() => {
    const needle = query.trim().normalize('NFKD').toLocaleLowerCase();
    return Object.entries(directory.local)
      .map(([rawId, person]) => ({ individualId: Number(rawId), person }))
      .filter(({ individualId }) => Number.isSafeInteger(individualId) && individualId > 0)
      .filter(({ individualId }) => individualId !== currentIndividualId)
      .filter(({ person }) => !needle || searchableText(person).includes(needle))
      .sort((left, right) => personDisplayName(left.person).localeCompare(personDisplayName(right.person)));
  }, [currentIndividualId, directory.local, query]);

  return (
    <Dialog open={open} onClose={() => onClose()} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 overflow-y-auto p-4">
        <div className="flex min-h-full items-start justify-center py-4 sm:items-center">
          <DialogPanel className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
            <div className="flex items-start justify-between gap-4">
              <DialogTitle className="text-lg font-semibold text-gray-950 dark:text-white">
                Correct linked person for {externalName}
              </DialogTitle>
              <button
                type="button"
                onClick={() => onClose()}
                aria-label="Close linked person correction"
                className="rounded-md px-2 py-1 text-2xl leading-none text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <div className="mt-4">
              <PersonIdentitySummary label="Currently linked LMPG person" person={currentPerson} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setChanging(true)}
                className="rounded-lg border border-primary-300 bg-primary-50 px-4 py-3 text-left text-sm font-semibold text-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-primary-700 dark:bg-primary-950/30 dark:text-primary-200"
              >
                Change linked person
              </button>
              <button
                type="button"
                onClick={() => onUnlink()}
                className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-left text-sm font-semibold text-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
              >
                Unlink and review again
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
              Unattended sync will be held for this provider person after unlinking, until an administrator reviews it again.
            </p>

            {changing && (
              <div className="mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
                <label htmlFor="established-link-person-search" className="block text-sm font-medium text-gray-800 dark:text-gray-100">
                  Search LMPG people
                </label>
                <input
                  ref={searchRef}
                  id="established-link-person-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search a name, family, or family member"
                  className="mt-2 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                />
                <div className="mt-3 max-h-[45vh] space-y-2 overflow-y-auto" aria-live="polite">
                  {people.length === 0 && (
                    <p className="py-4 text-sm text-gray-500 dark:text-gray-400">No matching people found.</p>
                  )}
                  {people.map(({ individualId, person }) => {
                    const claimedExternalId = claimedBy.get(individualId);
                    const claimedElsewhere = claimedExternalId !== undefined && claimedExternalId !== externalId;
                    const unavailable = !availableIndividualIds.has(individualId);
                    const disabled = claimedElsewhere || unavailable;
                    return (
                      <div key={individualId} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                        <PersonIdentitySummary label="LMPG person" person={person} />
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`Select ${personDisplayName(person)}`}
                          onClick={() => onRelink(individualId)}
                          className="mt-2 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm font-semibold text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-55 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
                        >
                          Select {personDisplayName(person)}
                        </button>
                        {claimedElsewhere && (
                          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Already selected for another provider person</p>
                        )}
                        {!claimedElsewhere && unavailable && person.matchEligible === false && (
                          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Already linked to a provider person</p>
                        )}
                        {!claimedElsewhere && unavailable && person.matchEligible !== false && (
                          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Not available for matching in this review</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
