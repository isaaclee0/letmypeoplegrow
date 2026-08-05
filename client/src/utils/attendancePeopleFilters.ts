export type AttendanceAgeFilter = 'all' | 'adult' | 'child';

export interface AttendancePeopleFilterPerson {
  isChild?: boolean;
}

export function matchesAttendancePeopleFilters<T extends AttendancePeopleFilterPerson>(
  person: T,
  ageFilter: AttendanceAgeFilter,
  selectedBadgeKeys: ReadonlySet<string>,
  getBadgeKey: (person: T) => string | null,
): boolean {
  if (ageFilter === 'adult' && person.isChild) return false;
  if (ageFilter === 'child' && !person.isChild) return false;

  return selectedBadgeKeys.size === 0
    || selectedBadgeKeys.has(getBadgeKey(person) || '');
}

export function filterAttendanceGroups<
  T extends AttendancePeopleFilterPerson,
  G extends { members: T[] },
>(
  groups: G[],
  ageFilter: AttendanceAgeFilter,
  selectedBadgeKeys: ReadonlySet<string>,
  getBadgeKey: (person: T) => string | null,
): G[] {
  return groups.flatMap((group) => {
    const members = group.members.filter((person) =>
      matchesAttendancePeopleFilters(person, ageFilter, selectedBadgeKeys, getBadgeKey));

    return members.length > 0 ? [{ ...group, members }] : [];
  });
}
