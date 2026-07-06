import React, { useEffect, useState } from 'react';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';

export interface PcoPersonResult {
  pcoId: string;
  firstName: string;
  lastName: string;
  householdId: string | null;
  status: string | null;
}

// Debounced "search Planning Center by name, click to pick" widget shared by the
// ambiguous-match and unmatched-extra review flows.
export default function PcoPersonSearchPicker({ onPick }: { onPick: (person: PcoPersonResult) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PcoPersonResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await integrationsAPI.searchPlanningCenterPeople(query);
        setResults(res.data.results);
      } catch (e) {
        logger.error('PCO people search failed', e);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="mt-1">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search Planning Center by name…"
        className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 w-full dark:bg-gray-800"
      />
      {searching && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Searching…</p>}
      {results.length > 0 && (
        <ul className="mt-1 border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-700">
          {results.map((r) => (
            <li key={r.pcoId}>
              <button
                type="button"
                onClick={() => onPick(r)}
                className="w-full text-left text-sm px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {r.firstName} {r.lastName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
