'use strict';

const Database = require('../../config/database');
const opportunities = require('./opportunities');

const TIER_RANK = Object.freeze({ irregular: 0, casual: 1, core: 2 });
const CLASSIFIED_TIERS = new Set(Object.keys(TIER_RANK));

function classifiedTier(status) {
  return CLASSIFIED_TIERS.has(status) ? status : null;
}

function isDecline(currentTier, comparisonTier) {
  return currentTier !== null
    && comparisonTier !== null
    && TIER_RANK[currentTier] < TIER_RANK[comparisonTier];
}

async function createEligibleDeliveryRowsWithConnection(conn, {
  churchId,
  individualId,
  familyId,
  fromTier,
  toTier,
  effectiveWeekEnd,
  rulesVersion,
}) {
  const noCreation = { eventId: null, eventCreated: 0, deliveriesCreated: 0 };
  if (!churchId || !individualId || !fromTier || !toTier
      || !effectiveWeekEnd || !rulesVersion) return noCreation;

  const inserted = await conn.query(
    `INSERT INTO engagement_decline_events
       (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
        effective_week_end, rules_version, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(church_id, individual_id, to_tier, effective_week_end, rules_version)
     DO NOTHING`,
    [
      churchId,
      individualId,
      familyId,
      fromTier,
      toTier,
      effectiveWeekEnd,
      rulesVersion,
    ],
  );
  if (inserted.affectedRows !== 1) return noCreation;

  const creation = {
    eventId: inserted.insertId,
    eventCreated: 1,
    deliveriesCreated: 0,
  };
  if (familyId == null) return creation;

  const deliveries = await conn.query(
    `INSERT INTO engagement_decline_deliveries
       (church_id, event_id, recipient_type, recipient_id,
        family_caregiver_id, state, created_at, updated_at)
     SELECT event.church_id,
            event.id,
            caregiver.caregiver_type,
            CASE caregiver.caregiver_type
              WHEN 'user' THEN caregiver.user_id
              ELSE caregiver.contact_id
            END,
            caregiver.id,
            'pending', datetime('now'), datetime('now')
     FROM engagement_decline_events event
     JOIN individuals subject
       ON subject.id = event.individual_id
      AND subject.church_id = ?
      AND subject.family_id = event.family_at_detection_id
      AND subject.is_active = 1
      AND subject.people_type = 'regular'
     JOIN family_caregivers caregiver
       ON caregiver.church_id = ?
      AND caregiver.family_id = event.family_at_detection_id
     LEFT JOIN users recipient_user
       ON caregiver.caregiver_type = 'user'
      AND recipient_user.id = caregiver.user_id
      AND recipient_user.church_id = ?
     LEFT JOIN contacts recipient_contact
       ON caregiver.caregiver_type = 'contact'
      AND recipient_contact.id = caregiver.contact_id
      AND recipient_contact.church_id = ?
     WHERE event.id = ?
       AND event.church_id = ?
       AND event.family_at_detection_id = ?
       AND (
         (caregiver.caregiver_type = 'user'
          AND recipient_user.is_active = 1
          AND recipient_user.email IS NOT NULL
          AND trim(recipient_user.email) <> ''
          AND recipient_user.email_notifications = 1)
         OR
         (caregiver.caregiver_type = 'contact'
          AND recipient_contact.is_active = 1
          AND recipient_contact.email IS NOT NULL
          AND trim(recipient_contact.email) <> ''
          AND recipient_contact.primary_contact_method = 'email')
       )
     ON CONFLICT(church_id, event_id, recipient_type, recipient_id) DO NOTHING`,
    [
      churchId,
      churchId,
      churchId,
      churchId,
      inserted.insertId,
      churchId,
      familyId,
    ],
  );
  creation.deliveriesCreated = deliveries.affectedRows;
  return creation;
}

function eventKey(event) {
  return `${event.individualId}:${event.toTier}:${event.effectiveWeekEnd}:${event.rulesVersion}`;
}

async function loadEvaluationSnapshot(conn, churchId, rulesVersion) {
  const [states, events] = await Promise.all([
    conn.query(
      `SELECT individual_id AS individualId,
              rules_version AS rulesVersion,
              last_evaluated_week_end AS lastEvaluatedWeekEnd,
              current_tier AS currentTier,
              active_lowest_decline_tier AS activeTier,
              baseline_suppressed AS baselineSuppressed
       FROM engagement_evaluation_state
       WHERE church_id = ?
       ORDER BY individual_id`,
      [churchId],
    ),
    conn.query(
      `SELECT id, individual_id AS individualId,
              from_tier AS fromTier, to_tier AS toTier,
              effective_week_end AS effectiveWeekEnd,
              rules_version AS rulesVersion, recovered_at AS recoveredAt
       FROM engagement_decline_events
       WHERE church_id = ? AND rules_version = ?
       ORDER BY individual_id,
         CASE to_tier WHEN 'irregular' THEN 0 WHEN 'casual' THEN 1 ELSE 2 END,
         id DESC`,
      [churchId, rulesVersion],
    ),
  ]);
  return { states, events };
}

async function upsertEvaluationStates(conn, churchId, states) {
  if (states.length === 0) return;
  await conn.query(
    `INSERT INTO engagement_evaluation_state
       (church_id, individual_id, rules_version, last_evaluated_week_end,
        current_tier, active_lowest_decline_tier, baseline_suppressed,
        created_at, updated_at)
     SELECT ?,
            CAST(json_extract(state.value, '$.individualId') AS INTEGER),
            CAST(json_extract(state.value, '$.rulesVersion') AS INTEGER),
            json_extract(state.value, '$.completedWeekEnd'),
            json_extract(state.value, '$.currentTier'),
            json_extract(state.value, '$.activeTier'),
            CAST(json_extract(state.value, '$.baselineSuppressed') AS INTEGER),
            datetime('now'), datetime('now')
     FROM json_each(?) state
     WHERE 1
     ON CONFLICT(church_id, individual_id) DO UPDATE SET
       rules_version = excluded.rules_version,
       last_evaluated_week_end = excluded.last_evaluated_week_end,
       current_tier = excluded.current_tier,
       active_lowest_decline_tier = excluded.active_lowest_decline_tier,
       baseline_suppressed = excluded.baseline_suppressed,
       updated_at = datetime('now')`,
    [churchId, JSON.stringify(states)],
  );
}

async function persistEvaluationActions(conn, churchId, rulesVersion, actions) {
  let eventsRecovered = 0;
  let eventsCreated = 0;
  let deliveriesCreated = 0;

  if (actions.recoveredEventIds.length > 0) {
    const recovered = await conn.query(
      `UPDATE engagement_decline_events
       SET recovered_at = datetime('now')
       WHERE church_id = ?
         AND rules_version = ?
         AND recovered_at IS NULL
         AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
      [churchId, rulesVersion, JSON.stringify(actions.recoveredEventIds)],
    );
    eventsRecovered = recovered.affectedRows;
  }

  if (actions.newEvents.length > 0) {
    const inserted = await conn.query(
      `INSERT INTO engagement_decline_events
         (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
          effective_week_end, rules_version, detected_at)
       SELECT ?,
              CAST(json_extract(event.value, '$.individualId') AS INTEGER),
              CAST(json_extract(event.value, '$.familyId') AS INTEGER),
              json_extract(event.value, '$.fromTier'),
              json_extract(event.value, '$.toTier'),
              json_extract(event.value, '$.effectiveWeekEnd'),
              CAST(json_extract(event.value, '$.rulesVersion') AS INTEGER),
              datetime('now')
       FROM json_each(?) event
       WHERE 1
       ON CONFLICT(church_id, individual_id, to_tier, effective_week_end, rules_version)
       DO NOTHING`,
      [churchId, JSON.stringify(actions.newEvents)],
    );
    eventsCreated = inserted.affectedRows;

    const deliveries = await conn.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id,
          family_caregiver_id, state, created_at, updated_at)
       SELECT decline.church_id,
              decline.id,
              caregiver.caregiver_type,
              CASE caregiver.caregiver_type
                WHEN 'user' THEN caregiver.user_id
                ELSE caregiver.contact_id
              END,
              caregiver.id,
              'pending', datetime('now'), datetime('now')
       FROM json_each(?) candidate
       JOIN engagement_decline_events decline
         ON decline.church_id = ?
        AND decline.individual_id = CAST(json_extract(candidate.value, '$.individualId') AS INTEGER)
        AND decline.to_tier = json_extract(candidate.value, '$.toTier')
        AND decline.effective_week_end = json_extract(candidate.value, '$.effectiveWeekEnd')
        AND decline.rules_version = CAST(json_extract(candidate.value, '$.rulesVersion') AS INTEGER)
       JOIN individuals subject
         ON subject.id = decline.individual_id
        AND subject.church_id = ?
        AND subject.family_id = decline.family_at_detection_id
        AND subject.is_active = 1
        AND subject.people_type = 'regular'
       JOIN family_caregivers caregiver
         ON caregiver.church_id = ?
        AND caregiver.family_id = decline.family_at_detection_id
       LEFT JOIN users recipient_user
         ON caregiver.caregiver_type = 'user'
        AND recipient_user.id = caregiver.user_id
        AND recipient_user.church_id = ?
       LEFT JOIN contacts recipient_contact
         ON caregiver.caregiver_type = 'contact'
        AND recipient_contact.id = caregiver.contact_id
        AND recipient_contact.church_id = ?
       WHERE (
         (caregiver.caregiver_type = 'user'
          AND recipient_user.is_active = 1
          AND recipient_user.email IS NOT NULL
          AND trim(recipient_user.email) <> ''
          AND recipient_user.email_notifications = 1)
         OR
         (caregiver.caregiver_type = 'contact'
          AND recipient_contact.is_active = 1
          AND recipient_contact.email IS NOT NULL
          AND trim(recipient_contact.email) <> ''
          AND recipient_contact.primary_contact_method = 'email')
       )
       ON CONFLICT(church_id, event_id, recipient_type, recipient_id) DO NOTHING`,
      [
        JSON.stringify(actions.newEvents),
        churchId,
        churchId,
        churchId,
        churchId,
        churchId,
      ],
    );
    deliveriesCreated = deliveries.affectedRows;
  }

  await upsertEvaluationStates(conn, churchId, actions.states);
  return { eventsRecovered, eventsCreated, deliveriesCreated };
}

async function evaluateEngagementDeclines(churchId, options = {}) {
  if (!churchId) throw new Error('A church ID is required to evaluate engagement declines.');

  return Database.transactionForChurch(churchId, async (conn) => {
    const profiles = await opportunities.calculateEngagementProfiles(churchId, {
      asOf: options.asOf ?? new Date(),
    });
    const completedWeekEnd = profiles.window.completedWeekEnd;
    const rulesVersion = profiles.settings.calculationRulesVersion;
    const summary = {
      completedWeekEnd,
      baselined: 0,
      eventsCreated: 0,
      eventsRecovered: 0,
      deliveriesCreated: 0,
    };
    const snapshot = await loadEvaluationSnapshot(conn, churchId, rulesVersion);
    const stateByPerson = new Map(
      snapshot.states.map((state) => [state.individualId, state]),
    );
    const eventsByPerson = new Map();
    const existingEventKeys = new Set(snapshot.events.map(eventKey));
    for (const event of snapshot.events) {
      const events = eventsByPerson.get(event.individualId) || [];
      events.push(event);
      eventsByPerson.set(event.individualId, events);
    }
    const actions = { states: [], recoveredEventIds: [], newEvents: [] };

    for (const [individualId, profile] of profiles.current) {
      const comparison = profiles.comparison.get(individualId);
      const currentTier = classifiedTier(profile.primary.status);
      const comparisonTier = classifiedTier(comparison?.primary?.status);
      const state = stateByPerson.get(individualId);

      if (!state || state.rulesVersion !== rulesVersion) {
        const activeTier = isDecline(currentTier, comparisonTier) ? currentTier : null;
        actions.states.push({
          individualId,
          rulesVersion,
          completedWeekEnd,
          currentTier,
          activeTier,
          baselineSuppressed: activeTier === null ? 0 : 1,
        });
        summary.baselined += 1;
        continue;
      }

      if (state.lastEvaluatedWeekEnd >= completedWeekEnd) continue;

      let activeTier = state.activeTier;
      let baselineSuppressed = state.baselineSuppressed;
      const recoveredThisWeek = activeTier !== null
        && currentTier !== null
        && TIER_RANK[currentTier] > TIER_RANK[activeTier];

      if (recoveredThisWeek) {
        const openEvents = (eventsByPerson.get(individualId) || [])
          .filter((event) => event.recoveredAt == null);
        const recoveredEvents = openEvents.filter(
          (event) => TIER_RANK[event.toTier] < TIER_RANK[currentTier],
        );
        actions.recoveredEventIds.push(...recoveredEvents.map((event) => event.id));
        const recoveredIds = new Set(recoveredEvents.map((event) => event.id));
        const remaining = openEvents.filter((event) => !recoveredIds.has(event.id));
        if (remaining.length > 0) {
          activeTier = remaining[0].toTier;
        } else {
          const returnsToSuppressedTier = baselineSuppressed === 1 && currentTier !== 'core';
          activeTier = returnsToSuppressedTier ? currentTier : null;
          baselineSuppressed = returnsToSuppressedTier ? 1 : 0;
        }
      } else if (isDecline(currentTier, comparisonTier)
          && isDecline(currentTier, state.currentTier)
          && (activeTier === null || TIER_RANK[currentTier] < TIER_RANK[activeTier])) {
        const event = {
          individualId,
          familyId: profile.familyId,
          fromTier: comparisonTier,
          toTier: currentTier,
          effectiveWeekEnd: completedWeekEnd,
          rulesVersion,
        };
        if (!existingEventKeys.has(eventKey(event))) actions.newEvents.push(event);
        activeTier = currentTier;
      }

      actions.states.push({
        individualId,
        rulesVersion,
        completedWeekEnd,
        currentTier,
        activeTier,
        baselineSuppressed,
      });
    }

    const persisted = await persistEvaluationActions(conn, churchId, rulesVersion, actions);
    summary.eventsRecovered = persisted.eventsRecovered;
    summary.eventsCreated = persisted.eventsCreated;
    summary.deliveriesCreated = persisted.deliveriesCreated;

    return summary;
  });
}

module.exports = {
  evaluateEngagementDeclines,
  createEligibleDeliveryRowsWithConnection,
};
