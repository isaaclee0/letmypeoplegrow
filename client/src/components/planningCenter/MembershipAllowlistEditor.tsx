import React from 'react';

export interface MembershipSummaryValue { membership: string; count: number; }

interface Props {
  values: MembershipSummaryValue[];      // from membership-summary
  loading: boolean;
  error: string | null;
  selected: string[];                    // current allowlist
  onChange: (next: string[]) => void;    // selection changed
  onReload: () => void;                   // re-fetch summary
}

export default function MembershipAllowlistEditor({ values, loading, error, selected, onChange, onReload }: Props) {
  const selectedSet = new Set(selected);

  const toggle = (membership: string) => {
    const next = new Set(selectedSet);
    if (next.has(membership)) next.delete(membership); else next.add(membership);
    onChange([...next]);
  };

  if (loading) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading membership categories…</p>;
  }
  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        {error} <button type="button" onClick={onReload} className="underline ml-1">Retry</button>
      </div>
    );
  }
  if (!values.length) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No membership categories found in Planning Center.</p>;
  }

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
        Only checked categories add new people. Archiving/updates apply to everyone already linked.
      </p>
      <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
        {values.map((v) => (
          <li key={v.membership} className="flex items-center justify-between px-3 py-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedSet.has(v.membership)}
                onChange={() => toggle(v.membership)}
                className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <span className="text-sm text-gray-900 dark:text-gray-100">{v.membership}</span>
            </label>
            <span className="text-xs text-gray-500 dark:text-gray-400">{v.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
