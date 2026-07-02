import { describe, it, expect } from 'vitest';
import { buildSelections } from './syncSelections';

describe('buildSelections', () => {
  it('maps ambiguous choices and skip set into the apply payload', () => {
    const ambiguousChoices = { 12: 'pco_a', 34: 'pco_b' };
    const skipAddPcoIds = new Set(['pco_x', 'pco_y']);
    expect(buildSelections(ambiguousChoices, skipAddPcoIds)).toEqual({
      ambiguous: { 12: 'pco_a', 34: 'pco_b' },
      skipAddPcoIds: ['pco_x', 'pco_y'],
      skipArchiveExtraIds: [],
      visitorChoices: {},
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
      skipArchiveExtraIds: [],
      visitorChoices: {},
    });
  });

  it('maps skipArchiveExtraIds and visitorChoices into the apply payload', () => {
    const skipArchiveExtraIds = new Set([56, 78]);
    const visitorChoices = { 90: 'promote', 91: 'keep', 92: null };
    const result = buildSelections({}, new Set(), skipArchiveExtraIds, visitorChoices);
    expect(result).toEqual({
      ambiguous: {},
      skipAddPcoIds: [],
      skipArchiveExtraIds: [56, 78],
      visitorChoices: { 90: 'promote', 91: 'keep' },
    });
  });
});
