import type { ContextualLongTermOverviewDto } from './api';

const LONG_TERM_TRENDS_CACHE_PREFIX = 'long-term-trends';
const LONG_TERM_TRENDS_RECENCY_PREFIX = 'long-term-trends-recency';
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
  if (!(availability.firstSessionDate === null || isCanonicalDate(availability.firstSessionDate))
      || !(availability.lastSessionDate === null || isCanonicalDate(availability.lastSessionDate))
      || (availability.availableWeeks > 0
        && (availability.firstSessionDate === null || availability.lastSessionDate === null))) return false;

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
      && (series.comparison === undefined || (isRecord(series.comparison)
        && series.comparison.comparisonWeeks === 12
        && isNullableNumber(series.comparison.previousAverage)
        && isNullableNumber(series.comparison.recentAverage)
        && isNullableNumber(series.comparison.percentChange)
        && isOneOf(series.comparison.status, ['up', 'down', 'steady', 'unavailable'])
        && (series.comparison.status === 'unavailable') === (series.comparison.percentChange === null)))
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
  if (value.declines === undefined) return false;
  if (value.increases !== undefined && (value.increases === null) !== standardOnly) return false;
  for (const change of [value.declines, value.increases]) {
    if (change === null || change === undefined) continue;
    if (!isRecord(change)
        || !isNonNegativeInteger(change.total)
        || !isString(change.peopleToken)
        || !Array.isArray(change.rows)
        || change.rows.length > 10
        || change.total < change.rows.length
        || !change.rows.every((row) => isRecord(row)
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

function recencyKey(churchId: string): string {
  return `${LONG_TERM_TRENDS_RECENCY_PREFIX}:v${LONG_TERM_TRENDS_SCHEMA_VERSION}:${encodeURIComponent(churchId)}`;
}

function readRecency(churchId: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recencyKey(churchId)) || '{}');
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => isNumber(entry[1])));
  } catch { return {}; }
}

function touchCacheEntry(churchId: string, key: string): Record<string, number> {
  const recency = readRecency(churchId);
  recency[key] = Math.max(Date.now(), ...Object.values(recency).map((value) => value + 1));
  try {
    localStorage.setItem(recencyKey(churchId), JSON.stringify(recency));
  } catch { /* Cache metadata is optional. */ }
  return recency;
}

function pruneRecency(churchId: string): void {
  try {
    const liveKeys = new Set(longTermTrendsKeys(churchId));
    const recency = Object.fromEntries(Object.entries(readRecency(churchId)).filter(([key]) => liveKeys.has(key)));
    if (liveKeys.size === 0) localStorage.removeItem(recencyKey(churchId));
    else localStorage.setItem(recencyKey(churchId), JSON.stringify(recency));
  } catch { /* Cache metadata is optional. */ }
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
      touchCacheEntry(churchId, key);
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
    const currentKey = longTermTrendsKey(canonicalOverview);
    localStorage.setItem(currentKey, JSON.stringify(canonicalOverview));
    const recency = touchCacheEntry(canonicalOverview.churchId, currentKey);
    const snapshots = longTermTrendsKeys(canonicalOverview.churchId).map((key) => {
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null') as unknown;
        return isContextualOverview(value) ? { key, value, recency: recency[key] ?? 0 } : null;
      } catch { return null; }
    }).filter((entry): entry is { key: string; value: ContextualLongTermOverviewDto; recency: number } => entry !== null)
      .sort((left, right) => right.value.window.completedWeekEnd.localeCompare(left.value.window.completedWeekEnd)
        || right.recency - left.recency);
    const retainedSelections = new Set<string>();
    for (const { key, value } of snapshots) {
      const selection = value.gatheringTypeIds.join(',');
      if (retainedSelections.has(selection) || retainedSelections.size >= LONG_TERM_TRENDS_CACHE_LIMIT) removeCacheEntry(key);
      else retainedSelections.add(selection);
    }
    pruneRecency(canonicalOverview.churchId);
  } catch {
    // Cache persistence is an optional optimisation; server data remains authoritative.
  }
}

export function clearLongTermTrendsCache(churchId: string, gatheringTypeIds?: number[]): void {
  if (gatheringTypeIds === undefined) {
    longTermTrendsKeys(churchId).forEach(removeCacheEntry);
    pruneRecency(churchId);
    return;
  }
  const canonicalIds = canonicalGatheringTypeIds([...gatheringTypeIds].sort((left, right) => left - right));
  if (!canonicalIds) return;
  const prefix = `${longTermTrendsPrefix(churchId)}${canonicalIds.join(',')}:`;
  longTermTrendsKeys(churchId).filter((key) => key.startsWith(prefix)).forEach(removeCacheEntry);
  pruneRecency(churchId);
}
