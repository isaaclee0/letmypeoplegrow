import type { PeopleSyncSelections } from './types';

export type VisitorChoice = 'promote' | 'keep';

export interface SyncSelectionState {
  ambiguousChoices: Record<string, number | null>;
  skippedExternalIds: Set<string>;
  visitorChoices: Record<string, VisitorChoice | null>;
  acceptedArchiveIds: Set<number>;
  acceptedFamilyRenameIds: Set<string>;
}

function sortedRecord<T>(record: Record<string, T | null | undefined>): Record<string, T> {
  const entries: [string, T][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function buildSyncSelections(state: SyncSelectionState): PeopleSyncSelections {
  return {
    ambiguous: sortedRecord(state.ambiguousChoices),
    skipExternalPersonIds: [...state.skippedExternalIds].sort(),
    visitorChoices: sortedRecord(state.visitorChoices),
    acceptArchiveIndividualIds: [...state.acceptedArchiveIds].sort((left, right) => left - right),
    acceptFamilyRenameIds: [...state.acceptedFamilyRenameIds].sort(),
  };
}
