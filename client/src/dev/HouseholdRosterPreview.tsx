import React, { useState } from 'react';
import { ArrowPathIcon, CheckIcon, HomeModernIcon } from '@heroicons/react/24/outline';

type Person = { id: number; name: string; pcoId?: string; history?: string[] };
type Membership = { personId: number; role: 'Parent / guardian' | 'Child' | 'Adult' };
type Household = { id: string; name: string; contactId: number; members: Membership[] };

// Fictional people. The same local ID is reused in every household and attendance view.
const people: Person[] = [
  { id: 1, name: 'Jamie Bell', pcoId: 'person-1' },
  { id: 2, name: 'Rowan Bell', pcoId: 'person-2' },
  { id: 3, name: 'Mira Hart', pcoId: 'person-3' },
  { id: 4, name: 'Harper Hart', pcoId: 'person-4' },
  { id: 5, name: 'Tessa Ford', pcoId: 'person-5' },
  { id: 6, name: 'Lee Ford', pcoId: 'person-6' },
  { id: 7, name: 'Ash Ford', pcoId: 'person-7' },
  { id: 8, name: 'Wren Ford', pcoId: 'person-8' },
  { id: 9, name: 'Nico Lane', history: ['22 Nov 2026 · Sunday AM', '15 Nov 2026 · Sunday AM'] },
  { id: 10, name: 'Jules Reed', history: ['8 Nov 2026 · Sunday AM'] },
];
const initialHouseholds: Household[] = [
  { id: 'bell', name: 'Bell Household', contactId: 1,
    members: [{ personId: 1, role: 'Parent / guardian' }, { personId: 2, role: 'Child' }] },
  { id: 'hart', name: 'Hart Household', contactId: 3,
    members: [{ personId: 3, role: 'Parent / guardian' }, { personId: 1, role: 'Parent / guardian' }, { personId: 4, role: 'Child' }] },
  { id: 'ford-couple', name: 'Ford Household', contactId: 5,
    members: [{ personId: 5, role: 'Adult' }, { personId: 6, role: 'Adult' }] },
  { id: 'ford-extended', name: 'Ford Household', contactId: 7,
    members: [{ personId: 7, role: 'Parent / guardian' }, { personId: 5, role: 'Parent / guardian' }, { personId: 6, role: 'Parent / guardian' }, { personId: 8, role: 'Child' }] },
];
const byId = new Map(people.map(person => [person.id, person]));
const linked = people.filter(person => person.pcoId);
const unlinked = people.filter(person => !person.pcoId);
const card = 'rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800';
const secondary = 'text-sm text-gray-600 dark:text-gray-300';
const button = 'rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-100 focus-visible:outline-primary-600 dark:border-gray-600 dark:hover:bg-gray-700';

export default function HouseholdRosterPreview() {
  const [view, setView] = useState<'roll' | 'unlinked'>('roll');
  const [grouped, setGrouped] = useState(true);
  const [synced, setSynced] = useState(false);
  const [present, setPresent] = useState<Set<number>>(new Set());
  const households = initialHouseholds.map(h => h.id === 'hart' && synced
    ? { ...h, members: [...h.members, { personId: 2, role: 'Child' as const }] }
    : h);

  function toggle(id: number) {
    setPresent(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function attendanceRow(person: Person, detail: string) {
    return (
      <li key={person.id}>
        <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/40">
          <input type="checkbox" checked={present.has(person.id)} onChange={() => toggle(person.id)}
            className="h-5 w-5 shrink-0 rounded border-gray-300 text-primary-700 focus:ring-primary-600"
            aria-label={person.name + ' present'} />
          <span className="min-w-0">
            <span className="block font-medium">{person.name}</span>
            <span className={secondary}>{detail}</span>
          </span>
        </label>
      </li>
    );
  }

  function householdLabel(household: Household) {
    const sharesName = households.some(other => other.id !== household.id && other.name === household.name);
    return sharesName ? household.name + ' (' + byId.get(household.contactId)?.name + ')' : household.name;
  }

  function householdsFor(personId: number) {
    return households.filter(household => household.members.some(member => member.personId === personId));
  }

  return <div className="mx-auto max-w-5xl space-y-5 p-4 text-gray-900 sm:p-6 dark:text-gray-100">
    <header>
      <h1 className="text-2xl font-bold">Planning Center household preview</h1>
      <p className={'mt-1 ' + secondary}>Try checking in sample people. Changes last while this page is open.</p>
    </header>
    <nav aria-label="Preview views" className="flex flex-wrap gap-4 border-b border-gray-200 dark:border-gray-700">
      {(['roll', 'unlinked'] as const).map(key => <button type="button" key={key} aria-pressed={view === key}
        onClick={() => setView(key)}
        className={'border-b-2 px-1 pb-2 text-sm font-semibold ' + (view === key
          ? 'border-primary-600 text-primary-700 dark:text-primary-300' : 'border-transparent text-gray-600 dark:text-gray-300')}>
        {key === 'roll' ? 'Attendance roll' : 'Unlinked people (' + unlinked.length + ')'}
      </button>)}
    </nav>

    {view === 'roll' ? <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-xl font-semibold">Sunday AM</h2>
          <p role="status" className={secondary}>{present.size} of {linked.length} present</p></div>
        <div className="inline-flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800" aria-label="Group attendance">
          {[true, false].map(byHousehold => <button type="button" key={String(byHousehold)} onClick={() => setGrouped(byHousehold)}
            aria-pressed={grouped === byHousehold}
            className={'rounded-md px-3 py-1.5 text-sm ' + (grouped === byHousehold ? 'bg-white font-semibold shadow-sm dark:bg-gray-700' : 'text-gray-600 dark:text-gray-300')}>
            {byHousehold ? 'By household' : 'By person'}
          </button>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary-200 bg-primary-50 p-3 dark:border-primary-800 dark:bg-primary-950">
        <p className="text-sm" aria-live="polite">{synced
          ? 'Synced. Rowan Bell now appears in both Bell and Hart.'
          : 'The sample PCO update adds Rowan Bell to Hart and keeps the Bell membership.'}</p>
        <button type="button" className={button + ' inline-flex shrink-0 items-center gap-2'} disabled={synced} onClick={() => setSynced(true)}>
          {synced ? <CheckIcon aria-hidden="true" className="h-4 w-4" /> : <ArrowPathIcon aria-hidden="true" className="h-4 w-4" />}
          {synced ? 'Update applied' : 'Simulate PCO update'}
        </button>
      </div>
      {grouped ? <div className="grid items-start gap-4 md:grid-cols-2">
        {households.map(h => <section key={h.id} aria-labelledby={'preview-' + h.id} className={card + ' overflow-hidden'}>
          <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <HomeModernIcon className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-300" aria-hidden="true" />
            <div><h3 id={'preview-' + h.id} className="font-semibold">{h.name}</h3>
              <p className={secondary}>Primary contact · {byId.get(h.contactId)?.name}</p></div>
          </header>
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {h.members.map(member => {
              const others = householdsFor(member.personId).filter(other => other.id !== h.id);
              const detail = others.length ? member.role + ' · Also in ' + others.map(householdLabel).join(', ') : member.role;
              return attendanceRow(byId.get(member.personId)!, detail);
            })}
          </ul>
        </section>)}
      </div> : <ul className={card + ' divide-y divide-gray-100 dark:divide-gray-700'}>
        {linked.map(person => attendanceRow(person, householdsFor(person.id).map(householdLabel).join(' · ')))}
      </ul>}
    </> : <section aria-labelledby="unlinked-heading" className="space-y-3">
      <h2 id="unlinked-heading" className="text-xl font-semibold">Unlinked people</h2>
      <p className={secondary}>These local profiles are active. They stay off the Planning Center roll until linked, and their attendance history is available here.</p>
      <ul className={card + ' divide-y divide-gray-200 dark:divide-gray-700'}>
        {unlinked.map(person => <li key={person.id} className="p-4">
          <h3 className="font-semibold">{person.name}</h3>
          <details className={'mt-1 ' + secondary}><summary className="cursor-pointer">Attendance history</summary>
            <ul className="mt-2 space-y-1 pl-4">{person.history?.map(visit => <li key={visit}>{visit}</li>)}</ul>
          </details>
        </li>)}
      </ul>
    </section>}
  </div>;
}
