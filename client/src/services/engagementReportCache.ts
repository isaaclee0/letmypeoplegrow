import type { EngagementOverviewDto } from './api';

const CACHE_PREFIX = 'engagement-overview';
const SCHEMA_VERSION = 1;

function prefixForChurch(churchId: string): string {
  return `${CACHE_PREFIX}:v${SCHEMA_VERSION}:${encodeURIComponent(churchId)}:`;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && options.includes(value as T);
}

const TIERS = ['core', 'casual', 'irregular'] as const;
const ROLES = ['primary', 'community', 'other', 'unclassified'] as const;
const ATTENDANCE_TYPES = ['standard', 'headcount'] as const;

function isTierStyle(value: unknown): boolean {
  return isRecord(value) && isString(value.label) && isString(value.colour);
}

function isCountDrilldown(value: unknown): boolean {
  return isRecord(value) && isNumber(value.count) && isString(value.peopleToken);
}

function isRateFact(value: unknown): boolean {
  return isRecord(value)
    && isNumber(value.numerator)
    && isNumber(value.denominator)
    && isNumber(value.rate);
}

function isSettings(value: unknown): boolean {
  if (!isRecord(value) || !isInteger(value.coreMinimum) || !isInteger(value.casualMinimum)
      || !isRecord(value.tiers) || !TIERS.every((tier) => isTierStyle(value.tiers[tier]))
      || !Array.isArray(value.gatheringRoles) || !isInteger(value.calculationRulesVersion)
      || !isRecord(value.assignmentPreview)) return false;
  const preview = value.assignmentPreview;
  return value.gatheringRoles.every((assignment) => isRecord(assignment)
      && isInteger(assignment.gatheringTypeId)
      && isString(assignment.name)
      && isOneOf(assignment.attendanceType, ATTENDANCE_TYPES)
      && isBoolean(assignment.isActive)
      && (assignment.role === null || isOneOf(assignment.role, ROLES.slice(0, 3))))
    && isNumber(preview.primaryAssigned)
    && isNumber(preview.communityAssigned)
    && isNumber(preview.primaryNotAssigned);
}

function isOverview(value: unknown): value is EngagementOverviewDto {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !isString(value.churchId)
      || !isRecord(value.window) || !isSettings(value.settings)
      || !isRecord(value.setup) || !isRecord(value.population)
      || !isRecord(value.primaryDistribution) || !isRecord(value.movement)
      || !isRecord(value.matrix) || !isRecord(value.trend)
      || !isRecord(value.visitorJourney) || !isRecord(value.coverage)) return false;

  const dateFields = ['completedWeekEnd', 'sourceStart', 'sourceEnd', 'currentStart', 'currentEnd', 'comparisonStart', 'comparisonEnd'];
  if (!dateFields.every((field) => isString(value.window[field]))) return false;
  if (!isBoolean(value.setup.hasPrimaryRole)
      || !isBoolean(value.setup.hasStandardPrimaryRole)
      || !isBoolean(value.setup.hasPrimaryAssignments)
      || !isNumber(value.population.activeRegulars)) return false;

  const distribution = value.primaryDistribution;
  if (!isRecord(distribution.classified) || !isNumber(distribution.classified.denominator)
      || !Array.isArray(distribution.classified.tiers)
      || !distribution.classified.tiers.every((tier) => isRecord(tier)
        && isOneOf(tier.tier, TIERS) && isTierStyle(tier)
        && isNumber(tier.count) && isNumber(tier.rate) && isString(tier.peopleToken))
      || !isCountDrilldown(distribution.establishing)
      || !isCountDrilldown(distribution.notAssigned)) return false;

  const movement = value.movement;
  if (!isNumber(movement.denominator) || !isRecord(movement.categories)
      || !['higher', 'same', 'lower', 'nonComparable'].every((key) => isCountDrilldown(movement.categories[key]))) return false;

  const matrix = value.matrix;
  if (!isNumber(matrix.classifiedOnBothAxes) || !Array.isArray(matrix.cells)
      || !matrix.cells.every((cell) => isRecord(cell)
        && isOneOf(cell.primaryTier, TIERS) && isOneOf(cell.communityTier, TIERS)
        && isString(cell.primaryLabel) && isString(cell.communityLabel)
        && isNumber(cell.count) && isString(cell.peopleToken))
      || !isRecord(matrix.outside)
      || !['primaryEstablishing', 'primaryNotAssigned', 'communityEstablishing', 'communityNotAssigned', 'notClassifiedOnBothAxes']
        .every((field) => isNumber(matrix.outside[field]))) return false;

  if (!Array.isArray(value.trend.buckets) || !value.trend.buckets.every((bucket) => isRecord(bucket)
      && isInteger(bucket.index) && isString(bucket.startDate) && isString(bucket.endDate)
      && Array.isArray(bucket.series) && bucket.series.every((series) => isRecord(series)
        && isOneOf(series.role, ROLES) && isOneOf(series.attendanceType, ATTENDANCE_TYPES)
        && isNumber(series.heldSessions) && isNumber(series.totalAttendance)
        && isNumber(series.averageAttendance)
        && (series.uniquePeople === null || isNumber(series.uniquePeople))
        && isString(series.sessionsToken)
        && (series.peopleToken === null || isString(series.peopleToken))))) return false;

  const journey = value.visitorJourney;
  if (!isRecord(journey.local) || !isRecord(journey.traveller)
      || !isCountDrilldown(journey.local.firstTime)
      || !isCountDrilldown(journey.local.returnedWithinEightWeeks)
      || !isCountDrilldown(journey.local.currentRegular)
      || journey.local.conversionDateKnown !== false
      || !isCountDrilldown(journey.traveller.firstTime)) return false;

  const coverage = value.coverage;
  if (!isRecord(coverage.personLevelSessions) || !isRateFact(coverage.personLevelSessions)
      || !isNumber(coverage.personLevelSessions.excluded)
      || !isRateFact(coverage.explicitProvenance) || !isRateFact(coverage.legacyProvenance)
      || !isRateFact(coverage.establishing) || !isRateFact(coverage.primaryNotAssigned)
      || !isRecord(coverage.sessionsTokens)
      || !['eligible', 'explicit', 'legacy', 'excludedUnknown'].every((key) => isString(coverage.sessionsTokens[key]))) return false;

  return true;
}

function churchKeys(churchId: string): string[] {
  const prefix = prefixForChurch(churchId);
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => !!key && key.startsWith(prefix));
}

export function readEngagementOverviewCache(churchId: string): EngagementOverviewDto | null {
  const keys = churchKeys(churchId).sort().reverse();
  for (const key of keys) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) || 'null');
      if (!isOverview(parsed) || parsed.churchId !== churchId) {
        localStorage.removeItem(key);
        continue;
      }
      const expectedKey = `${prefixForChurch(churchId)}${parsed.window.completedWeekEnd}`;
      if (key !== expectedKey) {
        localStorage.removeItem(key);
        continue;
      }
      return parsed;
    } catch {
      localStorage.removeItem(key);
    }
  }
  return null;
}

export function writeEngagementOverviewCache(overview: EngagementOverviewDto): void {
  if (!isOverview(overview)) return;
  const key = `${prefixForChurch(overview.churchId)}${overview.window.completedWeekEnd}`;
  localStorage.setItem(key, JSON.stringify(overview));
}

export function clearEngagementOverviewCache(churchId: string): void {
  churchKeys(churchId).forEach((key) => localStorage.removeItem(key));
}
