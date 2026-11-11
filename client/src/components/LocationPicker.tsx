import { useEffect, useId, useRef, useState } from 'react';
import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions } from '@headlessui/react';
import { authAPI, type ChurchLocationResult } from '../services/api';

interface LocationPickerProps {
  value: ChurchLocationResult | null | undefined;
  onChange: (location: ChurchLocationResult | null | undefined) => void;
  disabled?: boolean;
}

type SearchState = {
  query: string;
  attempt: number;
  results: ChurchLocationResult[];
  failed: boolean;
};

export default function LocationPicker({ value, onChange, disabled }: LocationPickerProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const focusAfterChange = useRef(false);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState<SearchState>();
  const term = query.trim();
  const canSearch = value === undefined && term.length >= 3 && !disabled;
  const current = search?.query === term && search.attempt === attempt ? search : undefined;

  useEffect(() => {
    if (!focusAfterChange.current) return;
    focusAfterChange.current = false;
    (value === undefined ? input.current : changeButton.current)?.focus();
  }, [value]);

  useEffect(() => {
    if (!canSearch) return;

    let active = true;
    const timer = setTimeout(async () => {
      try {
        const { data } = await authAPI.searchLocations(term);
        if (active) setSearch({ query: term, attempt, results: data.results, failed: false });
      } catch {
        if (active) setSearch({ query: term, attempt, results: [], failed: true });
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [term, attempt, canSearch]);

  const resetSearch = (location: ChurchLocationResult | null | undefined) => {
    focusAfterChange.current = true;
    setQuery('');
    setSearch(undefined);
    onChange(location);
  };

  const linkClass = 'text-sm font-medium text-primary-600 hover:text-primary-500 dark:text-primary-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-50';

  return (
    <div className="space-y-1.5">
      <label htmlFor={value === undefined ? id : undefined} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        Where is your church?
      </label>
      <p id={`${id}-help`} className="text-sm text-gray-600 dark:text-gray-400">
        We use your location for local gathering times, weather and holidays.
      </p>

      {value === undefined ? (
        <>
          <Combobox<ChurchLocationResult | null>
            value={null}
            onChange={(location) => { if (location) resetSearch(location); }}
            disabled={disabled}
            immediate
          >
            <ComboboxInput
              id={id}
              ref={input}
              value={query}
              aria-describedby={`${id}-help`}
              placeholder="Search for a city or town"
              autoComplete="off"
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 sm:text-sm"
            />
            {!!current?.results.length && (
              <ComboboxOptions
                anchor="bottom start"
                modal={false}
                className="z-20 mt-1 max-h-56 w-(--input-width) overflow-y-auto rounded-md border border-gray-200 bg-white p-1 shadow-lg empty:invisible dark:border-gray-600 dark:bg-gray-800"
              >
                {current.results.map((location) => (
                  <ComboboxOption
                    key={`${location.displayName}-${location.lat}-${location.lng}`}
                    value={location}
                    className="cursor-pointer rounded px-3 py-2 text-sm text-gray-800 data-focus:bg-primary-100 dark:text-gray-100 dark:data-focus:bg-primary-900"
                  >
                    {location.displayName}
                  </ComboboxOption>
                ))}
              </ComboboxOptions>
            )}
          </Combobox>
          <div role="status" className="text-sm text-gray-600 dark:text-gray-400">
            {canSearch && (current?.failed
              ? 'Location search is temporarily unavailable.'
              : !current
                ? 'Searching for places…'
                : current.results.length === 0
                  ? 'No places found. Try another city or town.'
                  : null)}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {current?.failed && (
              <button type="button" disabled={disabled} className={linkClass} onClick={() => {
                input.current?.focus();
                setAttempt(attempt + 1);
              }}>
                Retry search
              </button>
            )}
            <button type="button" disabled={disabled} className={linkClass} onClick={() => resetSearch(null)}>
              Set this later
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-600">
          <span role="status" className="text-gray-700 dark:text-gray-300">
            {value?.displayName ?? 'Location can be set later in Settings.'}
          </span>
          <button ref={changeButton} type="button" disabled={disabled} className={linkClass} onClick={() => resetSearch(undefined)}>
            {value ? 'Change location' : 'Add a location'}
          </button>
        </div>
      )}
    </div>
  );
}
