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

export interface ManualLinkPick { pcoId: string; firstName: string; lastName: string; }

export interface ReconciliationSelections {
  skipArchiveExtraIds: number[];
  manualLinks: Record<string, string>;
}

// skipArchiveExtraIds: archiveExtras individualIds the reviewer deselected
//   (i.e. these LMPG individuals will NOT be archived this run).
// manualLinks: archiveExtras individualId -> a manually-picked PCO person (or null
//   if not linked) — converted here to a pcoId-only map for the apply payload.
export function buildReconciliationSelections(
  skipArchiveExtraIds: Set<number>,
  manualLinks: Record<number, ManualLinkPick | null> = {},
): ReconciliationSelections {
  const links: Record<string, string> = {};
  for (const [individualId, pick] of Object.entries(manualLinks)) {
    if (pick) links[individualId] = pick.pcoId;
  }
  return { skipArchiveExtraIds: [...skipArchiveExtraIds], manualLinks: links };
}
