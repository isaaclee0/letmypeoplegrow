// Shapes shared by the sync review UI.
export type VisitorChoice = 'promote' | 'keep';

export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
  skipArchiveExtraIds: number[];
  visitorChoices: Record<string, VisitorChoice>;
}

// ambiguousChoices: individualId -> chosen pcoId (or null when the reviewer skipped).
// skipAddPcoIds: set of add-bucket pcoIds the reviewer deselected.
// skipArchiveExtraIds: set of archiveExtras individualIds the reviewer deselected
//   (i.e. these LMPG individuals will NOT be archived this run).
// visitorChoices: individualId -> 'promote' (link + convert to regular) or 'keep'
//   (mark as link-declined so future syncs don't re-prompt). null/undefined means
//   the reviewer made no decision — no change is applied this run.
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>,
  skipArchiveExtraIds: Set<number> = new Set(),
  visitorChoices: Record<string, VisitorChoice | null> = {},
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
    skipArchiveExtraIds: [...skipArchiveExtraIds],
    visitorChoices: vChoices,
  };
}
