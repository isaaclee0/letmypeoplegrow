'use strict';

const Database = require('../../config/database');
const {
  addDateOnly,
  getChurchDate,
  getZonedParts,
  loadChurchTimeZone,
} = require('../../utils/churchTime');
const { getEngagementSettings } = require('./settings');
const { TIER_RANK } = require('./tiers');
const {
  DrilldownTokenError,
  createDrilldownToken,
  readDrilldownToken,
} = require('./drilldownTokens');

const TIER_KEYS = Object.freeze(['core', 'casual', 'irregular']);
const MAXIMUM_WEEKS = 52;
const COMPARISON_WEEKS = 12;
const RECENT_CHANGE_WEEKS = 8;
const MINIMUM_BASELINE_OPPORTUNITIES = 8;
const MINIMUM_RECENT_OPPORTUNITIES = 4;
const PREVIEW_LIMIT = 10;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

class InvalidReportGatheringError extends Error {
  constructor() {
    super('Select one or more valid gatherings for this church.');
    this.name = 'InvalidReportGatheringError';
    this.code = 'INVALID_REPORT_GATHERING';
    this.status = 400;
  }
}

function invalidGatheringSelection() {
  return new InvalidReportGatheringError();
}

function canonicalGatheringIds(values) {
  if (!Array.isArray(values) || values.length === 0) throw invalidGatheringSelection();
  const ids = [...new Set(values.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw invalidGatheringSelection();
  }
  return ids.sort((a, b) => a - b);
}

function getContextualWindow(asOf = new Date(), timeZone = 'UTC') {
  const instant = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(instant.getTime())) throw new TypeError('A valid asOf instant is required.');
  const localDate = getChurchDate(instant, timeZone);
  const { weekday } = getZonedParts(instant, timeZone);
  const daysSinceMonday = (weekday + 6) % 7;
  const completedWeekEnd = addDateOnly(localDate, { days: -(daysSinceMonday + 1) });
  return windowForCompletedWeek(completedWeekEnd);
}

function windowForCompletedWeek(completedWeekEnd) {
  const startDate = addDateOnly(completedWeekEnd, { days: -363 });
  return {
    completedWeekEnd,
    startDate,
    endDate: completedWeekEnd,
    maximumWeeks: MAXIMUM_WEEKS,
  };
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

async function loadSelectedGatherings(churchId, gatheringTypeIds) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT id, name, attendance_type AS attendanceType, is_active AS isActive
     FROM gathering_types
     WHERE id IN (${placeholders(gatheringTypeIds)})
       AND church_id = ?
     ORDER BY id`,
    [...gatheringTypeIds, churchId],
  );
  if (rows.length !== gatheringTypeIds.length
      || rows.some((row, index) => Number(row.id) !== gatheringTypeIds[index])) {
    throw invalidGatheringSelection();
  }
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    isActive: Number(row.isActive) === 1,
  }));
}

async function loadContextualSource(churchId, gatheringTypeIds, window) {
  const inClause = placeholders(gatheringTypeIds);
  const query = (sql, params) => Database.queryForChurch(churchId, sql, params);
  const [people, sessions, records, headcounts] = await Promise.all([
    query(
      `SELECT DISTINCT
              i.id,
              i.first_name AS firstName,
              i.last_name AS lastName,
              i.family_id AS familyId
       FROM gathering_lists gl
       JOIN individuals i
         ON i.id = gl.individual_id
        AND i.church_id = ?
        AND i.is_active = 1
        AND i.people_type = 'regular'
       JOIN gathering_types gt
         ON gt.id = gl.gathering_type_id
        AND gt.church_id = ?
        AND gt.is_active = 1
        AND gt.attendance_type = 'standard'
       WHERE gl.church_id = ?
         AND gl.gathering_type_id IN (${inClause})
       ORDER BY i.last_name COLLATE NOCASE, i.first_name COLLATE NOCASE, i.id`,
      [churchId, churchId, churchId, ...gatheringTypeIds],
    ),
    query(
      `SELECT s.id,
              s.gathering_type_id AS gatheringTypeId,
              s.session_date AS sessionDate,
              s.session_status AS sessionStatus,
              s.excluded_from_stats AS excludedFromStats,
              s.headcount_mode AS headcountMode,
              s.roster_snapshotted AS rosterSnapshotted,
              s.roster_provenance_version AS rosterProvenanceVersion,
              gt.attendance_type AS attendanceType
       FROM attendance_sessions s
       JOIN gathering_types gt
         ON gt.id = s.gathering_type_id
        AND gt.church_id = ?
       WHERE s.church_id = ?
         AND s.gathering_type_id IN (${inClause})
         AND s.session_date >= ?
         AND s.session_date <= ?
         AND (
           (gt.attendance_type = 'standard' AND EXISTS (
             SELECT 1
             FROM attendance_records report_ar
             WHERE report_ar.session_id = s.id
               AND report_ar.church_id = s.church_id
               AND report_ar.present = 1
           ))
           OR (gt.attendance_type = 'headcount' AND EXISTS (
             SELECT 1
             FROM headcount_records report_hr
             WHERE report_hr.session_id = s.id
               AND report_hr.church_id = s.church_id
               AND report_hr.headcount > 0
           ))
         )
       ORDER BY s.session_date, s.id`,
      [churchId, churchId, ...gatheringTypeIds, window.startDate, window.endDate],
    ),
    query(
      `SELECT ar.session_id AS sessionId,
              ar.individual_id AS individualId,
              ar.present,
              ar.eligible_at_snapshot AS eligibleAtSnapshot,
              ar.people_type_at_time AS peopleTypeAtTime
       FROM attendance_records ar
       JOIN attendance_sessions s
         ON s.id = ar.session_id
        AND s.church_id = ?
       JOIN individuals i
         ON i.id = ar.individual_id
        AND i.church_id = ?
       WHERE ar.church_id = ?
         AND s.gathering_type_id IN (${inClause})
         AND s.session_date >= ?
         AND s.session_date <= ?
       ORDER BY ar.session_id, ar.individual_id`,
      [
        churchId,
        churchId,
        churchId,
        ...gatheringTypeIds,
        window.startDate,
        window.endDate,
      ],
    ),
    query(
      `SELECT hr.session_id AS sessionId, hr.headcount
       FROM headcount_records hr
       JOIN attendance_sessions s
         ON s.id = hr.session_id
        AND s.church_id = ?
       WHERE hr.church_id = ?
         AND s.gathering_type_id IN (${inClause})
         AND s.session_date >= ?
         AND s.session_date <= ?
       ORDER BY hr.session_id, hr.id`,
      [churchId, churchId, ...gatheringTypeIds, window.startDate, window.endDate],
    ),
  ]);
  return { people, sessions, records, headcounts };
}

function mondayFor(date) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('Invalid session date.');
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  return addDateOnly(date, { days: -daysSinceMonday });
}

function isReportableSession(session) {
  return session.sessionStatus !== 'cancelled' && Number(session.excludedFromStats) !== 1;
}

function provenanceFor(session) {
  if (Number(session.rosterProvenanceVersion) >= 1) return 'explicit';
  if (Number(session.rosterProvenanceVersion) === 0
      && Number(session.rosterSnapshotted) === 1) return 'legacy';
  return 'unknown';
}

function historyTypeIsRegular(record, provenance) {
  if (record.peopleTypeAtTime === 'regular') return true;
  if (record.peopleTypeAtTime === 'local_visitor'
      || record.peopleTypeAtTime === 'traveller_visitor') return false;
  return record.peopleTypeAtTime == null && provenance === 'legacy';
}

function recordCreatesOpportunity(record, provenance) {
  return historyTypeIsRegular(record, provenance)
    && (provenance === 'legacy' || Number(record.eligibleAtSnapshot) === 1);
}

function groupedBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    const group = result.get(value) || [];
    group.push(row);
    result.set(value, group);
  }
  return result;
}

function contextualTier(rate, settings) {
  if (rate >= settings.coreMinimum / 100) return 'core';
  if (rate >= settings.casualMinimum / 100) return 'casual';
  return 'irregular';
}

function rounded(value) {
  const result = Math.round((value + Number.EPSILON) * 10) / 10;
  return Object.is(result, -0) ? 0 : result;
}

function percentage(numerator, denominator) {
  return denominator === 0 ? null : rounded((numerator / denominator) * 100);
}

function buildEvidence(source, settings) {
  const populationIds = new Set(source.people.map(({ id }) => Number(id)));
  const recordsBySession = groupedBy(source.records, (record) => Number(record.sessionId));
  const standardHeld = source.sessions.filter(
    (session) => session.attendanceType === 'standard' && isReportableSession(session),
  );
  const sessionsByWeek = groupedBy(standardHeld, (session) => mondayFor(session.sessionDate));
  const validWeeks = [];
  const excludedWeeks = [];
  const factsByPerson = new Map(source.people.map(({ id }) => [Number(id), []]));

  for (const [weekStart, weekSessions] of sessionsByWeek) {
    const reliableSessions = weekSessions.filter((session) => provenanceFor(session) !== 'unknown');
    if (reliableSessions.length === 0) {
      excludedWeeks.push(weekStart);
      continue;
    }
    validWeeks.push(weekStart);
    const weeklyEvidence = new Map();
    for (const session of reliableSessions) {
      const provenance = provenanceFor(session);
      for (const record of recordsBySession.get(Number(session.id)) || []) {
        const individualId = Number(record.individualId);
        if (!populationIds.has(individualId) || !historyTypeIsRegular(record, provenance)) continue;
        const evidence = weeklyEvidence.get(individualId) || {
          hasOpportunity: false,
          attended: false,
        };
        if (recordCreatesOpportunity(record, provenance)) evidence.hasOpportunity = true;
        if (Number(record.present) === 1) evidence.attended = true;
        weeklyEvidence.set(individualId, evidence);
      }
    }
    for (const [individualId, evidence] of weeklyEvidence) {
      if (evidence.hasOpportunity) {
        factsByPerson.get(individualId).push({ weekStart, attended: evidence.attended });
      }
    }
  }

  validWeeks.sort();
  excludedWeeks.sort();
  const profiles = source.people.map((person) => {
    const facts = factsByPerson.get(Number(person.id)) || [];
    const attendedWeeks = facts.filter(({ attended }) => attended).length;
    const opportunityWeeks = facts.length;
    const attendanceRate = opportunityWeeks === 0 ? null : attendedWeeks / opportunityWeeks;
    return {
      individualId: Number(person.id),
      firstName: person.firstName,
      lastName: person.lastName,
      familyId: person.familyId ?? null,
      attendedWeeks,
      opportunityWeeks,
      attendanceRate,
      tier: attendanceRate === null ? null : contextualTier(attendanceRate, settings),
      facts,
    };
  });
  return { profiles, validWeeks, excludedWeeks };
}

function headcountAttendance(values, mode) {
  if (values.length === 0) return 0;
  if (mode === 'combined') return values.reduce((sum, value) => sum + value, 0);
  if (mode === 'averaged') {
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return Math.max(...values);
}

function buildSessionFacts(source) {
  const recordsBySession = groupedBy(source.records, (record) => Number(record.sessionId));
  const headcountsBySession = groupedBy(source.headcounts, (row) => Number(row.sessionId));
  const facts = new Map();
  for (const session of source.sessions) {
    if (session.attendanceType === 'standard') {
      const people = new Set((recordsBySession.get(Number(session.id)) || [])
        .filter((record) => Number(record.present) === 1)
        .map((record) => Number(record.individualId)));
      facts.set(Number(session.id), { attendance: people.size, people });
    } else {
      const values = (headcountsBySession.get(Number(session.id)) || [])
        .map(({ headcount }) => Number(headcount));
      facts.set(Number(session.id), {
        attendance: headcountAttendance(values, session.headcountMode),
        people: null,
      });
    }
  }
  return facts;
}

function tokenExpiry(expiresAt) {
  if (expiresAt) return expiresAt;
  return new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();
}

function issueToken({
  churchId,
  kind,
  gatheringTypeIds,
  selector,
  completedWeekEnd,
  expiresAt,
}) {
  return createDrilldownToken({
    churchId,
    kind,
    gatheringTypeIds,
    selector: { ...selector, gatheringTypeIds },
    completedWeekEnd,
    expiresAt,
  });
}

function averageForSessions(sessions, facts) {
  if (sessions.length === 0) return null;
  return sessions.reduce((sum, session) => sum + facts.get(Number(session.id)).attendance, 0)
    / sessions.length;
}

function sessionSummary(sessions, facts) {
  const total = sessions.reduce(
    (sum, session) => sum + facts.get(Number(session.id)).attendance,
    0,
  );
  return {
    total,
    count: sessions.length,
    average: sessions.length === 0 ? null : total / sessions.length,
  };
}

function directionStatus(previous, recent) {
  if (previous.count === 0 || recent.count === 0) {
    return { percentChange: null, status: 'unavailable' };
  }
  let percentChange;
  if (previous.total === 0) percentChange = recent.total === 0 ? 0 : 100;
  else percentChange = ((recent.average - previous.average) / previous.average) * 100;
  const normalized = rounded(percentChange);
  if (previous.total === 0) {
    return { percentChange: normalized, status: recent.total === 0 ? 'steady' : 'up' };
  }
  // Cross-multiply the rational averages so exact one-percent changes do not
  // slip below the boundary through floating-point representation.
  const differenceNumerator = (recent.total * previous.count)
    - (previous.total * recent.count);
  const belowOnePercent = Math.abs(differenceNumerator) * 100
    < previous.total * recent.count;
  if (belowOnePercent) return { percentChange: normalized, status: 'steady' };
  return { percentChange: normalized, status: differenceNumerator > 0 ? 'up' : 'down' };
}

function buildDirection({ churchId, gatheringTypeIds, gatherings, source, window, expiresAt }) {
  const facts = buildSessionFacts(source);
  const heldSessions = source.sessions.filter(isReportableSession);
  const recentStart = addDateOnly(window.endDate, { days: -83 });
  const previousEnd = addDateOnly(recentStart, { days: -1 });
  const previousStart = addDateOnly(previousEnd, { days: -83 });
  const compareSessions = (sessions) => {
    const previousSessions = sessions.filter(
      (session) => session.sessionDate >= previousStart && session.sessionDate <= previousEnd,
    );
    const recentSessions = sessions.filter(
      (session) => session.sessionDate >= recentStart && session.sessionDate <= window.endDate,
    );
    const previous = sessionSummary(previousSessions, facts);
    const recent = sessionSummary(recentSessions, facts);
    return {
      comparisonWeeks: COMPARISON_WEEKS,
      previousAverage: previous.average === null ? null : rounded(previous.average),
      recentAverage: recent.average === null ? null : rounded(recent.average),
      ...directionStatus(previous, recent),
    };
  };
  const series = gatherings.map((gathering) => {
    const gatheringSessions = heldSessions.filter(
      (session) => Number(session.gatheringTypeId) === gathering.id,
    );
    const buckets = Array.from({ length: 13 }, (_, index) => {
      const startDate = addDateOnly(window.startDate, { days: index * 28 });
      const endDate = addDateOnly(startDate, { days: 27 });
      const bucketSessions = gatheringSessions.filter(
        (session) => session.sessionDate >= startDate && session.sessionDate <= endDate,
      );
      const bucketAverage = averageForSessions(bucketSessions, facts);
      return {
        index,
        startDate,
        endDate,
        heldSessions: bucketSessions.length,
        averageAttendance: bucketAverage === null ? null : rounded(bucketAverage),
        sessionsToken: issueToken({
          churchId,
          kind: 'sessions',
          gatheringTypeIds,
          selector: { type: 'gathering_series', gatheringTypeId: gathering.id, bucketIndex: index },
          completedWeekEnd: window.completedWeekEnd,
          expiresAt,
        }),
      };
    });
    return {
      gatheringTypeId: gathering.id,
      name: gathering.name,
      attendanceType: gathering.attendanceType,
      comparison: compareSessions(gatheringSessions),
      buckets,
    };
  });

  return { ...compareSessions(heldSessions), series };
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function declineSummary(baseline, recent) {
  const divisor = gcd(baseline.attendedWeeks, baseline.opportunityWeeks);
  const usualAttended = baseline.attendedWeeks / divisor;
  const usualOpportunities = baseline.opportunityWeeks / divisor;
  const usualUnit = usualOpportunities === 1 ? 'week' : 'weeks';
  const recentUnit = recent.opportunityWeeks === 1 ? 'week' : 'weeks';
  return `Usually attends ${usualAttended} ${usualUnit} in ${usualOpportunities}; attended ${recent.attendedWeeks} of the last ${recent.opportunityWeeks} ${recentUnit}.`;
}

function publicAttendanceChange(candidate) {
  return {
    individualId: candidate.individualId,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    baseline: candidate.baseline,
    recent: candidate.recent,
    summary: candidate.summary,
  };
}

function compareNames(left, right) {
  return compareTierKey(tierSortKey(left), tierSortKey(right));
}

function compareChanges(left, right) {
  return compareChangeKey(changeSortKey(left), changeSortKey(right));
}

function buildChangeCandidates(evidence, settings, direction) {
  const sign = direction === 'increase' ? -1 : 1;
  const recentWeeks = new Set(evidence.validWeeks.slice(-RECENT_CHANGE_WEEKS));
  const baselineWeeks = new Set(evidence.validWeeks.slice(0, -RECENT_CHANGE_WEEKS));
  const candidates = [];
  for (const profile of evidence.profiles) {
    const baselineFacts = profile.facts.filter(({ weekStart }) => baselineWeeks.has(weekStart));
    const recentFacts = profile.facts.filter(({ weekStart }) => recentWeeks.has(weekStart));
    if (baselineFacts.length < MINIMUM_BASELINE_OPPORTUNITIES
        || recentFacts.length < MINIMUM_RECENT_OPPORTUNITIES) continue;
    const baselineAttended = baselineFacts.filter(({ attended }) => attended).length;
    const recentAttended = recentFacts.filter(({ attended }) => attended).length;
    const baselineRate = baselineAttended / baselineFacts.length;
    const recentRate = recentAttended / recentFacts.length;
    const baselineTier = contextualTier(baselineRate, settings);
    const recentTier = contextualTier(recentRate, settings);
    const tierChange = sign * (TIER_RANK[baselineTier] - TIER_RANK[recentTier]);
    const percentagePointChange = sign * (baselineRate - recentRate) * 100;
    // Twenty percentage points is exactly one fifth. Compare the original
    // integer evidence as fractions so equality survives floating point.
    const changeNumerator = sign * ((baselineAttended * recentFacts.length)
      - (recentAttended * baselineFacts.length));
    const meetsMinimumChange = changeNumerator * 5
      >= baselineFacts.length * recentFacts.length;
    if (tierChange <= 0 || !meetsMinimumChange) continue;
    const baseline = {
      attendedWeeks: baselineAttended,
      opportunityWeeks: baselineFacts.length,
      rate: percentage(baselineAttended, baselineFacts.length),
    };
    const recent = {
      attendedWeeks: recentAttended,
      opportunityWeeks: recentFacts.length,
      rate: percentage(recentAttended, recentFacts.length),
    };
    candidates.push({
      individualId: profile.individualId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      familyId: profile.familyId,
      tierChange,
      sortPercentagePointChange: percentagePointChange,
      baselineTier,
      recentTier,
      baseline,
      recent,
      summary: direction === 'increase'
        ? `Previously attended ${baseline.attendedWeeks} of ${baseline.opportunityWeeks} weeks; attended ${recent.attendedWeeks} of the last ${recent.opportunityWeeks} weeks.`
        : declineSummary(baseline, recent),
    });
  }
  return candidates.sort(compareChanges);
}

function contextualSettings(settings) {
  return {
    coreMinimum: settings.coreMinimum,
    casualMinimum: settings.casualMinimum,
    tiers: Object.fromEntries(TIER_KEYS.map((tier) => [tier, { ...settings.tiers[tier] }])),
    calculationRulesVersion: settings.calculationRulesVersion,
  };
}

function buildRegularity({
  churchId,
  gatheringTypeIds,
  evidence,
  settings,
  window,
  expiresAt,
}) {
  const classified = evidence.profiles.filter(({ tier }) => tier !== null);
  return {
    population: evidence.profiles.length,
    tiers: TIER_KEYS.map((tier) => {
      const count = classified.filter((profile) => profile.tier === tier).length;
      return {
        tier,
        label: settings.tiers[tier].label,
        colour: settings.tiers[tier].colour,
        count,
        rate: percentage(count, classified.length) ?? 0,
        peopleToken: issueToken({
          churchId,
          kind: 'people',
          gatheringTypeIds,
          selector: { type: 'tier', tier },
          completedWeekEnd: window.completedWeekEnd,
          expiresAt,
        }),
      };
    }),
  };
}

function availableWeeks(source) {
  return new Set(source.sessions.filter(isReportableSession)
    .map((session) => mondayFor(session.sessionDate))).size;
}

function availableSessionRange(source) {
  const dates = source.sessions.filter(isReportableSession)
    .map((session) => session.sessionDate).sort();
  return {
    firstSessionDate: dates[0] ?? null,
    lastSessionDate: dates.at(-1) ?? null,
  };
}

async function buildState(churchId, gatheringTypeIds, { completedWeekEnd, asOf } = {}) {
  if (!churchId) throw new Error('A church ID is required to calculate contextual trends.');
  const ids = canonicalGatheringIds(gatheringTypeIds);
  const gatherings = await loadSelectedGatherings(churchId, ids);
  let window;
  if (completedWeekEnd) {
    window = windowForCompletedWeek(completedWeekEnd);
  } else {
    const timeZone = await loadChurchTimeZone(churchId);
    window = getContextualWindow(asOf ?? new Date(), timeZone);
  }
  const [rawSettings, source] = await Promise.all([
    getEngagementSettings(churchId),
    loadContextualSource(churchId, ids, window),
  ]);
  const settings = contextualSettings(rawSettings);
  const evidence = buildEvidence(source, settings);
  const declineCandidates = buildChangeCandidates(evidence, settings, 'decline');
  const increaseCandidates = buildChangeCandidates(evidence, settings, 'increase');
  return {
    churchId,
    gatheringTypeIds: ids,
    gatherings,
    window,
    settings,
    source,
    evidence,
    declineCandidates,
    increaseCandidates,
  };
}

async function buildContextualLongTermOverview(churchId, gatheringTypeIds, options = {}) {
  const state = await buildState(churchId, gatheringTypeIds, { asOf: options.asOf });
  const expiresAt = tokenExpiry(options.expiresAt);
  const standardGatherings = state.gatherings.filter(
    (gathering) => gathering.attendanceType === 'standard' && gathering.isActive,
  );
  const headcountGatherings = state.gatherings.filter(
    (gathering) => gathering.attendanceType === 'headcount',
  );
  const hasStandard = standardGatherings.length > 0;
  const regularity = hasStandard ? buildRegularity({
    churchId,
    gatheringTypeIds: state.gatheringTypeIds,
    evidence: state.evidence,
    settings: state.settings,
    window: state.window,
    expiresAt,
  }) : null;
  const declines = hasStandard ? {
    total: state.declineCandidates.length,
    rows: state.declineCandidates.slice(0, PREVIEW_LIMIT).map(publicAttendanceChange),
    peopleToken: issueToken({
      churchId,
      kind: 'people',
      gatheringTypeIds: state.gatheringTypeIds,
      selector: { type: 'decline' },
      completedWeekEnd: state.window.completedWeekEnd,
      expiresAt,
    }),
  } : null;

  const increases = hasStandard ? {
    total: state.increaseCandidates.length,
    rows: state.increaseCandidates.slice(0, PREVIEW_LIMIT).map(publicAttendanceChange),
    peopleToken: issueToken({
      churchId,
      kind: 'people',
      gatheringTypeIds: state.gatheringTypeIds,
      selector: { type: 'increase' },
      completedWeekEnd: state.window.completedWeekEnd,
      expiresAt,
    }),
  } : null;

  return {
    schemaVersion: 4,
    churchId,
    gatheringTypeIds: state.gatheringTypeIds,
    window: state.window,
    settings: state.settings,
    dataAvailability: {
      availableWeeks: availableWeeks(state.source),
      ...availableSessionRange(state.source),
      validOpportunityWeeks: state.evidence.validWeeks.length,
      excludedWeeks: state.evidence.excludedWeeks.length,
      unclassifiedBecauseNoEvidence: state.evidence.profiles.filter(
        ({ opportunityWeeks }) => opportunityWeeks === 0,
      ).length,
      standardGatherings: standardGatherings.length,
      headcountGatherings: headcountGatherings.length,
    },
    direction: buildDirection({
      churchId,
      gatheringTypeIds: state.gatheringTypeIds,
      gatherings: state.gatherings,
      source: state.source,
      window: state.window,
      expiresAt,
    }),
    regularity,
    declines,
    increases,
  };
}

function boundedLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    const error = new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
    error.code = 'INVALID_ENGAGEMENT_LIMIT';
    throw error;
  }
  return parsed;
}

function sameSelection(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function readContextualToken(token, { churchId, kind }) {
  const payload = readDrilldownToken(token, { churchId, kind });
  try {
    const ids = canonicalGatheringIds(payload.gatheringTypeIds);
    if (!sameSelection(ids, payload.gatheringTypeIds)
        || !sameSelection(ids, payload.selector?.gatheringTypeIds)) {
      throw new Error('selection binding failed');
    }
    return { ...payload, gatheringTypeIds: ids };
  } catch (_) {
    throw new DrilldownTokenError();
  }
}

function selectorEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function tierRow(profile) {
  return {
    rowType: 'contextual_regularity',
    individualId: profile.individualId,
    firstName: profile.firstName,
    lastName: profile.lastName,
    familyId: profile.familyId,
    tier: profile.tier,
    rate: percentage(profile.attendedWeeks, profile.opportunityWeeks),
    evidence: {
      attendedWeeks: profile.attendedWeeks,
      opportunityWeeks: profile.opportunityWeeks,
    },
  };
}

function declineRow(candidate) {
  return { rowType: 'contextual_decline', ...publicAttendanceChange(candidate) };
}

function tierSortKey(profile) {
  return {
    sortLast: String(profile.lastName || '').toLocaleLowerCase('en'),
    sortFirst: String(profile.firstName || '').toLocaleLowerCase('en'),
    individualId: profile.individualId,
  };
}

function changeSortKey(candidate) {
  return {
    // Retain cursor keys so existing decline tokens keep working.
    tierDrop: candidate.tierChange,
    percentagePointDrop: candidate.sortPercentagePointChange,
    sortLast: String(candidate.lastName || '').toLocaleLowerCase('en'),
    sortFirst: String(candidate.firstName || '').toLocaleLowerCase('en'),
    individualId: candidate.individualId,
  };
}

function compareTierKey(left, right) {
  return left.sortLast.localeCompare(right.sortLast, 'en')
    || left.sortFirst.localeCompare(right.sortFirst, 'en')
    || left.individualId - right.individualId;
}

function compareChangeKey(left, right) {
  return right.tierDrop - left.tierDrop
    || right.percentagePointDrop - left.percentagePointDrop
    || left.sortLast.localeCompare(right.sortLast, 'en')
    || left.sortFirst.localeCompare(right.sortFirst, 'en')
    || left.individualId - right.individualId;
}

function afterKey(value, after, comparison) {
  return comparison(value, after) > 0;
}

function validPeopleSelector(selector) {
  return selector?.type === 'decline'
    || selector?.type === 'increase'
    || (selector?.type === 'tier' && TIER_KEYS.includes(selector.tier));
}

async function listContextualPeople(churchId, { segment, cursor, limit } = {}) {
  const pageSize = boundedLimit(limit);
  const segmentPayload = readContextualToken(segment, { churchId, kind: 'people' });
  const selector = segmentPayload.selector;
  if (!validPeopleSelector(selector)) throw new DrilldownTokenError();
  const state = await buildState(churchId, segmentPayload.gatheringTypeIds, {
    completedWeekEnd: segmentPayload.completedWeekEnd,
  });
  let values;
  let keyFor;
  let compare;
  let publicRow;
  if (selector.type === 'tier') {
    values = state.evidence.profiles.filter(({ tier }) => tier === selector.tier)
      .sort(compareNames);
    keyFor = tierSortKey;
    compare = compareTierKey;
    publicRow = tierRow;
  } else {
    values = selector.type === 'increase' ? [...state.increaseCandidates] : [...state.declineCandidates];
    keyFor = changeSortKey;
    compare = compareChangeKey;
    publicRow = selector.type === 'increase'
      ? (candidate) => ({ rowType: 'contextual_increase', ...publicAttendanceChange(candidate) })
      : declineRow;
  }

  if (cursor) {
    const cursorPayload = readContextualToken(cursor, { churchId, kind: 'people_cursor' });
    if (cursorPayload.completedWeekEnd !== segmentPayload.completedWeekEnd
        || !sameSelection(cursorPayload.gatheringTypeIds, segmentPayload.gatheringTypeIds)
        || !selectorEquals(cursorPayload.selector.sourceSelector, selector)) {
      throw new DrilldownTokenError();
    }
    values = values.filter((value) => afterKey(keyFor(value), cursorPayload.selector.after, compare));
  }

  const page = values.slice(0, pageSize);
  const hasMore = values.length > pageSize;
  const last = page.at(-1);
  return {
    rows: page.map(publicRow),
    nextCursor: hasMore ? issueToken({
      churchId,
      kind: 'people_cursor',
      gatheringTypeIds: segmentPayload.gatheringTypeIds,
      selector: { sourceSelector: selector, after: keyFor(last) },
      completedWeekEnd: segmentPayload.completedWeekEnd,
      expiresAt: segmentPayload.expiresAt,
    }) : null,
  };
}

function validSessionSelector(selector, gatheringTypeIds) {
  return selector?.type === 'gathering_series'
    && gatheringTypeIds.includes(Number(selector.gatheringTypeId))
    && Number.isInteger(selector.bucketIndex)
    && selector.bucketIndex >= 0
    && selector.bucketIndex < 13;
}

function compareSessions(left, right) {
  return right.sessionDate.localeCompare(left.sessionDate) || Number(right.id) - Number(left.id);
}

function sessionRow(session, gathering, fact) {
  return {
    rowType: 'attendance_session',
    sessionId: Number(session.id),
    sessionDate: session.sessionDate,
    gatheringTypeId: Number(session.gatheringTypeId),
    gatheringName: gathering.name,
    attendanceType: session.attendanceType,
    attendance: fact.attendance,
    uniquePeople: session.attendanceType === 'standard' ? fact.people.size : null,
    provenance: session.attendanceType === 'standard'
      ? provenanceFor(session)
      : 'not_applicable',
  };
}

async function listContextualSessions(churchId, { series, cursor, limit } = {}) {
  const pageSize = boundedLimit(limit);
  const seriesPayload = readContextualToken(series, { churchId, kind: 'sessions' });
  const selector = seriesPayload.selector;
  if (!validSessionSelector(selector, seriesPayload.gatheringTypeIds)) {
    throw new DrilldownTokenError();
  }
  const state = await buildState(churchId, seriesPayload.gatheringTypeIds, {
    completedWeekEnd: seriesPayload.completedWeekEnd,
  });
  const startDate = addDateOnly(state.window.startDate, { days: selector.bucketIndex * 28 });
  const endDate = addDateOnly(startDate, { days: 27 });
  let sessions = state.source.sessions.filter((session) => isReportableSession(session)
    && Number(session.gatheringTypeId) === Number(selector.gatheringTypeId)
    && session.sessionDate >= startDate
    && session.sessionDate <= endDate)
    .sort(compareSessions);

  if (cursor) {
    const cursorPayload = readContextualToken(cursor, { churchId, kind: 'sessions_cursor' });
    if (cursorPayload.completedWeekEnd !== seriesPayload.completedWeekEnd
        || !sameSelection(cursorPayload.gatheringTypeIds, seriesPayload.gatheringTypeIds)
        || !selectorEquals(cursorPayload.selector.sourceSelector, selector)) {
      throw new DrilldownTokenError();
    }
    const after = cursorPayload.selector.after;
    sessions = sessions.filter((session) => session.sessionDate < after.sessionDate
      || (session.sessionDate === after.sessionDate && Number(session.id) < after.sessionId));
  }

  const page = sessions.slice(0, pageSize);
  const hasMore = sessions.length > pageSize;
  const last = page.at(-1);
  const facts = buildSessionFacts(state.source);
  const gathering = state.gatherings.find(({ id }) => id === Number(selector.gatheringTypeId));
  return {
    rows: page.map((session) => sessionRow(session, gathering, facts.get(Number(session.id)))),
    nextCursor: hasMore ? issueToken({
      churchId,
      kind: 'sessions_cursor',
      gatheringTypeIds: seriesPayload.gatheringTypeIds,
      selector: {
        sourceSelector: selector,
        after: { sessionDate: last.sessionDate, sessionId: Number(last.id) },
      },
      completedWeekEnd: seriesPayload.completedWeekEnd,
      expiresAt: seriesPayload.expiresAt,
    }) : null,
  };
}

module.exports = {
  MAX_LIMIT,
  InvalidReportGatheringError,
  canonicalGatheringIds,
  getContextualWindow,
  buildContextualLongTermOverview,
  listContextualPeople,
  listContextualSessions,
};
