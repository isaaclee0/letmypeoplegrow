'use strict';

const Database = require('../../config/database');
const { addDateOnly, loadChurchTimeZone } = require('../../utils/churchTime');
const { getEngagementSettings } = require('./settings');
const {
  getEngagementWindow,
  buildOpportunityProfiles,
} = require('./opportunities');
const {
  DrilldownTokenError,
  createDrilldownToken,
  readDrilldownToken,
} = require('./drilldownTokens');

const TIER_KEYS = Object.freeze(['core', 'casual', 'irregular']);
const CLASSIFIED = new Set(TIER_KEYS);
const ENGAGEMENT_AXES = Object.freeze(['primary', 'community']);
const TREND_ROLES = Object.freeze(['primary', 'community', 'other', 'unclassified']);
const RECENT_TRANSITION_WEEKS = 13;
const RECENT_TRANSITION_DAYS = 84;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function tokenExpiry(expiresAt) {
  if (expiresAt) return expiresAt;
  return new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();
}

function issueToken(churchId, kind, selector, completedWeekEnd, expiresAt) {
  return createDrilldownToken({
    churchId,
    kind,
    selector,
    completedWeekEnd,
    expiresAt,
  });
}

function classified(status) {
  return CLASSIFIED.has(status);
}

function countProfiles(profiles, predicate) {
  let count = 0;
  for (const profile of profiles.values()) {
    if (predicate(profile)) count += 1;
  }
  return count;
}

function summarizeEngagementProfiles({
  churchId,
  current,
  tierStates = [],
  recentTransitions = [],
  coverage,
  window,
  settings,
  expiresAt: requestedExpiry,
}) {
  const expiresAt = tokenExpiry(requestedExpiry);
  const peopleToken = (selector) => issueToken(
    churchId,
    'people',
    selector,
    window.completedWeekEnd,
    expiresAt,
  );
  const sessionsToken = (selector) => issueToken(
    churchId,
    'sessions',
    selector,
    window.completedWeekEnd,
    expiresAt,
  );
  const population = current.size;
  const classifiedPrimary = countProfiles(current, (profile) => classified(profile.primary.status));
  const establishingPrimary = countProfiles(current, (profile) => profile.primary.status === 'establishing');
  const notAssignedPrimary = countProfiles(current, (profile) => profile.primary.status === 'not_assigned');

  const tiers = TIER_KEYS.map((tier) => {
    const count = countProfiles(current, (profile) => profile.primary.status === tier);
    return {
      tier,
      label: settings.tiers[tier].label,
      colour: settings.tiers[tier].colour,
      count,
      rate: rate(count, classifiedPrimary),
      peopleToken: peopleToken({ type: 'primary_status', status: tier }),
    };
  });

  const currentIds = new Set(current.keys());
  const movementAxes = Object.fromEntries(ENGAGEMENT_AXES.map((axis) => {
    const activeStates = tierStates.filter((state) => state.axis === axis
      && currentIds.has(state.individualId));
    const confirmation = (direction) => ({
      count: activeStates.filter((state) => state.candidateDirection === direction).length,
      peopleToken: peopleToken({ type: 'confirmation', axis, direction }),
    });
    return [axis, {
      confirmingHigher: confirmation('higher'),
      confirmingLower: confirmation('lower'),
      confirmedRecently: {
        count: recentTransitions.filter((transition) => transition.axis === axis
          && currentIds.has(transition.individualId)).length,
        peopleToken: peopleToken({
          type: 'transition', axis, recentWeeks: RECENT_TRANSITION_WEEKS,
        }),
      },
    }];
  }));
  const pendingAxes = [...current.values()].reduce(
    (count, profile) => count + ENGAGEMENT_AXES.filter(
      (axis) => profile[axis].statusSource === 'calculated_fallback',
    ).length,
    0,
  );

  const matrixCells = [];
  let classifiedOnBothAxes = 0;
  for (const primaryTier of TIER_KEYS) {
    for (const communityTier of TIER_KEYS) {
      const count = countProfiles(current, (profile) => profile.primary.status === primaryTier
        && profile.community.status === communityTier);
      classifiedOnBothAxes += count;
      matrixCells.push({
        primaryTier,
        communityTier,
        primaryLabel: settings.tiers[primaryTier].label,
        communityLabel: settings.tiers[communityTier].label,
        count,
        peopleToken: peopleToken({ type: 'matrix', primaryTier, communityTier }),
      });
    }
  }

  const eligibleSessions = coverage.eligibleHeldSessions || 0;
  const unknownSessions = coverage.excludedUnknownProvenanceSessions || 0;
  const personSessionDenominator = eligibleSessions + unknownSessions;

  return {
    population: { activeRegulars: population },
    baseline: { pending: pendingAxes > 0, pendingAxes },
    primaryDistribution: {
      classified: { denominator: classifiedPrimary, tiers },
      establishing: {
        count: establishingPrimary,
        peopleToken: peopleToken({ type: 'primary_status', status: 'establishing' }),
      },
      notAssigned: {
        count: notAssignedPrimary,
        peopleToken: peopleToken({ type: 'primary_status', status: 'not_assigned' }),
      },
    },
    tierMovement: {
      recentWindowWeeks: RECENT_TRANSITION_WEEKS,
      axes: movementAxes,
    },
    matrix: {
      classifiedOnBothAxes,
      cells: matrixCells,
      outside: {
        primaryEstablishing: establishingPrimary,
        primaryNotAssigned: notAssignedPrimary,
        communityEstablishing: countProfiles(
          current,
          (profile) => profile.community.status === 'establishing',
        ),
        communityNotAssigned: countProfiles(
          current,
          (profile) => profile.community.status === 'not_assigned',
        ),
        notClassifiedOnBothAxes: population - classifiedOnBothAxes,
      },
    },
    coverage: {
      personLevelSessions: {
        numerator: eligibleSessions,
        denominator: personSessionDenominator,
        rate: rate(eligibleSessions, personSessionDenominator),
        excluded: unknownSessions,
      },
      explicitProvenance: {
        numerator: coverage.explicitProvenanceSessions || 0,
        denominator: eligibleSessions,
        rate: rate(coverage.explicitProvenanceSessions || 0, eligibleSessions),
      },
      legacyProvenance: {
        numerator: coverage.legacyProvenanceSessions || 0,
        denominator: eligibleSessions,
        rate: rate(coverage.legacyProvenanceSessions || 0, eligibleSessions),
      },
      establishing: {
        numerator: establishingPrimary,
        denominator: population,
        rate: rate(establishingPrimary, population),
      },
      primaryNotAssigned: {
        numerator: notAssignedPrimary,
        denominator: population,
        rate: rate(notAssignedPrimary, population),
      },
      sessionsTokens: {
        eligible: sessionsToken({ type: 'coverage', category: 'eligible' }),
        explicit: sessionsToken({ type: 'coverage', category: 'explicit' }),
        legacy: sessionsToken({ type: 'coverage', category: 'legacy' }),
        excludedUnknown: sessionsToken({ type: 'coverage', category: 'unknown' }),
      },
    },
  };
}

function normalizedRole(role) {
  return TREND_ROLES.includes(role) ? role : 'unclassified';
}

function provenanceForSession(session) {
  if (Number(session.rosterProvenanceVersion) >= 1) return 'explicit';
  if (Number(session.rosterProvenanceVersion) === 0
      && Number(session.rosterSnapshotted) === 1) return 'legacy';
  return 'unknown';
}

function includedTrendSession(session, window) {
  return session.sessionStatus === 'held'
    && Number(session.excludedFromStats) !== 1
    && session.sessionDate >= window.currentStart
    && session.sessionDate <= window.currentEnd;
}

function includedPersonSession(session, window) {
  return includedTrendSession(session, window)
    && session.attendanceType === 'standard'
    && (session.engagementRole === 'primary' || session.engagementRole === 'community');
}

function sessionAttendanceFacts(source) {
  const presentBySession = new Map();
  for (const record of source.records) {
    if (Number(record.present) !== 1) continue;
    const present = presentBySession.get(record.sessionId) || new Set();
    present.add(record.individualId);
    presentBySession.set(record.sessionId, present);
  }
  const headcountsBySession = new Map();
  for (const row of source.headcounts) {
    const values = headcountsBySession.get(row.sessionId) || [];
    values.push(Number(row.headcount));
    headcountsBySession.set(row.sessionId, values);
  }

  const facts = new Map();
  for (const session of source.sessions) {
    if (session.attendanceType === 'standard') {
      const people = presentBySession.get(session.id) || new Set();
      facts.set(session.id, { attendance: people.size, people });
      continue;
    }
    const values = headcountsBySession.get(session.id) || [];
    let attendance = 0;
    if (session.headcountMode === 'combined') {
      attendance = values.reduce((sum, value) => sum + value, 0);
    } else if (session.headcountMode === 'averaged') {
      attendance = values.length === 0
        ? 0
        : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    } else {
      attendance = values.length === 0 ? 0 : Math.max(...values);
    }
    facts.set(session.id, { attendance, people: null });
  }
  return facts;
}

function buildTrend({ churchId, source, window, expiresAt }) {
  const facts = sessionAttendanceFacts(source);
  const buckets = [];
  for (let index = 0; index < 13; index += 1) {
    const startDate = addDateOnly(window.currentStart, { days: index * 28 });
    const endDate = addDateOnly(startDate, { days: 27 });
    const bucketSessions = source.sessions.filter((session) => includedTrendSession(session, window)
      && session.sessionDate >= startDate && session.sessionDate <= endDate);
    const series = [];
    for (const role of TREND_ROLES) {
      for (const attendanceType of ['standard', 'headcount']) {
        const sessions = bucketSessions.filter((session) => normalizedRole(session.engagementRole) === role
          && session.attendanceType === attendanceType);
        if (sessions.length === 0) continue;
        const totalAttendance = sessions.reduce(
          (sum, session) => sum + facts.get(session.id).attendance,
          0,
        );
        let uniquePeople = null;
        if (attendanceType === 'standard') {
          const ids = new Set();
          for (const session of sessions) {
            for (const id of facts.get(session.id).people) ids.add(id);
          }
          uniquePeople = ids.size;
        }
        const selector = { type: 'trend', bucketIndex: index, role, attendanceType };
        series.push({
          role,
          attendanceType,
          heldSessions: sessions.length,
          totalAttendance,
          averageAttendance: totalAttendance / sessions.length,
          uniquePeople,
          sessionsToken: issueToken(
            churchId, 'sessions', selector, window.completedWeekEnd, expiresAt,
          ),
          peopleToken: attendanceType === 'standard'
            ? issueToken(
              churchId,
              'people',
              { ...selector, type: 'trend_attendees' },
              window.completedWeekEnd,
              expiresAt,
            )
            : null,
        });
      }
    }
    buckets.push({ index, startDate, endDate, series });
  }
  return { buckets };
}

function visitorCohorts(visitorRows, window) {
  const byPerson = new Map();
  for (const row of visitorRows) {
    const person = byPerson.get(row.individualId) || {
      individualId: row.individualId,
      firstName: row.firstName,
      lastName: row.lastName,
      familyId: row.familyId ?? null,
      currentPeopleType: row.currentPeopleType,
      attendances: [],
    };
    person.attendances.push({
      sessionId: row.sessionId,
      sessionDate: row.sessionDate,
      peopleTypeAtTime: row.peopleTypeAtTime,
    });
    byPerson.set(row.individualId, person);
  }

  const local = [];
  const traveller = [];
  for (const person of byPerson.values()) {
    person.attendances.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate)
      || left.sessionId - right.sessionId);
    const first = person.attendances[0];
    if (!first || first.sessionDate < window.currentStart || first.sessionDate > window.currentEnd) continue;
    const visitorType = first.peopleTypeAtTime;
    if (visitorType !== 'local_visitor' && visitorType !== 'traveller_visitor') continue;
    const returnDeadline = addDateOnly(first.sessionDate, { days: 56 });
    const returnedWithinEightWeeks = person.attendances.some((attendance, index) => index > 0
      && attendance.sessionDate > first.sessionDate
      && attendance.sessionDate <= returnDeadline);
    const fact = {
      ...person,
      firstAttendanceDate: first.sessionDate,
      returnedWithinEightWeeks,
      isCurrentRegular: person.currentPeopleType === 'regular',
    };
    delete fact.attendances;
    (visitorType === 'local_visitor' ? local : traveller).push(fact);
  }
  return { local, traveller };
}

function buildVisitorJourney({ churchId, cohorts, window, expiresAt }) {
  const stage = (visitorType, stageName, predicate) => {
    const count = cohorts[visitorType].filter(predicate).length;
    return {
      count,
      peopleToken: issueToken(
        churchId,
        'people',
        { type: 'visitor_journey', visitorType, stage: stageName },
        window.completedWeekEnd,
        expiresAt,
      ),
    };
  };
  return {
    local: {
      firstTime: stage('local', 'first_time', () => true),
      returnedWithinEightWeeks: stage(
        'local', 'returned_within_eight_weeks', (person) => person.returnedWithinEightWeeks,
      ),
      currentRegular: stage(
        'local', 'current_regular', (person) => person.isCurrentRegular,
      ),
      conversionDateKnown: false,
    },
    traveller: {
      firstTime: stage('traveller', 'first_time', () => true),
    },
  };
}

async function loadOverviewSource(churchId, window) {
  const query = (sql, params) => Database.queryForChurch(churchId, sql, params);
  const [gatherings, people, assignments, sessions, records, headcounts, visitorRows] = await Promise.all([
    query(
      `SELECT id, attendance_type AS attendanceType, engagement_role AS engagementRole,
              is_active AS isActive
       FROM gathering_types
       WHERE church_id = ?
       ORDER BY id`,
      [churchId],
    ),
    query(
      `SELECT id, id AS individualId, first_name AS firstName, last_name AS lastName,
              family_id AS familyId, people_type AS peopleType,
              people_type AS currentPeopleType,
              is_active AS isActive
       FROM individuals
       WHERE church_id = ?
       ORDER BY id`,
      [churchId],
    ),
    query(
      `SELECT DISTINCT
              gl.individual_id AS individualId,
              gl.gathering_type_id AS gatheringTypeId,
              gt.engagement_role AS role
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
        AND gt.engagement_role IN ('primary', 'community')
       WHERE gl.church_id = ?
       ORDER BY gl.individual_id, gl.gathering_type_id`,
      [churchId, churchId, churchId],
    ),
    query(
      `SELECT s.id, s.gathering_type_id AS gatheringTypeId,
              gt.name AS gatheringName, s.session_date AS sessionDate,
              s.session_status AS sessionStatus,
              s.excluded_from_stats AS excludedFromStats,
              s.roster_snapshotted AS rosterSnapshotted,
              s.roster_provenance_version AS rosterProvenanceVersion,
              s.headcount_mode AS headcountMode,
              gt.attendance_type AS attendanceType,
              gt.engagement_role AS engagementRole,
              gt.is_active AS gatheringIsActive
       FROM attendance_sessions s
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.church_id = ?
       WHERE s.church_id = ?
         AND s.session_date >= ? AND s.session_date <= ?
       ORDER BY s.session_date, s.id`,
      [churchId, churchId, window.sourceStart, window.sourceEnd],
    ),
    query(
      `SELECT ar.session_id AS sessionId, ar.individual_id AS individualId, ar.present,
              ar.eligible_at_snapshot AS eligibleAtSnapshot,
              ar.people_type_at_time AS peopleTypeAtTime
       FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id AND s.church_id = ?
       WHERE ar.church_id = ?
         AND s.session_date >= ? AND s.session_date <= ?
       ORDER BY ar.session_id, ar.individual_id`,
      [churchId, churchId, window.sourceStart, window.sourceEnd],
    ),
    query(
      `SELECT hr.session_id AS sessionId, hr.headcount
       FROM headcount_records hr
       JOIN attendance_sessions s ON s.id = hr.session_id AND s.church_id = ?
       WHERE hr.church_id = ?
         AND s.session_date >= ? AND s.session_date <= ?
       ORDER BY hr.session_id, hr.id`,
      [churchId, churchId, window.sourceStart, window.sourceEnd],
    ),
    query(
      `SELECT ar.individual_id AS individualId, ar.session_id AS sessionId,
              s.session_date AS sessionDate,
              ar.people_type_at_time AS peopleTypeAtTime,
              i.first_name AS firstName, i.last_name AS lastName,
              i.family_id AS familyId, i.people_type AS currentPeopleType
       FROM attendance_records ar
       JOIN attendance_sessions s
         ON s.id = ar.session_id AND s.church_id = ?
       JOIN gathering_types gt
         ON gt.id = s.gathering_type_id AND gt.church_id = ?
       JOIN individuals i
         ON i.id = ar.individual_id AND i.church_id = ?
       WHERE ar.church_id = ?
         AND ar.present = 1
         AND s.session_status = 'held'
         AND s.excluded_from_stats = 0
         AND gt.attendance_type = 'standard'
         AND s.session_date <= ?
       ORDER BY ar.individual_id, s.session_date, ar.session_id`,
      [churchId, churchId, churchId, churchId, window.currentEnd],
    ),
  ]);
  return { gatherings, people, assignments, sessions, records, headcounts, visitorRows };
}

async function loadTierActivity(churchId, rulesVersion, completedWeekEnd) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT 'state' AS rowKind,
            NULL AS activityId,
            individual_id AS individualId,
            axis,
            rules_version AS rulesVersion,
            established_tier AS establishedTier,
            candidate_tier AS candidateTier,
            candidate_direction AS candidateDirection,
            candidate_started_week_end AS candidateStartedWeekEnd,
            candidate_final_week_end AS candidateFinalWeekEnd,
            last_evaluated_week_end AS lastEvaluatedWeekEnd,
            NULL AS fromTier,
            NULL AS toTier,
            NULL AS confirmedWeekEnd,
            NULL AS longTermAttended,
            NULL AS longTermOpportunities,
            NULL AS longTermRate,
            NULL AS confirmationAttended,
            NULL AS confirmationOpportunities,
            NULL AS confirmationRate
     FROM engagement_tier_state
     WHERE church_id = ?
       AND rules_version = ?
     UNION ALL
     SELECT 'transition' AS rowKind,
            id AS activityId,
            individual_id AS individualId,
            axis,
            rules_version AS rulesVersion,
            NULL AS establishedTier,
            NULL AS candidateTier,
            NULL AS candidateDirection,
            candidate_started_week_end AS candidateStartedWeekEnd,
            NULL AS candidateFinalWeekEnd,
            NULL AS lastEvaluatedWeekEnd,
            from_tier AS fromTier,
            to_tier AS toTier,
            confirmed_week_end AS confirmedWeekEnd,
            long_term_attended AS longTermAttended,
            long_term_opportunities AS longTermOpportunities,
            long_term_rate AS longTermRate,
            confirmation_attended AS confirmationAttended,
            confirmation_opportunities AS confirmationOpportunities,
            confirmation_rate AS confirmationRate
     FROM engagement_tier_transitions
     WHERE church_id = ?
       AND rules_version = ?
       AND confirmed_week_end >= ?
       AND confirmed_week_end <= ?
     ORDER BY individualId, axis, rowKind, confirmedWeekEnd, activityId`,
    [
      churchId,
      rulesVersion,
      churchId,
      rulesVersion,
      addDateOnly(completedWeekEnd, { days: -RECENT_TRANSITION_DAYS }),
      completedWeekEnd,
    ],
  );
  return {
    tierStates: rows.filter((row) => row.rowKind === 'state'),
    recentTransitions: rows.filter((row) => row.rowKind === 'transition'),
  };
}

function tierStateKey(individualId, axis) {
  return `${individualId}:${axis}`;
}

function buildEstablishedProfiles(calculatedProfiles, tierStates) {
  const stateByKey = new Map(tierStates.map(
    (state) => [tierStateKey(state.individualId, state.axis), state],
  ));
  const establishedProfiles = new Map();
  for (const [individualId, calculated] of calculatedProfiles) {
    const profile = { ...calculated };
    for (const axis of ENGAGEMENT_AXES) {
      const state = stateByKey.get(tierStateKey(individualId, axis));
      profile[axis] = {
        ...calculated[axis],
        status: state && classified(state.establishedTier)
          ? state.establishedTier
          : calculated[axis].status,
        statusSource: state ? 'established' : 'calculated_fallback',
      };
    }
    establishedProfiles.set(individualId, profile);
  }
  return establishedProfiles;
}

function groupDatedOpportunities(datedOpportunities) {
  const grouped = { primary: new Map(), community: new Map() };
  for (const axis of ENGAGEMENT_AXES) {
    for (const opportunity of datedOpportunities[axis] || []) {
      const facts = grouped[axis].get(opportunity.individualId) || [];
      facts.push(opportunity);
      grouped[axis].set(opportunity.individualId, facts);
    }
  }
  return grouped;
}

async function buildState(churchId, options = {}) {
  if (!churchId) throw new Error('A church ID is required to build an engagement overview.');
  const [timeZone, settings] = await Promise.all([
    loadChurchTimeZone(churchId),
    getEngagementSettings(churchId),
  ]);
  let asOf = options.asOf ?? new Date();
  if (options.completedWeekEnd) {
    asOf = `${addDateOnly(options.completedWeekEnd, { days: 1 })}T12:00:00.000Z`;
  }
  const window = getEngagementWindow(asOf, timeZone);
  if (options.completedWeekEnd && window.completedWeekEnd !== options.completedWeekEnd) {
    throw new DrilldownTokenError();
  }
  const [overviewSource, tierActivity] = await Promise.all([
    loadOverviewSource(churchId, window),
    loadTierActivity(churchId, settings.calculationRulesVersion, window.completedWeekEnd),
  ]);
  const opportunitySource = {
    people: overviewSource.people,
    assignments: overviewSource.assignments,
    sessions: overviewSource.sessions,
    records: overviewSource.records,
    headcounts: overviewSource.headcounts,
  };
  const profiles = buildOpportunityProfiles(opportunitySource, settings, window);
  const establishedProfiles = buildEstablishedProfiles(
    profiles.current,
    tierActivity.tierStates,
  );
  const datedOpportunities = groupDatedOpportunities(profiles.datedOpportunities);
  const cohorts = visitorCohorts(overviewSource.visitorRows, window);
  return {
    window,
    settings,
    profiles,
    establishedProfiles,
    datedOpportunities,
    tierStates: tierActivity.tierStates,
    recentTransitions: tierActivity.recentTransitions,
    overviewSource,
    cohorts,
  };
}

async function buildEngagementOverview(churchId, options = {}) {
  const state = await buildState(churchId, options);
  const expiresAt = tokenExpiry();
  const profileSummary = summarizeEngagementProfiles({
    churchId,
    current: state.establishedProfiles,
    tierStates: state.tierStates,
    recentTransitions: state.recentTransitions,
    coverage: state.profiles.coverage,
    window: state.window,
    settings: state.settings,
    expiresAt,
  });
  const activePrimary = state.overviewSource.gatherings.filter((gathering) => Number(gathering.isActive) === 1
    && gathering.engagementRole === 'primary');
  return {
    schemaVersion: 2,
    churchId,
    window: state.window,
    settings: state.settings,
    setup: {
      hasPrimaryRole: activePrimary.length > 0,
      hasStandardPrimaryRole: activePrimary.some(
        (gathering) => gathering.attendanceType === 'standard',
      ),
      hasPrimaryAssignments: profileSummary.primaryDistribution.notAssigned.count
        < profileSummary.population.activeRegulars,
    },
    ...profileSummary,
    trend: buildTrend({
      churchId,
      source: state.overviewSource,
      window: state.window,
      expiresAt,
    }),
    visitorJourney: buildVisitorJourney({
      churchId,
      cohorts: state.cohorts,
      window: state.window,
      expiresAt,
    }),
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

function selectorEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function personSortKey(person) {
  const sortDetail = person.sortDetail ?? (person.rowType === 'engagement_transition'
    ? `${person.confirmedWeekEnd}:${person.fromTier}:${person.toTier}`
    : '');
  return {
    sortLast: String(person.lastName || '').toLocaleLowerCase('en'),
    sortFirst: String(person.firstName || '').toLocaleLowerCase('en'),
    individualId: Number(person.individualId),
    sortDetail,
  };
}

function comparePerson(left, right) {
  const leftKey = personSortKey(left);
  const rightKey = personSortKey(right);
  return leftKey.sortLast.localeCompare(rightKey.sortLast, 'en')
    || leftKey.sortFirst.localeCompare(rightKey.sortFirst, 'en')
    || leftKey.individualId - rightKey.individualId
    || leftKey.sortDetail.localeCompare(rightKey.sortDetail, 'en');
}

function afterPerson(person, after) {
  return comparePerson(person, {
    individualId: after.individualId,
    firstName: after.sortFirst,
    lastName: after.sortLast,
    sortDetail: after.sortDetail,
  }) > 0;
}

function engagementRows(state, selector) {
  if (selector.type !== 'primary_status' && selector.type !== 'matrix') {
    throw new DrilldownTokenError();
  }
  const rows = [];
  for (const profile of state.establishedProfiles.values()) {
    let include = false;
    if (selector.type === 'primary_status') include = profile.primary.status === selector.status;
    else if (selector.type === 'matrix') {
      include = profile.primary.status === selector.primaryTier
        && profile.community.status === selector.communityTier;
    }
    if (include) {
      rows.push({
        rowType: 'engagement_profile',
        ...profile,
      });
    }
  }
  return rows;
}

function validConfirmationSelector(selector) {
  return selector?.type === 'confirmation'
    && ENGAGEMENT_AXES.includes(selector.axis)
    && (selector.direction === 'higher' || selector.direction === 'lower');
}

function confirmationRows(state, selector) {
  if (!validConfirmationSelector(selector)) throw new DrilldownTokenError();
  const rows = [];
  for (const tierState of state.tierStates) {
    if (tierState.axis !== selector.axis
        || tierState.candidateDirection !== selector.direction
        || !tierState.candidateTier) continue;
    const profile = state.establishedProfiles.get(tierState.individualId);
    if (!profile) continue;
    const facts = (state.datedOpportunities[selector.axis].get(tierState.individualId) || [])
      .filter((fact) => fact.date > tierState.candidateStartedWeekEnd
        && fact.date <= state.window.completedWeekEnd);
    const attended = facts.filter((fact) => fact.attended).length;
    const elapsedMs = Date.parse(`${state.window.completedWeekEnd}T00:00:00.000Z`)
      - Date.parse(`${tierState.candidateStartedWeekEnd}T00:00:00.000Z`);
    const currentWeek = Math.max(0, Math.min(
      RECENT_TRANSITION_WEEKS,
      Math.floor(elapsedMs / (7 * 24 * 60 * 60 * 1000)),
    ));
    rows.push({
      rowType: 'engagement_confirmation',
      individualId: profile.individualId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      familyId: profile.familyId,
      axis: tierState.axis,
      direction: tierState.candidateDirection,
      establishedTier: tierState.establishedTier,
      candidateTier: tierState.candidateTier,
      observedOpportunities: facts.length,
      attended,
      rate: facts.length === 0 ? null : attended / facts.length,
      candidateStartedWeekEnd: tierState.candidateStartedWeekEnd,
      candidateFinalWeekEnd: tierState.candidateFinalWeekEnd,
      currentWeek,
    });
  }
  return rows;
}

function transitionRows(state, selector) {
  if (selector?.type !== 'transition'
      || !ENGAGEMENT_AXES.includes(selector.axis)
      || selector.recentWeeks !== RECENT_TRANSITION_WEEKS) {
    throw new DrilldownTokenError();
  }
  return state.recentTransitions.flatMap((transition) => {
    if (transition.axis !== selector.axis) return [];
    const profile = state.establishedProfiles.get(transition.individualId);
    if (!profile) return [];
    return [{
      rowType: 'engagement_transition',
      individualId: profile.individualId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      familyId: profile.familyId,
      axis: transition.axis,
      fromTier: transition.fromTier,
      toTier: transition.toTier,
      candidateStartedWeekEnd: transition.candidateStartedWeekEnd,
      confirmedWeekEnd: transition.confirmedWeekEnd,
      longTermEvidence: {
        attended: transition.longTermAttended,
        opportunities: transition.longTermOpportunities,
        rate: transition.longTermRate,
      },
      confirmationEvidence: {
        attended: transition.confirmationAttended,
        opportunities: transition.confirmationOpportunities,
        rate: transition.confirmationRate,
      },
    }];
  });
}

function trendAttendeeRows(state, selector) {
  const startDate = addDateOnly(state.window.currentStart, { days: selector.bucketIndex * 28 });
  const endDate = addDateOnly(startDate, { days: 27 });
  const sessionIds = new Set(state.overviewSource.sessions
    .filter((session) => includedTrendSession(session, state.window)
      && session.attendanceType === 'standard'
      && normalizedRole(session.engagementRole) === selector.role
      && session.sessionDate >= startDate && session.sessionDate <= endDate)
    .map((session) => session.id));
  const personIds = new Set(state.overviewSource.records
    .filter((record) => sessionIds.has(record.sessionId) && Number(record.present) === 1)
    .map((record) => record.individualId));
  return state.overviewSource.people.filter((person) => personIds.has(person.individualId)).map((person) => ({
    rowType: 'attendance_person',
    individualId: person.individualId,
    firstName: person.firstName,
    lastName: person.lastName,
    familyId: person.familyId ?? null,
    currentPeopleType: person.currentPeopleType,
  }));
}

function visitorRows(state, selector) {
  const cohort = state.cohorts[selector.visitorType];
  if (!cohort) throw new DrilldownTokenError();
  return cohort.filter((person) => {
    if (selector.stage === 'first_time') return true;
    if (selector.stage === 'returned_within_eight_weeks') return person.returnedWithinEightWeeks;
    if (selector.stage === 'current_regular') return person.isCurrentRegular;
    throw new DrilldownTokenError();
  }).map((person) => ({ rowType: 'visitor_journey', ...person }));
}

async function listEngagementPeople(churchId, { segment, cursor, limit } = {}) {
  const pageSize = boundedLimit(limit);
  const segmentPayload = readDrilldownToken(segment, { churchId, kind: 'people' });
  const state = await buildState(churchId, { completedWeekEnd: segmentPayload.completedWeekEnd });
  const selector = segmentPayload.selector;
  let rows;
  if (selector.type === 'primary_status' || selector.type === 'matrix') {
    rows = engagementRows(state, selector);
  } else if (selector.type === 'confirmation') {
    rows = confirmationRows(state, selector);
  } else if (selector.type === 'transition') {
    rows = transitionRows(state, selector);
  } else if (selector.type === 'trend_attendees') {
    rows = trendAttendeeRows(state, selector);
  } else if (selector.type === 'visitor_journey') {
    rows = visitorRows(state, selector);
  } else {
    throw new DrilldownTokenError();
  }
  rows.sort(comparePerson);

  if (cursor) {
    const cursorPayload = readDrilldownToken(cursor, { churchId, kind: 'people_cursor' });
    if (cursorPayload.completedWeekEnd !== segmentPayload.completedWeekEnd
        || !selectorEquals(cursorPayload.selector.sourceSelector, selector)) {
      throw new DrilldownTokenError();
    }
    rows = rows.filter((row) => afterPerson(row, cursorPayload.selector.after));
  }
  const pageRows = rows.slice(0, pageSize);
  const hasMore = rows.length > pageSize;
  const last = pageRows.at(-1);
  return {
    rows: pageRows,
    nextCursor: hasMore ? issueToken(
      churchId,
      'people_cursor',
      { sourceSelector: selector, after: personSortKey(last) },
      segmentPayload.completedWeekEnd,
      segmentPayload.expiresAt,
    ) : null,
  };
}

function selectedSessions(state, selector) {
  if (selector.type === 'trend') {
    const startDate = addDateOnly(state.window.currentStart, { days: selector.bucketIndex * 28 });
    const endDate = addDateOnly(startDate, { days: 27 });
    return state.overviewSource.sessions.filter((session) => includedTrendSession(session, state.window)
      && session.sessionDate >= startDate && session.sessionDate <= endDate
      && normalizedRole(session.engagementRole) === selector.role
      && session.attendanceType === selector.attendanceType);
  }
  if (selector.type === 'coverage') {
    return state.overviewSource.sessions.filter((session) => {
      if (!includedPersonSession(session, state.window)) return false;
      const provenance = provenanceForSession(session);
      if (selector.category === 'eligible') return provenance !== 'unknown';
      if (selector.category === 'explicit') return provenance === 'explicit';
      if (selector.category === 'legacy') return provenance === 'legacy';
      if (selector.category === 'unknown') return provenance === 'unknown';
      throw new DrilldownTokenError();
    });
  }
  throw new DrilldownTokenError();
}

function sessionRow(session, attendanceFacts) {
  return {
    rowType: 'attendance_session',
    sessionId: session.id,
    sessionDate: session.sessionDate,
    gatheringTypeId: session.gatheringTypeId,
    gatheringName: session.gatheringName,
    role: normalizedRole(session.engagementRole),
    attendanceType: session.attendanceType,
    attendance: attendanceFacts.get(session.id).attendance,
    uniquePeople: session.attendanceType === 'standard'
      ? attendanceFacts.get(session.id).people.size
      : null,
    provenance: session.attendanceType === 'standard'
      ? provenanceForSession(session)
      : 'not_applicable',
  };
}

function compareSession(left, right) {
  return right.sessionDate.localeCompare(left.sessionDate) || right.id - left.id;
}

async function listEngagementSessions(churchId, { series, cursor, limit } = {}) {
  const pageSize = boundedLimit(limit);
  const seriesPayload = readDrilldownToken(series, { churchId, kind: 'sessions' });
  const state = await buildState(churchId, { completedWeekEnd: seriesPayload.completedWeekEnd });
  const selector = seriesPayload.selector;
  let sessions = selectedSessions(state, selector).sort(compareSession);
  if (cursor) {
    const cursorPayload = readDrilldownToken(cursor, { churchId, kind: 'sessions_cursor' });
    if (cursorPayload.completedWeekEnd !== seriesPayload.completedWeekEnd
        || !selectorEquals(cursorPayload.selector.sourceSelector, selector)) {
      throw new DrilldownTokenError();
    }
    const after = cursorPayload.selector.after;
    sessions = sessions.filter((session) => session.sessionDate < after.sessionDate
      || (session.sessionDate === after.sessionDate && session.id < after.sessionId));
  }
  const pageSessions = sessions.slice(0, pageSize);
  const hasMore = sessions.length > pageSize;
  const last = pageSessions.at(-1);
  const facts = sessionAttendanceFacts(state.overviewSource);
  return {
    rows: pageSessions.map((session) => sessionRow(session, facts)),
    nextCursor: hasMore ? issueToken(
      churchId,
      'sessions_cursor',
      {
        sourceSelector: selector,
        after: { sessionDate: last.sessionDate, sessionId: last.id },
      },
      seriesPayload.completedWeekEnd,
      seriesPayload.expiresAt,
    ) : null,
  };
}

module.exports = {
  MAX_LIMIT,
  summarizeEngagementProfiles,
  engagementRows,
  buildEngagementOverview,
  listEngagementPeople,
  listEngagementSessions,
};
