import React, { useState } from 'react';

export default function OutsideSourceReviewSection({ count, selectedCount, shownCount, search, onSearchChange, children }: {
  count: number;
  selectedCount: number;
  shownCount: number;
  search: string;
  onSearchChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count <= 5) return <>{children}</>;
  return <details className="mt-4 rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer select-none px-5 py-4 text-sm font-medium text-gray-900 dark:text-gray-100">
      <span>People outside synced lists ({count})</span>
      <span className="ml-3 text-xs font-normal text-gray-500 dark:text-gray-400">{selectedCount} selected</span>
    </summary>
    {open && <div className="space-y-3 border-t border-gray-200 p-4 dark:border-gray-700">
      <p className="text-sm text-gray-600 dark:text-gray-300">Archiving these people is optional. Unselected people stay active in LMPG.</p>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
        Search by name
        <input type="search" aria-label="Search people outside synced lists" value={search}
          onChange={(event) => onSearchChange(event.target.value)} placeholder="LMPG or Planning Center name"
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
      </label>
      <p className="text-xs text-gray-500 dark:text-gray-400">{shownCount} of {count} shown</p>
      {shownCount > 0 ? children : <p className="text-sm text-gray-600 dark:text-gray-300">No people match this name.</p>}
    </div>}
  </details>;
}
