'use strict';

const Database = require('../../config/database');
const { getChurchDate, getZonedParts, addDateOnly, loadChurchTimeZone } = require('../../utils/churchTime');
const { getEngagementSettings, DEFAULT_ENGAGEMENT_SETTINGS } = require('./settings');
const { MINIMUM_CLASSIFIED_OPPORTUNITIES, classifyEvidence } = require('./tiers');

const PERSON_LEVEL_ROLES = new Set(['primary', 'community']);

function getEngagementWindow(asOf = new Date(), timeZone = 'UTC') {
  const instant = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(instant.getTime())) throw new TypeError('A valid asOf instant is required.');

  const localDate = getChurchDate(instant, timeZone);
  const { weekday } = getZonedParts(instant, timeZone);
  const daysSinceMonday = (weekday + 6) % 7;
  const completedWeekEnd = addDateOnly(localDate, { days: -(daysSinceMonday + 1) });

  return {
    completedWeekEnd,
    sourceStart: addDateOnly(completedWeekEnd, { days: -391 }),
    sourceEnd: completedWeekEnd,
    currentStart: addDateOnly(completedWeekEnd, { days: -363 }),
    currentEnd: completedWeekEnd,
    comparisonStart: addDateOnly(completedWeekEnd, { days: -391 }),
    comparisonEnd: addDateOnly(completedWeekEnd, { days: -28 }),
  };
}

async function loadOpportunitySource(churchId, window) {
  if (!churchId) throw new Error('A church ID is required to load engagement opportunities.');
  if (!window?.sourceStart || !window?.sourceEnd) {
    throw new Error('A bounded engagement source window is required.');
  }
  const query = (sql, params) => Database.queryForChurch(churchId, sql, params);

  const [people, assignments, sessions, records, headcounts] = await Promise.all([
    query(
      `SELECT id,
              first_name AS firstName,
              last_name AS lastName,
              family_id AS familyId,
              people_type AS peopleType,
              is_active AS isActive
       FROM individuals
       WHERE church_id = ?
         AND is_active = 1
         AND people_type = 'regular'
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
      `SELECT s.id,
              s.gathering_type_id AS gatheringTypeId,
              s.session_date AS sessionDate,
              s.session_status AS sessionStatus,
              s.excluded_from_stats AS excludedFromStats,
              s.roster_snapshotted AS rosterSnapshotted,
              s.roster_provenance_version AS rosterProvenanceVersion,
              gt.attendance_type AS attendanceType,
              gt.engagement_role AS engagementRole,
              gt.is_active AS gatheringIsActive
       FROM attendance_sessions s
       JOIN gathering_types gt
         ON gt.id = s.gathering_type_id
        AND gt.church_id = ?
       WHERE s.church_id = ?
         AND s.session_date >= ?
         AND s.session_date <= ?
       ORDER BY s.session_date, s.id`,
      [churchId, churchId, window.sourceStart, window.sourceEnd],
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
       WHERE ar.church_id = ?
         AND s.session_date >= ?
         AND s.session_date <= ?
       ORDER BY ar.session_id, ar.individual_id`,
      [churchId, churchId, window.sourceStart, window.sourceEnd],
    ),
    query(
      `SELECT hr.session_id AS sessionId, hr.headcount
       FROM headcount_records hr
       JOIN attendance_sessions s
         ON s.id = hr.session_id
        AND s.church_id = ?
       WHERE hr.church_id = ?
         AND s.session_date >= ?
         AND s.session_date <= ?
       ORDER BY hr.session_id, hr.id`,
      [churchId, churchId, window.sourceStart, window.sourceEnd],
    ),
  ]);

  return { people, assignments, sessions, records, headcounts };
}

function isCurrentActiveRegular(person) {
  return person?.peopleType === 'regular'
    && (person.isActive === true || Number(person.isActive) === 1);
}

function isIncludedSession(session, start, end) {
  return session?.attendanceType === 'standard'
    && PERSON_LEVEL_ROLES.has(session.engagementRole)
    && session.sessionStatus === 'held'
    && Number(session.excludedFromStats) !== 1
    && typeof session.sessionDate === 'string'
    && session.sessionDate >= start
    && session.sessionDate <= end;
}

function provenanceFor(session) {
  if (Number(session.rosterProvenanceVersion) >= 1) return 'explicit';
  if (Number(session.rosterProvenanceVersion) === 0 && Number(session.rosterSnapshotted) === 1) {
    return 'legacy';
  }
  return 'unknown';
}

function historyTypeIsRegular(record, provenance) {
  if (record.peopleTypeAtTime === 'regular') return true;
  if (record.peopleTypeAtTime === 'local_visitor'
      || record.peopleTypeAtTime === 'traveller_visitor') return false;
  return record.peopleTypeAtTime == null && provenance === 'legacy';
}

function recordCreatesDenominator(record, provenance) {
  if (!historyTypeIsRegular(record, provenance)) return false;
  return provenance === 'legacy' || Number(record.eligibleAtSnapshot) === 1;
}

function mondayFor(date) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('Invalid session date.');
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  return addDateOnly(date, { days: -daysSinceMonday });
}

function emptyEvidence() {
  return { attended: 0, opportunities: 0 };
}

function accumulate(evidenceByPerson, individualId, attended) {
  const evidence = evidenceByPerson.get(individualId) || emptyEvidence();
  evidence.opportunities += 1;
  if (attended) evidence.attended += 1;
  evidenceByPerson.set(individualId, evidence);
}

function evidenceForWindow(opportunities, start, end) {
  const evidenceByPerson = new Map();
  for (const opportunity of opportunities) {
    if (opportunity.date >= start && opportunity.date <= end) {
      accumulate(evidenceByPerson, opportunity.individualId, opportunity.attended);
    }
  }
  return evidenceByPerson;
}

function profileMap(people, assignedByRole, primaryEvidence, communityEvidence, settings) {
  const profiles = new Map();
  for (const person of people) {
    const roles = assignedByRole.get(person.id) || new Set();
    profiles.set(person.id, {
      individualId: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      familyId: person.familyId ?? null,
      primary: classifyEvidence({
        assigned: roles.has('primary'),
        ...(primaryEvidence.get(person.id) || emptyEvidence()),
      }, settings),
      community: classifyEvidence({
        assigned: roles.has('community'),
        ...(communityEvidence.get(person.id) || emptyEvidence()),
      }, settings),
    });
  }
  return profiles;
}

function buildOpportunityProfiles(source, settings = DEFAULT_ENGAGEMENT_SETTINGS, window) {
  if (!window?.sourceStart || !window?.sourceEnd
      || !window?.currentStart || !window?.currentEnd
      || !window?.comparisonStart || !window?.comparisonEnd) {
    throw new Error('A complete engagement window is required.');
  }

  const people = (source?.people || []).filter(isCurrentActiveRegular);
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const assignedByRole = new Map();
  for (const assignment of source?.assignments || []) {
    if (!peopleById.has(assignment.individualId) || !PERSON_LEVEL_ROLES.has(assignment.role)) continue;
    if (assignment.gatheringIsActive !== undefined && Number(assignment.gatheringIsActive) !== 1) continue;
    if (assignment.attendanceType !== undefined && assignment.attendanceType !== 'standard') continue;
    const roles = assignedByRole.get(assignment.individualId) || new Set();
    roles.add(assignment.role);
    assignedByRole.set(assignment.individualId, roles);
  }

  const sessionsById = new Map();
  for (const session of source?.sessions || []) {
    if (isIncludedSession(session, window.sourceStart, window.sourceEnd)) {
      sessionsById.set(session.id, { ...session, provenance: provenanceFor(session) });
    }
  }

  const primaryDenominators = new Map();
  const primaryPresence = new Set();
  const communityOpportunities = new Map();
  for (const record of source?.records || []) {
    const session = sessionsById.get(record.sessionId);
    if (!session || session.provenance === 'unknown' || !peopleById.has(record.individualId)) continue;
    if (!historyTypeIsRegular(record, session.provenance)) continue;

    if (session.engagementRole === 'primary') {
      const monday = mondayFor(session.sessionDate);
      const key = `${record.individualId}:${monday}`;
      if (recordCreatesDenominator(record, session.provenance)) {
        primaryDenominators.set(key, {
          individualId: record.individualId,
          date: monday,
          attended: false,
        });
      }
      if (Number(record.present) === 1) primaryPresence.add(key);
    } else if (recordCreatesDenominator(record, session.provenance)) {
      const key = `${record.individualId}:${session.id}`;
      communityOpportunities.set(key, {
        individualId: record.individualId,
        date: session.sessionDate,
        attended: Number(record.present) === 1,
      });
    }
  }

  const primaryOpportunities = [...primaryDenominators.entries()].map(([key, opportunity]) => ({
    ...opportunity,
    attended: primaryPresence.has(key),
  }));
  const communityOpportunityList = [...communityOpportunities.values()];
  const currentPrimary = evidenceForWindow(primaryOpportunities, window.currentStart, window.currentEnd);
  const comparisonPrimary = evidenceForWindow(
    primaryOpportunities,
    window.comparisonStart,
    window.comparisonEnd,
  );
  const currentCommunity = evidenceForWindow(
    communityOpportunityList,
    window.currentStart,
    window.currentEnd,
  );
  const comparisonCommunity = evidenceForWindow(
    communityOpportunityList,
    window.comparisonStart,
    window.comparisonEnd,
  );

  let explicitProvenanceSessions = 0;
  let legacyProvenanceSessions = 0;
  let excludedUnknownProvenanceSessions = 0;
  for (const session of source?.sessions || []) {
    if (!isIncludedSession(session, window.currentStart, window.currentEnd)) continue;
    const provenance = provenanceFor(session);
    if (provenance === 'explicit') explicitProvenanceSessions += 1;
    else if (provenance === 'legacy') legacyProvenanceSessions += 1;
    else excludedUnknownProvenanceSessions += 1;
  }
  const eligibleHeldSessions = explicitProvenanceSessions + legacyProvenanceSessions;

  return {
    current: profileMap(people, assignedByRole, currentPrimary, currentCommunity, settings),
    comparison: profileMap(
      people,
      assignedByRole,
      comparisonPrimary,
      comparisonCommunity,
      settings,
    ),
    coverage: {
      eligibleHeldSessions,
      explicitProvenanceSessions,
      legacyProvenanceSessions,
      excludedUnknownProvenanceSessions,
      legacyProvenanceShare: eligibleHeldSessions === 0
        ? 0
        : legacyProvenanceSessions / eligibleHeldSessions,
    },
    datedOpportunities: {
      primary: primaryOpportunities,
      community: communityOpportunityList,
    },
  };
}

async function calculateEngagementProfiles(churchId, options = {}) {
  if (!churchId) throw new Error('A church ID is required to calculate engagement profiles.');
  const [timeZone, settings] = await Promise.all([
    loadChurchTimeZone(churchId),
    getEngagementSettings(churchId),
  ]);
  const window = getEngagementWindow(options.asOf ?? new Date(), timeZone);
  const source = await loadOpportunitySource(churchId, window);
  return {
    ...buildOpportunityProfiles(source, settings, window),
    window,
    settings,
  };
}

module.exports = {
  MINIMUM_CLASSIFIED_OPPORTUNITIES,
  getEngagementWindow,
  loadOpportunitySource,
  buildOpportunityProfiles,
  calculateEngagementProfiles,
};
