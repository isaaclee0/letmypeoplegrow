import { describe, it, expect, beforeEach } from 'vitest';

// Pure logic helper — mirrors the initialisation logic we'll add
function initialGroupByFamily(
  individualMode: boolean | undefined,
  storedValue: string | null
): boolean {
  if (storedValue !== null) return JSON.parse(storedValue);
  return individualMode ? false : true;
}

describe('groupByFamily initialisation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to true for a family-mode gathering with no stored pref', () => {
    expect(initialGroupByFamily(false, null)).toBe(true);
  });

  it('defaults to false for an individual-mode gathering with no stored pref', () => {
    expect(initialGroupByFamily(true, null)).toBe(false);
  });

  it('uses the stored value when present, regardless of gathering mode', () => {
    expect(initialGroupByFamily(true, 'true')).toBe(true);
    expect(initialGroupByFamily(false, 'false')).toBe(false);
  });
});
