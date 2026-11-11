import React from 'react';
import type { PeopleSyncReview } from './types';

export interface ReviewGathering { id: number; name: string }

/** Display projection only. Always submit the original signed review and choices. */
export function filterGatheringReview<T extends PeopleSyncReview>(review: T, gatheringId: string): T {
  if (gatheringId === 'all') return review;
  const matches = (action: { gatheringTypeId: number }) => String(action.gatheringTypeId) === gatheringId;
  return { ...review, plan: { ...review.plan,
    addToGathering: review.plan.addToGathering.filter(matches),
    removeFromGathering: review.plan.removeFromGathering.filter(matches),
  } };
}

export function reviewGatherings(review: PeopleSyncReview, gatherings: ReviewGathering[] = []): ReviewGathering[] {
  const reviewedLists = review.plan.sourceContext?.reviewedLists;
  const participatingIds = new Set([
    ...(reviewedLists || []).flatMap((list) => list.gatheringTypeId === null ? [] : [list.gatheringTypeId]),
    ...review.plan.addToGathering.map((action) => action.gatheringTypeId),
    ...review.plan.removeFromGathering.map((action) => action.gatheringTypeId),
  ]);
  const names = new Map(gatherings.filter((gathering) => !reviewedLists || participatingIds.has(gathering.id))
    .map((gathering) => [gathering.id, gathering.name]));
  for (const action of review.plan.removeFromGathering) {
    if (!names.has(action.gatheringTypeId)) names.set(action.gatheringTypeId, action.gatheringName || `Gathering ${action.gatheringTypeId}`);
  }
  for (const action of review.plan.addToGathering) {
    if (!names.has(action.gatheringTypeId)) names.set(action.gatheringTypeId, `Gathering ${action.gatheringTypeId}`);
  }
  for (const id of participatingIds) if (!names.has(id)) names.set(id, `Gathering ${id}`);
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export default function GatheringReviewFilter({ gatherings, value, onChange, disabled }: {
  gatherings: ReviewGathering[]; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  return <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
    <label className="flex flex-wrap items-center gap-3 text-sm font-medium">
      Gathering changes
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
        className="rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900">
        <option value="all">All gatherings</option>
        {gatherings.map((gathering) => <option key={gathering.id} value={String(gathering.id)}>{gathering.name}</option>)}
      </select>
    </label>
    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">People and household decisions stay visible. Apply includes your selections from all gatherings, including those hidden by this filter.</p>
  </div>;
}
