import { describe, it, expect } from 'vitest';
import { buildSelections, toLegacyPcoSelections, VisitorChoice } from './syncSelections';

describe('buildSelections', () => {
  it('maps ambiguous choices and skip set into the apply payload', () => {
    const ambiguousChoices = { 12: 'pco_a', 34: 'pco_b' };
    const skipAddPcoIds = new Set(['pco_x', 'pco_y']);
    expect(buildSelections(ambiguousChoices, skipAddPcoIds)).toEqual({
      ambiguous: { 12: 'pco_a', 34: 'pco_b' },
      skipAddPcoIds: ['pco_x', 'pco_y'],
      visitorChoices: {},
      archiveAmbiguousIds: [],
      skipFamilyNameUpdateIds: [],
    });
  });

  it('omits ambiguous entries with no chosen pcoId (skipped)', () => {
    const ambiguousChoices = { 12: 'pco_a', 34: null };
    const result = buildSelections(ambiguousChoices, new Set());
    expect(result.ambiguous).toEqual({ 12: 'pco_a' });
    expect(result.skipAddPcoIds).toEqual([]);
  });

  it('returns empty selections when nothing chosen', () => {
    expect(buildSelections({}, new Set())).toEqual({
      ambiguous: {},
      skipAddPcoIds: [],
      visitorChoices: {},
      archiveAmbiguousIds: [],
      skipFamilyNameUpdateIds: [],
    });
  });

  it('maps visitorChoices into the apply payload, omitting undecided entries', () => {
    const visitorChoices: Record<number, VisitorChoice | null> = { 90: 'promote', 91: 'keep', 92: null };
    const result = buildSelections({}, new Set(), visitorChoices);
    expect(result).toEqual({
      ambiguous: {},
      skipAddPcoIds: [],
      visitorChoices: { 90: 'promote', 91: 'keep' },
      archiveAmbiguousIds: [],
      skipFamilyNameUpdateIds: [],
    });
  });

  it('includes archiveAmbiguousIds when provided', () => {
    const result = buildSelections({}, new Set(), {}, new Set([5, 6]));
    expect(result.archiveAmbiguousIds).toEqual([5, 6]);
  });

  it('includes skipFamilyNameUpdateIds when provided', () => {
    const result = buildSelections({}, new Set(), {}, new Set(), new Set([100, 200]));
    expect(result.skipFamilyNameUpdateIds).toEqual([100, 200]);
  });

  it('translates neutral selections to the legacy PCO endpoint shape', () => {
    expect(toLegacyPcoSelections({
      ambiguous: { 'pco-ambiguous:12': 1 },
      skipExternalPersonIds: ['pco-3'],
      visitorChoices: { 'pco-visitor:34': 'promote' },
      acceptArchiveIndividualIds: [12],
      acceptFamilyRenameIds: ['pco-rename:56'],
    }, {
      ambiguousIndividualByExternalId: { 'pco-ambiguous:12': 12 },
      visitorIndividualByExternalId: { 'pco-visitor:34': 34 },
      familyIdByRenameActionId: { 'pco-rename:56': 56, 'pco-rename:78': 78 },
      pcoIdByAmbiguousCandidateKey: { 'pco-ambiguous:12': { 1: '9007199254740993' } },
    })).toEqual({
      ambiguous: { 12: '9007199254740993' },
      skipAddPcoIds: ['pco-3'],
      visitorChoices: { 34: 'promote' },
      archiveAmbiguousIds: [12],
      skipFamilyNameUpdateIds: [78],
    });
  });
});
