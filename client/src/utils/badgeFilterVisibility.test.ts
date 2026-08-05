import { describe, expect, it } from 'vitest';
import { shouldShowBadgeFilters } from './badgeFilterVisibility';

describe('badge filter visibility', () => {
  it('hides the filter when the default child badge is the only used badge', () => {
    expect(shouldShowBadgeFilters(['default-child'], 'default-child')).toBe(false);
  });

  it('shows the filter when the only used badge is not the default child badge', () => {
    expect(shouldShowBadgeFilters(['custom'], 'default-child')).toBe(true);
  });

  it('shows the filter when multiple badges are used', () => {
    expect(shouldShowBadgeFilters(['default-child', 'custom'], 'default-child')).toBe(true);
  });

  it('hides the filter when no badges are used', () => {
    expect(shouldShowBadgeFilters([], 'default-child')).toBe(false);
  });
});
