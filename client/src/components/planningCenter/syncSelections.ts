import type { PeopleSyncSelections } from '../peopleSync/types';

// Legacy Planning Center apply payload. Its ambiguous and family-rename
// semantics intentionally differ from PeopleSyncSelections, so keep this
// type named separately until the endpoint accepts the neutral contract.
export type VisitorChoice = 'promote' | 'keep';

export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
  visitorChoices: Record<string, VisitorChoice>;
  archiveAmbiguousIds: number[];
  skipFamilyNameUpdateIds: number[];
}

export interface LegacyPcoSelectionMap {
  ambiguousIndividualByExternalId: Record<string, number>;
  pcoIdByAmbiguousCandidateKey: Record<string, Record<number, string>>;
  visitorIndividualByExternalId: Record<string, number>;
  familyIdByRenameActionId: Record<string, number>;
}

// ambiguousChoices: individualId -> chosen pcoId (or null when the reviewer skipped).
//   The pcoId can come from an auto-detected candidate OR a manual search pick —
//   both are stored the same way.
// skipAddPcoIds: set of add-bucket pcoIds the reviewer deselected.
// visitorChoices: individualId -> 'promote' (link + convert to regular) or 'keep'
//   (mark as link-declined so future syncs don't re-prompt). null/undefined means
//   the reviewer made no decision — no change is applied this run.
// archiveAmbiguousIds: ambiguous individualIds the reviewer chose to archive outright
//   instead of picking a candidate.
// skipFamilyNameUpdateIds: familyIds to skip during family name updates.
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>,
  visitorChoices: Record<string, VisitorChoice | null> = {},
  archiveAmbiguousIds: Set<number> = new Set(),
  skipFamilyNameUpdateIds: Set<number> = new Set(),
): SyncSelections {
  const ambiguous: Record<string, string> = {};
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) ambiguous[individualId] = pcoId;
  }
  const vChoices: Record<string, VisitorChoice> = {};
  for (const [individualId, choice] of Object.entries(visitorChoices)) {
    if (choice === 'promote' || choice === 'keep') vChoices[individualId] = choice;
  }
  return {
    ambiguous,
    skipAddPcoIds: [...skipAddPcoIds].sort(),
    visitorChoices: vChoices,
    archiveAmbiguousIds: [...archiveAmbiguousIds].sort((a, b) => a - b),
    skipFamilyNameUpdateIds: [...skipFamilyNameUpdateIds].sort((a, b) => a - b),
  };
}

export function toLegacyPcoSelections(selections: PeopleSyncSelections, map: LegacyPcoSelectionMap): SyncSelections {
  const ambiguous = Object.fromEntries(Object.entries(selections.ambiguous || {})
    .flatMap(([externalId, candidateKey]) => {
      const individualId = map.ambiguousIndividualByExternalId[externalId];
      const pcoId = map.pcoIdByAmbiguousCandidateKey[externalId]?.[candidateKey];
      return individualId === undefined || pcoId === undefined ? [] : [[String(individualId), pcoId]];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
  const visitorChoices = Object.fromEntries(Object.entries(selections.visitorChoices || {})
    .flatMap(([externalId, choice]) => {
      const individualId = map.visitorIndividualByExternalId[externalId];
      return individualId === undefined ? [] : [[String(individualId), choice]];
    })
    .sort(([left], [right]) => left.localeCompare(right)) as [string, VisitorChoice][]);
  const acceptedRenames = new Set(selections.acceptFamilyRenameIds || []);

  return {
    ambiguous,
    skipAddPcoIds: [...(selections.skipExternalPersonIds || [])].sort(),
    visitorChoices,
    archiveAmbiguousIds: [...new Set(selections.acceptArchiveIndividualIds || [])]
      .filter((individualId) => Object.values(map.ambiguousIndividualByExternalId).includes(individualId))
      .sort((a, b) => a - b),
    skipFamilyNameUpdateIds: Object.entries(map.familyIdByRenameActionId)
      .filter(([actionId]) => !acceptedRenames.has(actionId))
      .map(([, familyId]) => familyId)
      .sort((a, b) => a - b),
  };
}
