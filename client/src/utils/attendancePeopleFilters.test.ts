import { describe, expect, it } from 'vitest';
import {
  filterAttendanceGroups,
  matchesAttendancePeopleFilters,
  type AttendancePeopleFilterPerson,
} from './attendancePeopleFilters';

type TestPerson = AttendancePeopleFilterPerson & {
  id: number;
  badgeKeys: string[];
};

const getBadgeKeys = (person: TestPerson) => person.badgeKeys;

describe('attendance people filters', () => {
  const adultRed: TestPerson = { id: 1, isChild: false, badgeKeys: ['red'] };
  const childBlue: TestPerson = { id: 2, isChild: true, badgeKeys: ['blue'] };
  const childGreen: TestPerson = { id: 3, isChild: true, badgeKeys: ['green'] };
  const adultCoachWithMedical: TestPerson = { id: 4, isChild: false, badgeKeys: ['coach', 'medical'] };

  it('treats selected badges as an OR filter', () => {
    const selectedBadgeKeys = new Set(['red', 'blue']);

    expect(matchesAttendancePeopleFilters(adultRed, 'all', selectedBadgeKeys, getBadgeKeys)).toBe(true);
    expect(matchesAttendancePeopleFilters(childBlue, 'all', selectedBadgeKeys, getBadgeKeys)).toBe(true);
    expect(matchesAttendancePeopleFilters(childGreen, 'all', selectedBadgeKeys, getBadgeKeys)).toBe(false);
  });

  it('matches any applicable badge when one person has ordinary and medical badges', () => {
    expect(matchesAttendancePeopleFilters(adultCoachWithMedical, 'all', new Set(['medical']), getBadgeKeys)).toBe(true);
    expect(matchesAttendancePeopleFilters(adultCoachWithMedical, 'all', new Set(['coach']), getBadgeKeys)).toBe(true);
    expect(matchesAttendancePeopleFilters(adultCoachWithMedical, 'all', new Set(['other']), getBadgeKeys)).toBe(false);
  });

  it('combines age and badge filters with AND', () => {
    const selectedBadgeKeys = new Set(['blue']);

    expect(matchesAttendancePeopleFilters(childBlue, 'child', selectedBadgeKeys, getBadgeKeys)).toBe(true);
    expect(matchesAttendancePeopleFilters(adultRed, 'child', selectedBadgeKeys, getBadgeKeys)).toBe(false);
    expect(matchesAttendancePeopleFilters(childGreen, 'child', selectedBadgeKeys, getBadgeKeys)).toBe(false);
  });

  it('keeps only matching members and removes empty families', () => {
    const groups = [
      { familyId: 10, familyName: 'One', members: [adultRed, childBlue] },
      { familyId: 20, familyName: 'Two', members: [childGreen] },
    ];

    expect(filterAttendanceGroups(groups, 'child', new Set(['blue']), getBadgeKeys)).toEqual([
      { familyId: 10, familyName: 'One', members: [childBlue] },
    ]);
    expect(groups[0].members).toEqual([adultRed, childBlue]);
  });
});
