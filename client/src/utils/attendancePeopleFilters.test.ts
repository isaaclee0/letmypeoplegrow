import { describe, expect, it } from 'vitest';
import {
  filterAttendanceGroups,
  matchesAttendancePeopleFilters,
  type AttendancePeopleFilterPerson,
} from './attendancePeopleFilters';

type TestPerson = AttendancePeopleFilterPerson & {
  id: number;
  badgeKey: string | null;
};

const getBadgeKey = (person: TestPerson) => person.badgeKey;

describe('attendance people filters', () => {
  const adultRed: TestPerson = { id: 1, isChild: false, badgeKey: 'red' };
  const childBlue: TestPerson = { id: 2, isChild: true, badgeKey: 'blue' };
  const childGreen: TestPerson = { id: 3, isChild: true, badgeKey: 'green' };

  it('treats selected badges as an OR filter', () => {
    const selectedBadgeKeys = new Set(['red', 'blue']);

    expect(matchesAttendancePeopleFilters(adultRed, 'all', selectedBadgeKeys, getBadgeKey)).toBe(true);
    expect(matchesAttendancePeopleFilters(childBlue, 'all', selectedBadgeKeys, getBadgeKey)).toBe(true);
    expect(matchesAttendancePeopleFilters(childGreen, 'all', selectedBadgeKeys, getBadgeKey)).toBe(false);
  });

  it('combines age and badge filters with AND', () => {
    const selectedBadgeKeys = new Set(['blue']);

    expect(matchesAttendancePeopleFilters(childBlue, 'child', selectedBadgeKeys, getBadgeKey)).toBe(true);
    expect(matchesAttendancePeopleFilters(adultRed, 'child', selectedBadgeKeys, getBadgeKey)).toBe(false);
    expect(matchesAttendancePeopleFilters(childGreen, 'child', selectedBadgeKeys, getBadgeKey)).toBe(false);
  });

  it('keeps only matching members and removes empty families', () => {
    const groups = [
      { familyId: 10, familyName: 'One', members: [adultRed, childBlue] },
      { familyId: 20, familyName: 'Two', members: [childGreen] },
    ];

    expect(filterAttendanceGroups(groups, 'child', new Set(['blue']), getBadgeKey)).toEqual([
      { familyId: 10, familyName: 'One', members: [childBlue] },
    ]);
    expect(groups[0].members).toEqual([adultRed, childBlue]);
  });
});
