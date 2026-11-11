import React, { useState } from 'react';
import OutsideSourceReviewSection from './OutsideSourceReviewSection';
import type { ArchiveAction, PeopleSyncPeopleDirectory } from './types';

const personName = (person: { firstName?: string; lastName?: string } | undefined) =>
  `${person?.firstName || ''} ${person?.lastName || ''}`.trim() || 'Name unavailable';

export default function OutsideSourceArchiveDecisions({ actions, people, acceptedIds, onChange }: {
  actions: ArchiveAction[];
  people: PeopleSyncPeopleDirectory;
  acceptedIds: Set<number>;
  onChange: (individualId: number, accepted: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  if (!actions.length) return null;
  const query = search.trim().toLocaleLowerCase();
  const shown = actions.length <= 5 ? actions : actions.filter((action) => {
    const local = people.local[String(action.individualId)];
    const external = people.external[action.externalPersonId] || { firstName: action.externalFirstName, lastName: action.externalLastName };
    return `${personName(local)} ${personName(external)}`.toLocaleLowerCase().includes(query);
  });
  return <OutsideSourceReviewSection count={actions.length} selectedCount={actions.filter((action) => acceptedIds.has(action.individualId)).length}
    shownCount={shown.length} search={search} onSearchChange={setSearch}>
    <section aria-label="People outside enabled Planning Center lists" className="overflow-hidden rounded-xl border border-amber-200 bg-white dark:border-amber-800 dark:bg-gray-800">
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30">
      <h4 className="font-semibold">People outside enabled Planning Center lists</h4>
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">These people are active in Planning Center but outside every enabled sync list. Choose whether to archive their existing LMPG records.</p>
    </div>
    <ul className="divide-y divide-gray-200 dark:divide-gray-700">
      {shown.map((action) => {
        const local = people.local[String(action.individualId)];
        const external = people.external[action.externalPersonId] || { firstName: action.externalFirstName, lastName: action.externalLastName };
        const localName = personName(local);
        const externalName = personName(external);
        const selected = acceptedIds.has(action.individualId);
        const label = action.linkRequired ? 'Link and archive' : 'Archive in LMPG';
        return <li key={action.id} className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="font-semibold">{localName}</h5>
            <span className="text-xs text-gray-500 dark:text-gray-400">{selected ? label : 'Keep active for now'}</span>
          </div>
          <div className="grid gap-3 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900/50 md:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Planning Center</p>
              <p className="mt-1 font-medium">{externalName}</p>
              <p>Active · outside every enabled sync list</p>
              <p className="mt-1 text-gray-600 dark:text-gray-300">{action.pcoHouseholdNames?.join(', ') || 'No Planning Center household'}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">LMPG now</p>
              <p className="mt-1 font-medium">{localName}</p>
              <p>Active · {action.linkRequired ? 'Not linked to Planning Center' : 'Linked to Planning Center'}</p>
              <p className="mt-1 text-gray-600 dark:text-gray-300">{local?.family?.state === 'known' ? local.family.name : local?.family?.state === 'none' ? 'No family' : 'Family details unavailable'}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">After applying</p>
              <p className="mt-1 font-medium">{selected ? 'Archived in LMPG' : 'Active and unchanged in LMPG'}</p>
              {selected && <p>{action.linkRequired ? `Linked to ${externalName}` : 'Existing Planning Center link kept'}</p>}
              <p className="mt-1 text-gray-600 dark:text-gray-300">Attendance history is kept. Planning Center stays unchanged.</p>
            </div>
          </div>
          {action.sourceNames?.length ? <p className="text-xs text-gray-500 dark:text-gray-400">Checked lists: {action.sourceNames.join(', ')}</p> : null}
          <label className="flex cursor-pointer items-start gap-3 text-sm font-semibold">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={selected}
              onChange={(event) => onChange(action.individualId, event.target.checked)} />
            <span>{label} {localName}</span>
          </label>
          {action.linkRequired && <p className="text-xs text-gray-600 dark:text-gray-300">Confirm that the Planning Center person and the existing LMPG person are the same person. Linking and archiving happen together when you apply.</p>}
        </li>;
      })}
    </ul>
  </section></OutsideSourceReviewSection>;
}
