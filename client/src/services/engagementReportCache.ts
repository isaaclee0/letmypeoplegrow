import type { ContextualLongTermOverviewDto } from './api';

const LONG_TERM_TRENDS_CACHE_PREFIX = 'long-term-trends';
const LONG_TERM_TRENDS_SCHEMA_VERSION = 4;
const LONG_TERM_TRENDS_CACHE_LIMIT = 3;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && options.includes(value as T);
}

const TIERS = ['core', 'casual', 'irregular'] as const;
const ATTENDANCE_TYPES = ['standard', 'headcount'] as const;

function isTierStyle(value: unknown): boolean {
  return isRecord(value) && isString(value.label) && isString(value.colour);
}

function canonicalGatheringTypeIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0
      || !value.every((id) => isInteger(id) && id > 0)) return null;
  const canonical = [...new Set(value)].sort((left, right) => left - right);
  return canonical.length === value.length && canonical.every((id, index) => id === value[index])
    ? canonical
    : null;
}

function normaliseGatheringTypeIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0
      || !value.every((id) => isInteger(id) && id > 0)) return null;
  return [...new Set(value)].sort((left, right) => left - right);
}

function isContextualSettings(value: unknown): boolean {
  return isRecord(value)
    && isInteger(value.coreMinimum)
    && isInteger(value.casualMinimum)
    && isInteger(value.calculationRulesVersion)
    && isRecord(value.tiers)
    && TIERS.every((tier) => isTierStyle(value.tiers[tier]));
}

function isContextualEvidence(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeInteger(value.attendedWeeks)
    && isNonNegativeInteger(value.opportunityWeeks)
    && isNumber(value.rate);
}

function isContextualOverview(value: unknown): value is ContextualLongTermOverviewDto {
  if (!isRecord(value)
      || value.schemaVersion !== LONG_TERM_TRENDS_SCHEMA_VERSION
      || !isString(value.churchId)
      || !canonicalGatheringTypeIds(value.gatheringTypeIds)
      || !isRecord(value.window)
      || !isContextualSettings(value.settings)
      || !isRecord(value.dataAvailability)
      || !isRecord(value.direction)) return false;

  const window = value.window;
  if (!isCanonicalDate(window.completedWeekEnd)
      || !isCanonicalDate(window.startDate)
      || !isCanonicalDate(window.endDate)
      || window.maximumWeeks !== 52) return false;

  const availability = value.dataAvailability;
  if (!['availableWeeks', 'validOpportunityWeeks', 'excludedWeeks', 'unclassifiedBecauseNoEvidence', 'standardGatherings', 'headcountGatherings']
    .every((field) => isNonNegativeInteger(availability[field]))) return false;

  const direction = value.direction;
  if (direction.comparisonWeeks !== 12
      || !isNullableNumber(direction.previousAverage)
      || !isNullableNumber(direction.recentAverage)
      || !isNullableNumber(direction.percentChange)
      || !isOneOf(direction.status, ['up', 'down', 'steady', 'unavailable'])
      || (direction.status === 'unavailable') !== (direction.percentChange === null)
      || !Array.isArray(direction.series)
      || direction.series.length !== value.gatheringTypeIds.length) return false;

  const seriesIds = direction.series.map((series) => isRecord(series) ? series.gatheringTypeId : null);
  if (seriesIds.some((id) => !isInteger(id))
      || !seriesIds.every((id, index) => id === value.gatheringTypeIds[index])) return false;
  if (!direction.series.every((series) => isRecord(series)
      && isInteger(series.gatheringTypeId)
      && isString(series.name)
      && isOneOf(series.attendanceType, ATTENDANCE_TYPES)
      && Array.isArray(series.buckets)
      && series.buckets.length === 13
      && series.buckets.every((bucket, index) => isRecord(bucket)
        && bucket.index === index
        && isCanonicalDate(bucket.startDate)
        && isCanonicalDate(bucket.endDate)
        && isNonNegativeInteger(bucket.heldSessions)
        && isNullableNumber(bucket.averageAttendance)
        && isString(bucket.sessionsToken)))) return false;

  const standardOnly = availability.standardGatherings === 0;
  if ((value.regularity === null) !== standardOnly || (value.declines === null) !== standardOnly) return false;
  if (value.regularity !== null) {
    if (!isRecord(value.regularity)
        || !isNonNegativeInteger(value.regularity.population)
        || !Array.isArray(value.regularity.tiers)
        || value.regularity.tiers.length !== TIERS.length
        || !value.regularity.tiers.every((tier, index) => isRecord(tier)
          && tier.tier === TIERS[index]
          && isTierStyle(tier)
          && isNonNegativeInteger(tier.count)
          && isNumber(tier.rate)
          && isString(tier.peopleToken))) return false;
  }
  if (value.declines !== null) {
    if (!isRecord(value.declines)
        || !isNonNegativeInteger(value.declines.total)
        || !isString(value.declines.peopleToken)
        || !Array.isArray(value.declines.rows)
        || value.declines.rows.length > 10
        || value.declines.total < value.declines.rows.length
        || !value.declines.rows.every((row) => isRecord(row)
          && isInteger(row.individualId)
          && row.individualId > 0
          && isString(row.firstName)
          && isString(row.lastName)
          && isString(row.summary)
          && isContextualEvidence(row.baseline)
          && isContextualEvidence(row.recent))) return false;
  }
  return true;
}

function removeCacheEntry(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Cache persistence is an optional optimisation; server data remains authoritative.
  }
}

function longTermTrendsPrefix(churchId: string): string {
  return `${LONG_TERM_TRENDS_CACHE_PREFIX}:v${LONG_TERM_TRENDS_SCHEMA_VERSION}:${encodeURIComponent(churchId)}:`;
}

function longTermTrendsKeys(churchId: string): string[] {
  const prefix = longTermTrendsPrefix(churchId);
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => !!key && key.startsWith(prefix));
  } catch {
    return [];
  }
}

function longTermTrendsKey(overview: ContextualLongTermOverviewDto): string {
  return `${longTermTrendsPrefix(overview.churchId)}${overview.gatheringTypeIds.join(',')}:${overview.window.completedWeekEnd}`;
}

export function readLongTermTrendsCache(
  churchId: string,
  gatheringTypeIds: number[],
): ContextualLongTermOverviewDto | null {
  const canonicalIds = canonicalGatheringTypeIds([...gatheringTypeIds].sort((left, right) => left - right));
  if (!canonicalIds) return null;
  const prefix = `${longTermTrendsPrefix(churchId)}${canonicalIds.join(',')}:`;
  const keys = longTermTrendsKeys(churchId).filter((key) => key.startsWith(prefix)).sort().reverse();
  for (const key of keys) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) || 'null');
      if (!isContextualOverview(parsed)
          || parsed.churchId !== churchId
          || parsed.gatheringTypeIds.join(',') !== canonicalIds.join(',')
          || key !== longTermTrendsKey(parsed)) {
        removeCacheEntry(key);
        continue;
      }
      return parsed;
    } catch {
      removeCacheEntry(key);
    }
  }
  return null;
}

export function writeLongTermTrendsCache(overview: ContextualLongTermOverviewDto): void {
  const gatheringTypeIds = normaliseGatheringTypeIds(overview.gatheringTypeIds);
  if (!gatheringTypeIds) return;
  const canonicalOverview = {
    ...overview,
    gatheringTypeIds,
    direction: {
      ...overview.direction,
      series: [...overview.direction.series].sort(
        (left, right) => left.gatheringTypeId - right.gatheringTypeId,
      ),
    },
  };
  if (!isContextualOverview(canonicalOverview)) return;
  try {
    localStorage.setItem(longTermTrendsKey(canonicalOverview), JSON.stringify(canonicalOverview));
    const keys = longTermTrendsKeys(canonicalOverview.churchId).sort().reverse();
    keys.slice(LONG_TERM_TRENDS_CACHE_LIMIT).forEach(removeCacheEntry);
  } catch {
    // Cache persistence is an optional optimisation; server data remains authoritative.
  }
}

export function clearLongTermTrendsCache(churchId: string, gatheringTypeIds?: number[]): void {
  if (gatheringTypeIds === undefined) {
    longTermTrendsKeys(churchId).forEach(removeCacheEntry);
    return;
  }
  const canonicalIds = canonicalGatheringTypeIds([...gatheringTypeIds].sort((left, right) => left - right));
  if (!canonicalIds) return;
  const prefix = `${longTermTrendsPrefix(churchId)}${canonicalIds.join(',')}:`;
  longTermTrendsKeys(churchId).filter((key) => key.startsWith(prefix)).forEach(removeCacheEntry);
}
