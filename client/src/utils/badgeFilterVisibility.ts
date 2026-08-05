export function shouldShowBadgeFilters(
  usedBadgeKeys: readonly string[],
  defaultChildBadgeKey: string | null,
): boolean {
  if (usedBadgeKeys.length === 0) return false;

  return usedBadgeKeys.length !== 1
    || usedBadgeKeys[0] !== defaultChildBadgeKey;
}
