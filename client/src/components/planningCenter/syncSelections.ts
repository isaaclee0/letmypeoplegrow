// Shapes shared by the sync review UI.
export type VisitorChoice = 'promote' | 'keep';

export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
  visitorChoices: Record<string, VisitorChoice>;
  archiveAmbiguousIds: number[];
  skipFamilyNameUpdateIds: number[];
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
    skipAddPcoIds: [...skipAddPcoIds],
    visitorChoices: vChoices,
    archiveAmbiguousIds: [...archiveAmbiguousIds],
    skipFamilyNameUpdateIds: [...skipFamilyNameUpdateIds],
  };
}

