'use strict';

const Database = require('../../config/database');
const {
  addDateOnly,
  getChurchDate,
  loadChurchTimeZone,
} = require('../../utils/churchTime');
const { calculateEngagementProfiles } = require('./opportunities');

const INSIGHT_TYPES = Object.freeze({
  DECLINE: 'primary_decline',
  COMMUNITY_GAP: 'community_primary_gap',
  VISITOR: 'visitor_next_step',
  RE_ENGAGEMENT: 're_engagement',
});
const ACTIONS = new Set(['snooze', 'dismiss', 'reopen']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

class PastoralInsightError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'PastoralInsightError';
    this.code = code;
    this.status = status;
  }
}

function notFound() {
  throw new PastoralInsightError(
    'Pastoral insight not found.',
    'PASTORAL_INSIGHT_NOT_FOUND',
    404,
  );
}

function invalidAction(message) {
  throw new PastoralInsightError(message, 'INVALID_PASTORAL_ACTION', 400);
}

function validDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateAction(input, today) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.has(input.action)) {
    invalidAction('Action must be snooze, dismiss, or reopen.');
  }
  if (input.action === 'snooze') {
    if (!validDateOnly(input.snoozeUntil) || input.snoozeUntil <= today) {
      invalidAction('snoozeUntil must be a future date in YYYY-MM-DD format.');
    }
  } else if (input.snoozeUntil !== undefined) {
    invalidAction('snoozeUntil is accepted only for the snooze action.');
  }
}

function candidateKey(type, source) {
  if (type === INSIGHT_TYPES.DECLINE) return `${type}:event:${source.id}`;
  if (type === INSIGHT_TYPES.RE_ENGAGEMENT) return `${type}:event:${source.id}`;
  if (type === INSIGHT_TYPES.VISITOR) {
    return `${type}:first_primary:${source.firstPrimaryAttendanceDate}`;
  }
  return `${type}:${source.completedWeekEnd}`;
}

function sqliteDate(value) {
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

async function loadPastoralSource(churchId, window) {
  const query = (sql, params) => Database.queryForChurch(churchId, sql, params);
  const recoveryCutoff = addDateOnly(window.completedWeekEnd, { days: -27 });
  const [people, families, caregivers, lastAttendance, declineEvents, visitorAttendance] = await Promise.all([
    query(
      `SELECT id, first_name AS firstName, last_name AS lastName,
              family_id AS familyId, people_type AS peopleType, is_active AS isActive
       FROM individuals
       WHERE church_id = ?
       ORDER BY id`,
      [churchId],
    ),
    query(
      `SELECT id, family_name AS name
       FROM families
       WHERE church_id = ?
       ORDER BY id`,
      [churchId],
    ),
    query(
      `SELECT fc.id AS assignmentId, fc.family_id AS familyId,
              fc.caregiver_type AS type,
              CASE fc.caregiver_type WHEN 'user' THEN fc.user_id ELSE fc.contact_id END AS id,
              CASE fc.caregiver_type WHEN 'user' THEN u.first_name ELSE c.first_name END AS firstName,
              CASE fc.caregiver_type WHEN 'user' THEN u.last_name ELSE c.last_name END AS lastName,
              CASE fc.caregiver_type WHEN 'user' THEN u.email ELSE c.email END AS email,
              CASE fc.caregiver_type WHEN 'user' THEN u.is_active ELSE c.is_active END AS isActive
       FROM family_caregivers fc
       LEFT JOIN users u
         ON fc.caregiver_type = 'user' AND u.id = fc.user_id AND u.church_id = ?
       LEFT JOIN contacts c
         ON fc.caregiver_type = 'contact' AND c.id = fc.contact_id AND c.church_id = ?
       WHERE fc.church_id = ?
       ORDER BY fc.family_id, fc.id`,
      [churchId, churchId, churchId],
    ),
    query(
      `WITH ranked AS (
         SELECT ar.individual_id AS individualId, s.session_date AS date,
                s.gathering_type_id AS gatheringTypeId, gt.name AS gatheringName,
                gt.engagement_role AS engagementRole,
                ROW_NUMBER() OVER (
                  PARTITION BY ar.individual_id
                  ORDER BY s.session_date DESC, s.id DESC
                ) AS rowNumber
         FROM attendance_records ar
         JOIN attendance_sessions s
           ON s.id = ar.session_id AND s.church_id = ?
         JOIN gathering_types gt
           ON gt.id = s.gathering_type_id AND gt.church_id = ?
         WHERE ar.church_id = ?
           AND ar.present = 1
           AND s.session_status = 'held'
           AND s.excluded_from_stats = 0
           AND s.session_date <= ?
       )
       SELECT individualId, date, gatheringTypeId, gatheringName, engagementRole
       FROM ranked WHERE rowNumber = 1
       ORDER BY individualId`,
      [churchId, churchId, churchId, window.completedWeekEnd],
    ),
    query(
      `SELECT id, individual_id AS individualId,
              family_at_detection_id AS familyAtDetectionId,
              from_tier AS fromTier, to_tier AS toTier,
              effective_week_end AS effectiveWeekEnd,
              rules_version AS rulesVersion, detected_at AS detectedAt,
              recovered_at AS recoveredAt
       FROM engagement_decline_events
       WHERE church_id = ?
         AND (recovered_at IS NULL OR date(recovered_at) >= ?)
       ORDER BY id`,
      [churchId, recoveryCutoff],
    ),
    query(
      `SELECT ar.individual_id AS individualId,
              MIN(s.session_date) AS firstPrimaryAttendanceDate,
              COUNT(DISTINCT s.session_date) AS attendanceDates
       FROM attendance_records ar
       JOIN attendance_sessions s
         ON s.id = ar.session_id AND s.church_id = ?
       JOIN gathering_types gt
         ON gt.id = s.gathering_type_id AND gt.church_id = ?
       WHERE ar.church_id = ?
         AND ar.present = 1
         AND s.session_status = 'held'
         AND s.excluded_from_stats = 0
         AND gt.attendance_type = 'standard'
         AND gt.engagement_role = 'primary'
         AND (s.roster_provenance_version >= 1
              OR (s.roster_provenance_version = 0 AND s.roster_snapshotted = 1))
         AND s.session_date <= ?
       GROUP BY ar.individual_id
       ORDER BY ar.individual_id`,
      [churchId, churchId, churchId, window.completedWeekEnd],
    ),
  ]);
  return { people, families, caregivers, lastAttendance, declineEvents, visitorAttendance };
}

function buildCandidates(source, profiles, window) {
  const peopleById = new Map(source.people.map((person) => [person.id, person]));
  const candidates = [];
  const activeRegular = (individualId) => {
    const person = peopleById.get(individualId);
    return person && Number(person.isActive) === 1 && person.peopleType === 'regular';
  };

  for (const event of source.declineEvents) {
    if (!activeRegular(event.individualId)) continue;
    if (event.recoveredAt == null) {
      candidates.push({
        type: INSIGHT_TYPES.DECLINE,
        subjectId: event.individualId,
        episodeKey: candidateKey(INSIGHT_TYPES.DECLINE, event),
        declineEventId: event.id,
        evidence: {
          eventId: event.id,
          fromTier: event.fromTier,
          toTier: event.toTier,
          effectiveWeekEnd: event.effectiveWeekEnd,
          detectedAt: event.detectedAt,
          recoveredAt: null,
        },
      });
      continue;
    }
    const recoveryDate = sqliteDate(event.recoveredAt);
    const recoveryCutoff = addDateOnly(window.completedWeekEnd, { days: -27 });
    if (recoveryDate >= recoveryCutoff) {
      candidates.push({
        type: INSIGHT_TYPES.RE_ENGAGEMENT,
        subjectId: event.individualId,
        episodeKey: candidateKey(INSIGHT_TYPES.RE_ENGAGEMENT, event),
        declineEventId: event.id,
        evidence: {
          eventId: event.id,
          fromTier: event.fromTier,
          toTier: event.toTier,
          effectiveWeekEnd: event.effectiveWeekEnd,
          recoveredAt: event.recoveredAt,
        },
      });
    }
  }

  for (const [individualId, profile] of profiles.current) {
    if (profile.primary.status !== 'irregular' || profile.community.status !== 'core') continue;
    candidates.push({
      type: INSIGHT_TYPES.COMMUNITY_GAP,
      subjectId: individualId,
      episodeKey: candidateKey(INSIGHT_TYPES.COMMUNITY_GAP, {
        completedWeekEnd: window.completedWeekEnd,
      }),
      declineEventId: null,
      evidence: {
        primaryTier: 'irregular',
        communityTier: 'core',
        completedWeekEnd: window.completedWeekEnd,
      },
      recurringCondition: true,
    });
  }

  const visitorCutoff = addDateOnly(window.completedWeekEnd, { days: -55 });
  for (const visit of source.visitorAttendance) {
    const person = peopleById.get(visit.individualId);
    if (!person || Number(person.isActive) !== 1 || person.peopleType !== 'local_visitor') continue;
    const firstPrimaryAttendanceDate = visit.firstPrimaryAttendanceDate;
    if (firstPrimaryAttendanceDate < visitorCutoff || Number(visit.attendanceDates) !== 1) continue;
    const sourceFact = { firstPrimaryAttendanceDate };
    candidates.push({
      type: INSIGHT_TYPES.VISITOR,
      subjectId: visit.individualId,
      episodeKey: candidateKey(INSIGHT_TYPES.VISITOR, sourceFact),
      declineEventId: null,
      evidence: { firstPrimaryAttendanceDate, laterPrimaryAttendances: 0 },
    });
  }
  return candidates;
}

function activeStateForCondition(states, candidate) {
  return states.find((state) => state.type === candidate.type
    && state.subjectId === candidate.subjectId
    && state.workflowState !== 'resolved');
}

function uniqueEpisodeKey(candidate, states) {
  const keys = new Set(states
    .filter((state) => state.type === candidate.type && state.subjectId === candidate.subjectId)
    .map((state) => state.episodeKey));
  if (!keys.has(candidate.episodeKey)) return candidate.episodeKey;
  let recurrence = 2;
  while (keys.has(`${candidate.episodeKey}:${recurrence}`)) recurrence += 1;
  return `${candidate.episodeKey}:${recurrence}`;
}

async function reconcileStates(churchId, candidates, today) {
  return Database.transactionForChurch(churchId, async (conn) => {
    const activeIds = new Set();
    const states = await conn.query(
      `SELECT id, insight_type AS type, subject_id AS subjectId,
              episode_key AS episodeKey, decline_event_id AS declineEventId,
              workflow_state AS workflowState, snoozed_until AS snoozedUntil,
              acted_by AS actedBy, resolved_at AS resolvedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM pastoral_insight_states
       WHERE church_id = ?
       ORDER BY id`,
      [churchId],
    );
    for (const candidate of candidates) {
      let state = states.find((row) => row.type === candidate.type
        && row.subjectId === candidate.subjectId
        && row.episodeKey === candidate.episodeKey);
      if (!state && candidate.recurringCondition) state = activeStateForCondition(states, candidate);
      if (!state) {
        const episodeKey = uniqueEpisodeKey(candidate, states);
        const inserted = await conn.query(
          `INSERT INTO pastoral_insight_states
             (church_id, insight_type, subject_id, episode_key, decline_event_id,
              workflow_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))`,
          [churchId, candidate.type, candidate.subjectId, episodeKey, candidate.declineEventId],
        );
        state = {
          id: inserted.insertId,
          type: candidate.type,
          subjectId: candidate.subjectId,
          episodeKey,
          declineEventId: candidate.declineEventId,
          workflowState: 'open',
          snoozedUntil: null,
          actedBy: null,
          resolvedAt: null,
          createdAt: null,
          updatedAt: null,
        };
        states.push(state);
      }
      activeIds.add(state.id);
      candidate.stateId = state.id;
      candidate.episodeKey = state.episodeKey;
      if (state.workflowState === 'snoozed' && state.snoozedUntil <= today) {
        await conn.query(
          `UPDATE pastoral_insight_states
           SET workflow_state = 'open', snoozed_until = NULL, updated_at = datetime('now')
           WHERE church_id = ? AND id = ? AND workflow_state = 'snoozed'`,
          [churchId, state.id],
        );
        state.workflowState = 'open';
        state.snoozedUntil = null;
      }
    }

    for (const state of states) {
      if (activeIds.has(state.id) || state.workflowState === 'resolved') continue;
      await conn.query(
        `UPDATE pastoral_insight_states
         SET workflow_state = 'resolved', snoozed_until = NULL,
             resolved_at = datetime('now'), updated_at = datetime('now')
         WHERE church_id = ? AND id = ?`,
        [churchId, state.id],
      );
      state.workflowState = 'resolved';
      state.snoozedUntil = null;
    }
    return conn.query(
      `SELECT id, insight_type AS type, subject_id AS subjectId,
              episode_key AS episodeKey, decline_event_id AS declineEventId,
              workflow_state AS workflowState, snoozed_until AS snoozedUntil,
              acted_by AS actedBy, resolved_at AS resolvedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM pastoral_insight_states
       WHERE church_id = ?
       ORDER BY id`,
      [churchId],
    );
  });
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const values = grouped.get(row[key]) || [];
    values.push(row);
    grouped.set(row[key], values);
  }
  return grouped;
}

async function deliverySummaries(churchId, eventIds) {
  if (eventIds.length === 0) return new Map();
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT event_id AS eventId,
            SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
     FROM engagement_decline_deliveries
     WHERE church_id = ? AND event_id IN (${placeholders})
     GROUP BY event_id`,
    [churchId, ...eventIds],
  );
  return new Map(rows.map((row) => [row.eventId, {
    pending: Number(row.pending),
    delivered: Number(row.delivered),
    cancelled: Number(row.cancelled),
  }]));
}

function insightRows(candidates, states, source, profiles, deliveries, options = {}) {
  const statesById = new Map(states.map((state) => [state.id, state]));
  const peopleById = new Map(source.people.map((person) => [person.id, person]));
  const familiesById = new Map(source.families.map((family) => [family.id, family]));
  const caregiversByFamily = groupBy(source.caregivers, 'familyId');
  const attendanceByPerson = new Map(source.lastAttendance.map((row) => [row.individualId, row]));
  const rows = [];
  for (const candidate of candidates) {
    const state = statesById.get(candidate.stateId);
    if (!state || state.workflowState === 'resolved') continue;
    if (!options.includeAll) {
      if (state.workflowState === 'dismissed') continue;
      if (state.workflowState === 'snoozed' && !options.includeSnoozed) continue;
    }
    const person = peopleById.get(candidate.subjectId);
    if (!person) continue;
    const profile = profiles.current.get(candidate.subjectId);
    const family = person.familyId == null ? null : familiesById.get(person.familyId) || null;
    rows.push({
      id: state.id,
      type: candidate.type,
      episodeKey: candidate.episodeKey,
      declineEventId: candidate.declineEventId,
      person: {
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        peopleType: person.peopleType,
        isActive: Number(person.isActive) === 1,
      },
      family: family ? { id: family.id, name: family.name } : null,
      lastAttendance: attendanceByPerson.get(person.id) || null,
      profiles: {
        primary: profile?.primary || { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
        community: profile?.community || { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
      },
      evidence: candidate.evidence,
      caregivers: person.familyId == null ? [] : (caregiversByFamily.get(person.familyId) || []).map((row) => ({
        assignmentId: row.assignmentId,
        type: row.type,
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        isActive: Number(row.isActive) === 1,
      })),
      deliverySummary: candidate.type !== INSIGHT_TYPES.DECLINE
        ? { pending: 0, delivered: 0, cancelled: 0 }
        : deliveries.get(candidate.declineEventId) || { pending: 0, delivered: 0, cancelled: 0 },
      workflow: {
        state: state.workflowState,
        snoozedUntil: state.snoozedUntil,
        actedBy: state.actedBy,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      },
    });
  }
  const typeOrder = [
    INSIGHT_TYPES.DECLINE,
    INSIGHT_TYPES.COMMUNITY_GAP,
    INSIGHT_TYPES.VISITOR,
    INSIGHT_TYPES.RE_ENGAGEMENT,
  ];
  return rows.sort((left, right) => typeOrder.indexOf(left.type) - typeOrder.indexOf(right.type)
    || left.person.lastName.localeCompare(right.person.lastName)
    || left.person.firstName.localeCompare(right.person.firstName)
    || left.person.id - right.person.id);
}

async function buildPastoralInsights(churchId, options = {}) {
  if (!churchId) throw new Error('A church ID is required to load pastoral insights.');
  const asOf = options.asOf ?? new Date();
  const [timeZone, profiles] = await Promise.all([
    loadChurchTimeZone(churchId),
    calculateEngagementProfiles(churchId, { asOf }),
  ]);
  const today = getChurchDate(asOf, timeZone);
  const source = await loadPastoralSource(churchId, profiles.window);
  const candidates = buildCandidates(source, profiles, profiles.window);
  const states = await reconcileStates(churchId, candidates, today);
  const eventIds = [...new Set(candidates
    .map((candidate) => candidate.declineEventId)
    .filter((id) => id != null))];
  const deliveries = await deliverySummaries(churchId, eventIds);
  return {
    schemaVersion: 1,
    churchId,
    window: { completedWeekEnd: profiles.window.completedWeekEnd },
    insights: insightRows(candidates, states, source, profiles, deliveries, options),
  };
}

async function getPastoralInsights(churchId, options = {}) {
  return buildPastoralInsights(churchId, options);
}

async function applyPastoralInsightAction(churchId, actorId, insightId, input) {
  if (!churchId) throw new Error('A church ID is required to change a pastoral insight.');
  const numericInsightId = Number(insightId);
  if (!Number.isInteger(numericInsightId) || numericInsightId <= 0) notFound();
  const timeZone = await loadChurchTimeZone(churchId);
  const today = getChurchDate(new Date(), timeZone);
  validateAction(input, today);

  const [stateRows, actorRows] = await Promise.all([
    Database.queryForChurch(
      churchId,
      `SELECT id, insight_type AS type, decline_event_id AS declineEventId,
              workflow_state AS workflowState
       FROM pastoral_insight_states
       WHERE church_id = ? AND id = ?`,
      [churchId, numericInsightId],
    ),
    Database.queryForChurch(
      churchId,
      `SELECT id FROM users WHERE church_id = ? AND id = ? AND is_active = 1`,
      [churchId, actorId],
    ),
  ]);
  const [state] = stateRows;
  if (!state || state.workflowState === 'resolved') notFound();
  if (actorRows.length === 0) {
    throw new PastoralInsightError(
      'Pastoral workflow actor not found.',
      'PASTORAL_ACTOR_NOT_FOUND',
      403,
    );
  }

  await Database.transactionForChurch(churchId, async (conn) => {
    if (input.action === 'snooze') {
      await conn.query(
        `UPDATE pastoral_insight_states
         SET workflow_state = 'snoozed', snoozed_until = ?, acted_by = ?,
             resolved_at = NULL, updated_at = datetime('now')
         WHERE church_id = ? AND id = ?`,
        [input.snoozeUntil, actorId, churchId, numericInsightId],
      );
    } else if (input.action === 'dismiss') {
      await conn.query(
        `UPDATE pastoral_insight_states
         SET workflow_state = 'dismissed', snoozed_until = NULL, acted_by = ?,
             resolved_at = NULL, updated_at = datetime('now')
         WHERE church_id = ? AND id = ?`,
        [actorId, churchId, numericInsightId],
      );
      if (state.type === INSIGHT_TYPES.DECLINE && state.declineEventId != null) {
        await conn.query(
          `UPDATE engagement_decline_deliveries
           SET state = 'cancelled', cancellation_reason = 'pastoral_dismissed',
               updated_at = datetime('now')
           WHERE church_id = ? AND event_id = ? AND state = 'pending'`,
          [churchId, state.declineEventId],
        );
      }
    } else {
      await conn.query(
        `UPDATE pastoral_insight_states
         SET workflow_state = 'open', snoozed_until = NULL, acted_by = ?,
             resolved_at = NULL, updated_at = datetime('now')
         WHERE church_id = ? AND id = ?`,
        [actorId, churchId, numericInsightId],
      );
    }
  });

  const response = await buildPastoralInsights(churchId, { includeSnoozed: true, includeAll: true });
  const insight = response.insights.find((row) => row.id === numericInsightId);
  if (!insight) notFound();
  return insight;
}

module.exports = {
  INSIGHT_TYPES,
  PastoralInsightError,
  getPastoralInsights,
  applyPastoralInsightAction,
};
