export type AttendanceAgeFilter = 'all' | 'adult' | 'child';

export interface AttendancePeopleFilterPerson {
  isChild?: boolean;
}

export function matchesAttendancePeopleFilters<T extends AttendancePeopleFilterPerson>(
  person: T,
  ageFilter: AttendanceAgeFilter,
  selectedBadgeKeys: ReadonlySet<string>,
  getBadgeKeys: (person: T) => readonly string[],
): boolean {
  if (ageFilter === 'adult' && person.isChild) return false;
  if (ageFilter === 'child' && !person.isChild) return false;

  return matchesSelectedBadgeKeys(selectedBadgeKeys, getBadgeKeys(person));
}

export function filterAttendanceGroups<
  T extends AttendancePeopleFilterPerson,
  G extends { members: T[] },
>(
  groups: G[],
  ageFilter: AttendanceAgeFilter,
  selectedBadgeKeys: ReadonlySet<string>,
  getBadgeKeys: (person: T) => readonly string[],
): G[] {
  return groups.flatMap((group) => {
    const members = group.members.filter((person) =>
      matchesAttendancePeopleFilters(person, ageFilter, selectedBadgeKeys, getBadgeKeys));

    return members.length > 0 ? [{ ...group, members }] : [];
  });
}
import { matchesSelectedBadgeKeys } from './badgeFilters';
