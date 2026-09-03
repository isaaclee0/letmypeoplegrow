import type {
  ContextualLongTermOverviewDto,
  EngagementOverviewDto,
  PastoralInsightsDto,
} from './api';

const CACHE_PREFIX = 'engagement-overview';
const PASTORAL_CACHE_PREFIX = 'pastoral-insights';
const LONG_TERM_TRENDS_CACHE_PREFIX = 'long-term-trends';
const OVERVIEW_SCHEMA_VERSION = 3;
const PASTORAL_SCHEMA_VERSION = 1;
const LONG_TERM_TRENDS_SCHEMA_VERSION = 4;
const PASTORAL_CACHE_TTL_MS = 5 * 60 * 1000;
const LONG_TERM_TRENDS_CACHE_LIMIT = 3;

function prefixForChurch(churchId: string): string {
  return `${CACHE_PREFIX}:v${OVERVIEW_SCHEMA_VERSION}:${encodeURIComponent(churchId)}:`;
}

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

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
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
  if (!isRecord(value) || value.schemaVersion !== OVERVIEW_SCHEMA_VERSION
      || 'movement' in value || !isString(value.churchId)
      || !isRecord(value.window) || !isSettings(value.settings)
      || !isRecord(value.setup) || !isRecord(value.population)
      || !isRecord(value.baseline) || !isRecord(value.historyBackfill)
      || !isRecord(value.primaryDistribution)
      || !isRecord(value.tierMovement)
      || !isRecord(value.matrix) || !isRecord(value.trend)
      || !isRecord(value.visitorJourney) || !isRecord(value.coverage)) return false;

  const dateFields = ['completedWeekEnd', 'sourceStart', 'sourceEnd', 'currentStart', 'currentEnd', 'comparisonStart', 'comparisonEnd'];
  if (!dateFields.every((field) => isCanonicalDate(value.window[field]))) return false;
  if (!isBoolean(value.setup.hasPrimaryRole)
      || !isBoolean(value.setup.hasStandardPrimaryRole)
      || !isBoolean(value.setup.hasPrimaryAssignments)
      || !isNumber(value.population.activeRegulars)) return false;
  if (!isBoolean(value.baseline.pending)
      || !isNonNegativeInteger(value.baseline.pendingAxes)) return false;
  const history = value.historyBackfill;
  if (!isBoolean(history.completed)
      || !(history.firstWeekEnd === null || isCanonicalDate(history.firstWeekEnd))
      || !(history.lastWeekEnd === null || isCanonicalDate(history.lastWeekEnd))
      || !isNonNegativeInteger(history.weeksEvaluated)
      || !isNonNegativeInteger(history.transitionsReconstructed)) return false;

  const distribution = value.primaryDistribution;
  if (!isRecord(distribution.classified) || !isNumber(distribution.classified.denominator)
      || !Array.isArray(distribution.classified.tiers)
      || !distribution.classified.tiers.every((tier) => isRecord(tier)
        && isOneOf(tier.tier, TIERS) && isTierStyle(tier)
        && isNumber(tier.count) && isNumber(tier.rate) && isString(tier.peopleToken))
      || !isCountDrilldown(distribution.establishing)
      || !isCountDrilldown(distribution.notAssigned)) return false;

  const movement = value.tierMovement;
  if (movement.recentWindowWeeks !== 13 || !isRecord(movement.axes)
      || !['primary', 'community'].every((axis) => isRecord(movement.axes[axis])
        && ['confirmingHigher', 'confirmingLower', 'confirmedRecently']
          .every((key) => isCountDrilldown(movement.axes[axis][key])))) return false;

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
      && isInteger(bucket.index) && isCanonicalDate(bucket.startDate) && isCanonicalDate(bucket.endDate)
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

function isAxisStatus(value: unknown): boolean {
  if (!isRecord(value) || !isOneOf(value.status, ['core', 'casual', 'irregular', 'establishing', 'not_assigned'])) return false;
  if (!isNumber(value.attended) || !isNumber(value.opportunities)) return false;
  return value.rate === null || isNumber(value.rate);
}

function isTierKey(value: unknown): boolean {
  return isOneOf(value, TIERS);
}

function isPastoralEvidence(type: unknown, evidence: unknown): boolean {
  if (!isRecord(evidence)) return false;
  if (type === 'primary_decline') {
    return isNonNegativeInteger(evidence.eventId)
      && isTierKey(evidence.fromTier)
      && isTierKey(evidence.toTier)
      && isCanonicalDate(evidence.effectiveWeekEnd)
      && isString(evidence.detectedAt)
      && isNullableString(evidence.recoveredAt);
  }
  if (type === 'community_primary_gap') {
    return isTierKey(evidence.primaryTier)
      && isTierKey(evidence.communityTier)
      && isCanonicalDate(evidence.completedWeekEnd);
  }
  if (type === 'visitor_next_step') {
    return isCanonicalDate(evidence.firstPrimaryAttendanceDate)
      && isNonNegativeInteger(evidence.laterPrimaryAttendances);
  }
  if (type === 're_engagement') {
    return isNonNegativeInteger(evidence.eventId)
      && isTierKey(evidence.fromTier)
      && isTierKey(evidence.toTier)
      && isCanonicalDate(evidence.effectiveWeekEnd)
      && isString(evidence.recoveredAt);
  }
  return false;
}

function isPastoralInsight(value: unknown): boolean {
  if (!isRecord(value)
      || !isInteger(value.id)
      || !isOneOf(value.type, ['primary_decline', 'community_primary_gap', 'visitor_next_step', 're_engagement'])
      || !isString(value.episodeKey)
      || !(value.declineEventId === null || isInteger(value.declineEventId))
      || !isRecord(value.person)
      || !isInteger(value.person.id)
      || !isString(value.person.firstName)
      || !isString(value.person.lastName)
      || !isOneOf(value.person.peopleType, ['regular', 'local_visitor', 'traveller_visitor'])
      || !isBoolean(value.person.isActive)
      || !(value.family === null || (isRecord(value.family) && isInteger(value.family.id) && isString(value.family.name)))
      || !(value.lastAttendance === null || (isRecord(value.lastAttendance)
        && isInteger(value.lastAttendance.individualId)
        && isCanonicalDate(value.lastAttendance.date)
        && isInteger(value.lastAttendance.gatheringTypeId)
        && isString(value.lastAttendance.gatheringName)
        && isOneOf(value.lastAttendance.engagementRole, ROLES)))
      || !isRecord(value.profiles)
      || !isAxisStatus(value.profiles.primary)
      || !isAxisStatus(value.profiles.community)
      || !isPastoralEvidence(value.type, value.evidence)
      || !Array.isArray(value.caregivers)
      || !value.caregivers.every((caregiver) => isRecord(caregiver)
        && isInteger(caregiver.assignmentId)
        && isOneOf(caregiver.type, ['user', 'contact'])
        && isInteger(caregiver.id)
        && isString(caregiver.firstName)
        && isString(caregiver.lastName)
        && isNullableString(caregiver.email)
        && isBoolean(caregiver.isActive))
      || !isRecord(value.deliverySummary)
      || !['pending', 'delivered', 'cancelled'].every((field) => isNumber(value.deliverySummary[field]))
      || !isRecord(value.workflow)
      || !isOneOf(value.workflow.state, ['open', 'snoozed', 'dismissed', 'resolved'])
      || !(value.workflow.snoozedUntil === null || isCanonicalDate(value.workflow.snoozedUntil))
      || !(value.workflow.actedBy === null || isInteger(value.workflow.actedBy))
      || !isNullableString(value.workflow.createdAt)
      || !isNullableString(value.workflow.updatedAt)) return false;
  return true;
}

function isPastoralInsights(value: unknown): value is PastoralInsightsDto {
  return isRecord(value)
    && value.schemaVersion === PASTORAL_SCHEMA_VERSION
    && isString(value.churchId)
    && isRecord(value.window)
    && isCanonicalDate(value.window.completedWeekEnd)
    && Array.isArray(value.insights)
    && value.insights.every(isPastoralInsight);
}

function churchKeys(churchId: string): string[] {
  const prefix = prefixForChurch(churchId);
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => !!key && key.startsWith(prefix));
  } catch {
    return [];
  }
}

function removeCacheEntry(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Cache persistence is an optional optimisation; server data remains authoritative.
  }
}

export function readEngagementOverviewCache(churchId: string): EngagementOverviewDto | null {
  const keys = churchKeys(churchId).sort().reverse();
  for (const key of keys) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) || 'null');
      if (!isOverview(parsed) || parsed.churchId !== churchId) {
        removeCacheEntry(key);
        continue;
      }
      const expectedKey = `${prefixForChurch(churchId)}${parsed.window.completedWeekEnd}`;
      if (key !== expectedKey) {
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

export function writeEngagementOverviewCache(overview: EngagementOverviewDto): void {
  if (!isOverview(overview)) return;
  const key = `${prefixForChurch(overview.churchId)}${overview.window.completedWeekEnd}`;
  try {
    localStorage.setItem(key, JSON.stringify(overview));
  } catch {
    // Cache persistence is an optional optimisation; server data remains authoritative.
  }
}

export function clearEngagementOverviewCache(churchId: string): void {
  churchKeys(churchId).forEach(removeCacheEntry);
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

function pastoralCacheKey(churchId: string): string {
  return `${PASTORAL_CACHE_PREFIX}:v${PASTORAL_SCHEMA_VERSION}:${encodeURIComponent(churchId)}`;
}

export function readPastoralInsightsCache(churchId: string): PastoralInsightsDto | null {
  const key = pastoralCacheKey(churchId);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    if (!isRecord(stored)
        || !isNumber(stored.cachedAt)
        || Date.now() - stored.cachedAt > PASTORAL_CACHE_TTL_MS
        || Date.now() < stored.cachedAt
        || !isPastoralInsights(stored.data)
        || stored.data.churchId !== churchId) {
      localStorage.removeItem(key);
      return null;
    }
    return stored.data;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function writePastoralInsightsCache(insights: PastoralInsightsDto): void {
  if (!isPastoralInsights(insights)) return;
  try {
    localStorage.setItem(pastoralCacheKey(insights.churchId), JSON.stringify({
      cachedAt: Date.now(),
      data: insights,
    }));
  } catch {
    // Cache persistence is an optional optimisation; server data remains authoritative.
  }
}

export function clearPastoralInsightsCache(churchId: string): void {
  localStorage.removeItem(pastoralCacheKey(churchId));
}
