import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import PersonIdentitySummary, {
  personDisplayName,
  personFamilyDisplay,
} from './PersonIdentitySummary';
import type { PeopleSyncPeopleDirectory, PeopleSyncPersonDisplay } from './types';

export interface PeoplePickerDialogProps {
  open: boolean;
  externalId: string;
  directory: PeopleSyncPeopleDirectory;
  availableIndividualIds: ReadonlySet<number>;
  claimedBy: ReadonlyMap<number, string>;
  allowCreate: boolean;
  selectedIndividualId: number | null;
  excludedIndividualIds: readonly number[];
  onSelectPerson: (individualId: number) => void;
  onSelectCreate: () => void;
  onClose: () => void;
}

function searchableText(person: PeopleSyncPersonDisplay): string {
  const family = personFamilyDisplay(person);
  const familyText = family.state === 'known'
    ? [family.name, ...family.members.flatMap((member) => [member.firstName, member.lastName])].join(' ')
    : '';
  return `${person.firstName} ${person.lastName} ${familyText}`.normalize('NFKD').toLocaleLowerCase();
}

export default function PeoplePickerDialog({
  open,
  externalId,
  directory,
  availableIndividualIds,
  claimedBy,
  allowCreate,
  selectedIndividualId,
  excludedIndividualIds,
  onSelectPerson,
  onSelectCreate,
  onClose,
}: PeoplePickerDialogProps) {
  const [query, setQuery] = useState('');
  const [pendingExcludedId, setPendingExcludedId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const externalName = personDisplayName(directory.external[externalId]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPendingExcludedId(null);
    searchRef.current?.focus();
  }, [externalId, open]);

  const people = useMemo(() => {
    const needle = query.trim().normalize('NFKD').toLocaleLowerCase();
    return Object.entries(directory.local)
      .map(([rawId, person]) => ({ individualId: Number(rawId), person }))
      .filter(({ individualId }) => Number.isSafeInteger(individualId) && individualId > 0)
      .filter(({ individualId }) => individualId !== selectedIndividualId)
      .filter(({ person }) => !needle || searchableText(person).includes(needle))
      .sort((left, right) => personDisplayName(left.person).localeCompare(personDisplayName(right.person)));
  }, [directory.local, query, selectedIndividualId]);

  const choosePerson = (individualId: number) => {
    if (excludedIndividualIds.includes(individualId)) {
      setPendingExcludedId(individualId);
      return;
    }
    onSelectPerson(individualId);
  };

  const pendingPerson = pendingExcludedId === null
    ? undefined
    : directory.local[String(pendingExcludedId)];

  return (
    <Dialog open={open} onClose={() => onClose()} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 overflow-y-auto p-4">
        <div className="flex min-h-full items-start justify-center py-4 sm:items-center">
          <DialogPanel className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
            <div className="flex items-start justify-between gap-4">
              <DialogTitle className="text-lg font-semibold text-gray-950 dark:text-white">
                Choose an LMPG person for {externalName}
              </DialogTitle>
              <button
                type="button"
                onClick={() => onClose()}
                aria-label="Close person picker"
                className="rounded-md px-2 py-1 text-2xl leading-none text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <label htmlFor="people-sync-person-search" className="mt-4 block text-sm font-medium text-gray-800 dark:text-gray-100">
              Search LMPG people
            </label>
            <input
              ref={searchRef}
              autoFocus
              id="people-sync-person-search"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPendingExcludedId(null);
              }}
              placeholder="Search a name, family, or family member"
              className="mt-2 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />

            {allowCreate && (
              <button
                type="button"
                onClick={() => onSelectCreate()}
                className="mt-4 w-full rounded-lg border border-primary-300 bg-primary-50 px-4 py-3 text-left text-sm font-semibold text-primary-800 hover:bg-primary-100 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-primary-700 dark:bg-primary-950/30 dark:text-primary-200"
              >
                Add new person
              </button>
            )}

            <div className="mt-4 max-h-[55vh] space-y-2 overflow-y-auto" aria-live="polite">
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
                      onClick={() => choosePerson(individualId)}
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

            {pendingExcludedId !== null && pendingPerson && (
              <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
                <p className="font-semibold">This exact pairing was previously rejected.</p>
                <p className="mt-1">Confirm that you want to restore the match to {personDisplayName(pendingPerson)}.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectPerson(pendingExcludedId)}
                    className="rounded-md bg-primary-600 px-3 py-2 font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    Confirm match to {personDisplayName(pendingPerson)}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingExcludedId(null)}
                    className="rounded-md border border-gray-300 bg-white px-3 py-2 font-semibold text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
