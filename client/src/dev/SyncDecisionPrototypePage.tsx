// Development only: App.tsx registers /app/dev/sync-review behind
// import.meta.env.DEV, so neither this page nor its fixture reaches a
// production build. Apply here only captures the selections payload;
// "Simulate next sync" mimics what the server would offer afterwards.
import React, { useState } from 'react';
import SyncDecisionList from '../components/peopleSync/SyncDecisionList';
import SyncReview from '../components/peopleSync/SyncReview';
import fixture from './fixtures/reconciliation.synthetic.json';
import { tagLegacyPeopleReview } from '../components/peopleSync/types';
import type {
  FamilyConflictAction,
  KeptReconciliation,
  PeopleSyncOperationReview,
  PeopleSyncReview,
  PeopleSyncSelections,
  RemoveFromGatheringAction,
} from '../components/peopleSync/types';

const initialReview = tagLegacyPeopleReview(fixture.review as PeopleSyncReview, 'people_sync');

type View = 'list' | 'current';

// What the next review would look like once these selections were applied:
// decided people and accepted differences are gone, kept ones move to
// "Kept as is", and newly deferred people come back held.
function simulateNextReview(review: PeopleSyncOperationReview, selections: PeopleSyncSelections): PeopleSyncOperationReview {
  const plan = review.plan;
  const decisions = selections.identityDecisions || {};
  const resolved = new Set(Object.entries(decisions).filter(([, decision]) => decision.outcome !== 'defer').map(([id]) => id));
  const accepted = new Set([...(selections.acceptFamilyResolutionIds || []), ...(selections.acceptGatheringRemovalIds || [])]);
  const keptIds = new Set(selections.keepReconciliationIds || []);
  const kept: KeptReconciliation[] = [...(plan.keptReconciliations || [])];
  let nextKeepId = Math.max(0, ...kept.map((entry) => entry.keepId)) + 1;
  const stillOffered = <T extends { id?: string }>(bucket: KeptReconciliation['bucket']) => (action: T) => {
    if (action.id && accepted.has(action.id)) return false;
    if (action.id && keptIds.has(action.id)) {
      kept.push({
        keepId: nextKeepId++, kind: bucket === 'familyConflicts' ? 'household' : 'gathering_removal',
        subjectKey: action.id, keptAt: new Date().toISOString(), bucket,
        action: action as unknown as FamilyConflictAction | RemoveFromGatheringAction,
      });
      return false;
    }
    return true;
  };
  const identities = Object.fromEntries(Object.entries(plan.reviewContext?.identities || {})
    .filter(([id]) => !resolved.has(id))
    .map(([id, entry]) => [id, decisions[id]?.outcome === 'defer' ? { ...entry, held: true } : entry]));
  return {
    ...review,
    plan: {
      ...plan,
      reviewContext: plan.reviewContext && { ...plan.reviewContext, identities },
      ambiguousPeople: plan.ambiguousPeople.filter((action) => !resolved.has(action.externalPersonId)),
      familyConflicts: plan.familyConflicts.filter(stillOffered<FamilyConflictAction>('familyConflicts')),
      removeFromGathering: plan.removeFromGathering.filter(stillOffered<RemoveFromGatheringAction>('removeFromGathering')),
      keptReconciliations: kept,
    },
  };
}

// "Ask again": the server forgets the keep and the difference is offered again.
function simulateAskAgain(review: PeopleSyncOperationReview, entry: KeptReconciliation): PeopleSyncOperationReview {
  const plan = review.plan;
  return {
    ...review,
    plan: {
      ...plan,
      keptReconciliations: (plan.keptReconciliations || []).filter((item) => item.keepId !== entry.keepId),
      familyConflicts: entry.bucket === 'familyConflicts' ? [...plan.familyConflicts, entry.action as FamilyConflictAction] : plan.familyConflicts,
      removeFromGathering: entry.bucket === 'removeFromGathering'
        ? [...plan.removeFromGathering, entry.action as RemoveFromGatheringAction] : plan.removeFromGathering,
    },
  };
}

export default function SyncDecisionPrototypePage() {
  const [view, setView] = useState<View>('list');
  const [generation, setGeneration] = useState(0);
  const [review, setReview] = useState(initialReview);
  const [syncCount, setSyncCount] = useState(1);
  const [captured, setCaptured] = useState<{ view: View; selections: PeopleSyncSelections } | null>(null);
  const rerender = () => setGeneration((value) => value + 1);
  const reset = () => { setReview(initialReview); setSyncCount(1); setCaptured(null); rerender(); };
  const capture = (selections: PeopleSyncSelections) => setCaptured({ view, selections });

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-900 px-5 py-3 text-sm text-slate-200">
        <p>
          <span className="font-semibold uppercase tracking-wider text-amber-300">Dev prototype</span>{' · '}
          Sample congregation, sync {syncCount}. Apply only captures choices.
        </p>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Review layout" className="inline-flex rounded-lg bg-slate-800 p-0.5">
            {(['list', 'current'] as View[]).map((option) => (
              <button key={option} type="button" role="tab" aria-selected={view === option}
                onClick={() => { setView(option); setCaptured(null); rerender(); }}
                className={`rounded-md px-3 py-1.5 font-medium ${view === option ? 'bg-white text-slate-900' : 'text-slate-300 hover:text-white'}`}>
                {option === 'list' ? 'New list' : 'Current review'}
              </button>
            ))}
          </div>
          <button type="button" onClick={reset} className="rounded-md px-2 py-1.5 text-slate-300 hover:text-white">Reset</button>
        </div>
      </div>

      <div key={`${view}-${generation}`}>
        {view === 'list'
          ? <SyncDecisionList review={review} provider="planning_center" batchName="Morning roster"
            onRefresh={() => { setCaptured(null); rerender(); }} onApply={(_token, selections) => capture(selections)}
            onAskAgain={(entry) => { setReview(simulateAskAgain(review, entry)); setCaptured(null); rerender(); }} />
          : <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:p-6">
            <SyncReview operationKind="people_sync" provider="planning_center" batchName="Morning roster"
              sourceName="Morning list" review={review} applying={false} onRefresh={() => { setCaptured(null); rerender(); }}
              onApply={(_token, selections) => capture(selections)} />
          </div>}
      </div>

      {captured && (
        <section aria-label="Captured selections" className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm dark:border-blue-800 dark:bg-blue-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-blue-950 dark:text-blue-100">
              Captured from the {captured.view === 'list' ? 'new list' : 'current review'} — no database was changed
            </h2>
            <button type="button"
              onClick={() => { setReview(simulateNextReview(review, captured.selections)); setSyncCount((value) => value + 1); setCaptured(null); setView('list'); rerender(); window.scrollTo(0, 0); }}
              className="rounded-md bg-blue-700 px-3 py-1.5 font-semibold text-white hover:bg-blue-800">
              Simulate next sync
            </button>
          </div>
          <pre className="mt-3 overflow-auto rounded-lg bg-white p-4 text-xs dark:bg-gray-900">{JSON.stringify(captured.selections, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
