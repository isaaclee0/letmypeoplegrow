import React, { useEffect, useMemo, useRef, useState } from 'react';
import PersonIdentitySummary, { personDisplayName } from './PersonIdentitySummary';
import type {
  IdentityDecision,
  IdentityReviewEntry,
  PeopleSyncPeopleDirectory,
  PeopleSyncPersonDisplay,
  SyncProvider,
} from './types';

interface MatchDecisionCardProps {
  provider: SyncProvider;
  externalId: string;
  entry: IdentityReviewEntry;
  directory: PeopleSyncPeopleDirectory;
  decision: IdentityDecision | null;
  claimedIndividualIds: Set<number>;
  onChange: (decision: IdentityDecision | null) => void;
}

const providerLabel = (provider: SyncProvider) => provider === 'planning_center' ? 'Planning Center' : 'Elvanto';

function searchableText(person: PeopleSyncPersonDisplay): string {
  const familyText = person.family.state === 'known'
    ? [person.family.name, ...person.family.members.flatMap((member) => [member.firstName, member.lastName])].join(' ')
    : '';
  return `${person.firstName} ${person.lastName} ${familyText}`.toLocaleLowerCase();
}

function individualIdForDecision(entry: IdentityReviewEntry, decision: IdentityDecision | null): number | null {
  if (decision?.outcome === 'accept') return entry.suggestedIndividualId;
  if (decision?.outcome === 'link') return decision.individualId;
  return null;
}

function RadioChoice({ name, label, checked, disabled = false, onChange }: {
  name: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
      checked
        ? 'border-primary-500 bg-primary-50 text-gray-950 dark:border-primary-400 dark:bg-primary-950/30 dark:text-white'
        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-gray-600'
    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700"
      />
      <span className="font-medium">{label}</span>
    </label>
  );
}

export default function MatchDecisionCard({
  provider,
  externalId,
  entry,
  directory,
  decision,
  claimedIndividualIds,
  onChange,
}: MatchDecisionCardProps) {
  const [searchOpen, setSearchOpen] = useState(decision?.outcome === 'link');
  const [query, setQuery] = useState('');
  const [pendingExcludedId, setPendingExcludedId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const suggestedId = entry.suggestedIndividualId;
  const selectedId = individualIdForDecision(entry, decision);
  const comparisonId = pendingExcludedId ?? selectedId ?? suggestedId ?? entry.candidateIndividualIds[0] ?? null;
  const externalPerson = directory.external[externalId];
  const localPerson = comparisonId === null ? undefined : directory.local[String(comparisonId)];
  const suggestionRejected = suggestedId !== null && decision !== null && selectedId !== suggestedId;

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return Object.entries(directory.local)
      .map(([id, person]) => ({ id: Number(id), person }))
      .filter(({ id }) => Number.isSafeInteger(id))
      .filter(({ person }) => !needle || searchableText(person).includes(needle))
      .sort((left, right) => personDisplayName(left.person).localeCompare(personDisplayName(right.person)))
      .slice(0, 12);
  }, [directory.local, query]);

  const updateWithExclusion = (next: IdentityDecision, checked: boolean) => {
    if (suggestedId === null) return onChange(next);
    onChange(checked ? { ...next, excludeIndividualId: suggestedId } : next);
  };

  const chooseResult = (id: number) => {
    if (entry.excludedIndividualIds.includes(id)) {
      setPendingExcludedId(id);
      onChange(null);
      return;
    }
    setPendingExcludedId(null);
    onChange({ outcome: 'link', individualId: id });
  };

  const chooseOutcome = (next: IdentityDecision) => {
    setSearchOpen(false);
    setPendingExcludedId(null);
    onChange(next);
  };

  const name = `identity-${externalId}`;
  return (
    <article className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50/70 shadow-sm dark:border-gray-700 dark:bg-gray-900/40">
      <div className="p-4 sm:p-5">
        <div data-testid={`identity-comparison-${externalId}`} className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <PersonIdentitySummary label={`${providerLabel(provider)} person`} person={externalPerson} />
          <PersonIdentitySummary label="Let My People Grow person" person={localPerson} />
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-semibold text-gray-900 dark:text-white">What should happen?</legend>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {suggestedId !== null && (
              <RadioChoice
                name={name}
                label="Accept suggested match"
                checked={decision?.outcome === 'accept'}
                onChange={() => chooseOutcome({ outcome: 'accept' })}
              />
            )}
            <RadioChoice
              name={name}
              label="Choose someone else"
              checked={searchOpen}
              onChange={() => {
                setSearchOpen(true);
                setPendingExcludedId(null);
                if (decision?.outcome !== 'link') onChange(null);
              }}
            />
            {entry.canCreate && (
              <RadioChoice
                name={name}
                label="Add as a new person"
                checked={decision?.outcome === 'create'}
                onChange={() => chooseOutcome({ outcome: 'create' })}
              />
            )}
            <RadioChoice
              name={name}
              label="Skip for now"
              checked={decision?.outcome === 'defer'}
              onChange={() => chooseOutcome({ outcome: 'defer' })}
            />
          </div>
        </fieldset>

        {searchOpen && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
            <label htmlFor={`local-person-search-${externalId}`} className="block text-sm font-medium text-gray-800 dark:text-gray-100">
              Search Let My People Grow people
            </label>
            <input
              ref={searchRef}
              id={`local-person-search-${externalId}`}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search a name, family, or family member"
              className="mt-2 block w-full rounded-md border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <div className="mt-3 max-h-80 space-y-2 overflow-y-auto" aria-live="polite">
              {results.length === 0 && <p className="py-3 text-sm text-gray-500 dark:text-gray-400">No matching people found.</p>}
              {results.map(({ id, person }) => {
                const claimed = claimedIndividualIds.has(id);
                const durableLinked = person.matchEligible === false;
                const disabled = claimed || durableLinked;
                return (
                  <div key={id} className={`rounded-lg border p-3 ${disabled ? 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50' : 'border-gray-200 bg-white dark:border-gray-600 dark:bg-gray-800'}`}>
                    <PersonIdentitySummary label="Let My People Grow person" person={person} />
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => chooseResult(id)}
                      className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
                      aria-label={`Select ${personDisplayName(person)}`}
                    >
                      Select {personDisplayName(person)}
                    </button>
                    {claimed && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Already selected for {personDisplayName(person)} in this review.</p>}
                    {!claimed && durableLinked && <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Already linked to this provider.</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {pendingExcludedId !== null && (
          <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
            <p>This pairing was previously rejected. Confirm that you want to restore it.</p>
            <label className="mt-2 flex items-start gap-2 font-medium">
              <input
                type="checkbox"
                className="mt-0.5 rounded border-amber-400 text-primary-600 focus:ring-primary-500"
                onChange={(event) => onChange(event.target.checked ? { outcome: 'link', individualId: pendingExcludedId } : null)}
              />
              Confirm this previously rejected pairing
            </label>
          </div>
        )}

        {suggestionRejected && decision && (
          <label className="mt-4 flex items-start gap-2 rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              aria-label="Don't suggest this pairing again"
              checked={decision.excludeIndividualId === suggestedId}
              onChange={(event) => updateWithExclusion(decision, event.target.checked)}
              className="mt-0.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700"
            />
            <span>
              <span className="block font-medium">Don&apos;t suggest this pairing again</span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">Only this exact provider and local person pairing will be remembered.</span>
            </span>
          </label>
        )}
      </div>
    </article>
  );
}
