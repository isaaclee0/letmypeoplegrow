// Development entry only. Not imported by index.tsx or the production build.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SyncReview from '../components/peopleSync/SyncReview';
import type { PeopleSyncOperationReview, PeopleSyncSelections } from '../components/peopleSync/types';
import '../index.css';

interface Fixture {
  review: PeopleSyncOperationReview;
  evidence: {
    status: string;
    attendance: Record<string, { rows: number; unchanged: boolean }>;
  };
}

function Rehearsal() {
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [captured, setCaptured] = useState<PeopleSyncSelections | null>(null);
  useEffect(() => {
    fetch('/__rehearsal/review', { cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error('Start the local rehearsal script to load the fixture.'); return response.json(); })
      .then(setFixture)
      .catch((reason: Error) => setError(reason.message));
  }, []);
  return <main className="min-h-screen bg-stone-100 px-4 py-5 text-gray-900 dark:bg-gray-950 dark:text-gray-100 sm:px-8">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="rounded-2xl bg-slate-900 px-5 py-4 text-white">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-300">Local rehearsal · Offline fixture</p>
        <h1 className="mt-1 text-xl font-semibold">Review people, households and attendance lists</h1>
        <p className="mt-2 text-sm text-slate-200"><strong>Apply only captures your choices.</strong> The people, households and attendance history in this review are fictional.</p>
      </header>
      {error && <div role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{error}</div>}
      {!fixture && !error && <p>Preparing local review…</p>}
      {fixture && <>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 px-5 py-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
          <p><strong>Household/list rehearsal passed.</strong> {fixture.evidence.attendance.attendance_records.rows.toLocaleString()} attendance records unchanged. Two people joined a shared household, one left a household, and one left the morning list.</p>
          <button type="button" className="rounded-lg border border-green-300 bg-white px-3 py-2 font-semibold dark:border-green-700 dark:bg-green-900" onClick={() => { setGeneration((value) => value + 1); setCaptured(null); }}>Reset choices</button>
        </div>
        <div key={generation} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:p-6">
          <SyncReview operationKind="people_sync" provider="planning_center" batchName="Morning roster" sourceName="Fictional morning list"
            review={fixture.review} applying={false} onRefresh={() => { setGeneration((value) => value + 1); setCaptured(null); }}
            onApply={(_reviewToken, selections) => { setCaptured(selections); }} />
        </div>
        {captured && <section aria-label="Simulated apply result" className="rounded-xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-800 dark:bg-blue-950">
          <h2 className="font-semibold text-blue-950 dark:text-blue-100">Simulation captured — no database was changed</h2>
          <p className="mt-1 text-sm text-blue-900 dark:text-blue-200">These are the selections the actual review component would submit with its signed token.</p>
          <pre className="mt-3 overflow-auto rounded-lg bg-white p-4 text-xs dark:bg-gray-900">{JSON.stringify(captured, null, 2)}</pre>
        </section>}
      </>}
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Rehearsal />);
