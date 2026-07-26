import { describe, it, expect } from 'vitest';
import { isAuthorityLocked, authorityLabel, PEOPLE_SOURCE_LOCKED } from './authorityLock';

describe('isAuthorityLocked', () => {
  it('is locked when the active authority has a matching external link', () => {
    expect(isAuthorityLocked({ planning_center: 'p1', elvanto: 'e1' }, 'elvanto')).toBe(true);
  });

  it('is not locked when the active authority has no link for this person', () => {
    expect(isAuthorityLocked({ planning_center: 'p1' }, 'elvanto')).toBe(false);
  });

  it('is never locked when there is no active authority, regardless of links', () => {
    expect(isAuthorityLocked({ elvanto: 'e1' }, 'none')).toBe(false);
  });

  it('is not locked when links is undefined', () => {
    expect(isAuthorityLocked(undefined, 'planning_center')).toBe(false);
  });

  it('is not locked when the matching link value is an empty string', () => {
    expect(isAuthorityLocked({ planning_center: '' }, 'planning_center')).toBe(false);
  });

  it('is locked for planning_center when only that link is present', () => {
    expect(isAuthorityLocked({ planning_center: 'p1' }, 'planning_center')).toBe(true);
  });
});

describe('authorityLabel', () => {
  it('labels planning_center as "Planning Center"', () => {
    expect(authorityLabel('planning_center')).toBe('Planning Center');
  });

  it('labels elvanto as "Elvanto"', () => {
    expect(authorityLabel('elvanto')).toBe('Elvanto');
  });

  it('labels none as "None"', () => {
    expect(authorityLabel('none')).toBe('None');
  });
});

describe('PEOPLE_SOURCE_LOCKED', () => {
  it('matches the server error code (services/peopleSync/authority.js)', () => {
    expect(PEOPLE_SOURCE_LOCKED).toBe('PEOPLE_SOURCE_LOCKED');
  });
});
