import { describe, expect, it } from 'vitest';
import {
  createBadgeFilterKey,
  createMedicalBadgeFilterOption,
  getApplicableBadgeFilterKeys,
  matchesSelectedBadgeKeys,
} from './badgeFilters';

describe('badge filters', () => {
  it('builds the configured medical badge option without medical text', () => {
    expect(createMedicalBadgeFilterOption({ icon: 'heart', color: '#facc15' })).toEqual({
      key: '["medical","heart","#facc15"]',
      text: null,
      icon: 'heart',
      backgroundColor: '#facc15',
      color: '#374151',
      helperText: 'Medical note recorded',
    });
    expect(createMedicalBadgeFilterOption(null)).toBeNull();
  });

  it('normalizes visual badge keys and preserves ordinary plus medical applicability', () => {
    expect(createBadgeFilterKey({ icon: 'star', backgroundColor: '#DC2626', text: 'Coach' }))
      .toBe('["star","#dc2626","Coach"]');
    expect(getApplicableBadgeFilterKeys('coach', true, 'medical')).toEqual(['coach', 'medical']);
    expect(getApplicableBadgeFilterKeys('coach', false, 'medical')).toEqual(['coach']);
  });

  it('matches any selected key that applies to a person', () => {
    expect(matchesSelectedBadgeKeys(new Set(), [])).toBe(true);
    expect(matchesSelectedBadgeKeys(new Set(['medical']), ['coach', 'medical'])).toBe(true);
    expect(matchesSelectedBadgeKeys(new Set(['other']), ['coach', 'medical'])).toBe(false);
  });
});
