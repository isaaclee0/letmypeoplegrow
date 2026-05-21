// Shapes shared by the sync review UI.
export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
}

// ambiguousChoices: individualId -> chosen pcoId (or null when the reviewer skipped).
// skipAddPcoIds: set of add-bucket pcoIds the reviewer deselected.
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>
): SyncSelections {
  const ambiguous: Record<string, string> = {};
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) ambiguous[individualId] = pcoId;
  }
  return { ambiguous, skipAddPcoIds: [...skipAddPcoIds] };
}
