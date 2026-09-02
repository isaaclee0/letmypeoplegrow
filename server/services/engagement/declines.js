'use strict';

const Database = require('../../config/database');
const { evaluateEngagementTierConfirmations } = require('./tierConfirmationEvaluator');

const TIER_RANK = Object.freeze({ irregular: 0, casual: 1, core: 2 });

async function createEligibleDeliveryRowsWithConnection(conn, {
  churchId,
  individualId,
  familyId,
  fromTier,
  toTier,
  effectiveWeekEnd,
  rulesVersion,
  primaryAttended = null,
  primaryOpportunities = null,
  primaryRate = null,
  confirmationAttended = null,
  confirmationOpportunities = null,
  confirmationRate = null,
}) {
  const noCreation = { eventId: null, eventCreated: 0, deliveriesCreated: 0 };
  if (!churchId || !individualId || !fromTier || !toTier
      || !effectiveWeekEnd || !rulesVersion) return noCreation;

  const inserted = await conn.query(
    `INSERT INTO engagement_decline_events
       (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
        effective_week_end, rules_version, detected_at,
        primary_attended_at_detection, primary_opportunities_at_detection,
        primary_rate_at_detection, confirmation_attended_at_detection,
        confirmation_opportunities_at_detection, confirmation_rate_at_detection)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
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
      primaryAttended,
      primaryOpportunities,
      primaryRate,
      confirmationAttended,
      confirmationOpportunities,
      confirmationRate,
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

async function loadCurrentRulesVersion(conn, churchId) {
  const rows = await conn.query(
    `SELECT calculation_rules_version AS rulesVersion
     FROM engagement_settings
     WHERE church_id = ?
     LIMIT 1`,
    [churchId],
  );
  return rows[0]?.rulesVersion ?? 1;
}

async function retireSupersededRulesWithConnection(conn, churchId, rulesVersion) {
  await conn.query(
    `UPDATE pastoral_insight_states
     SET workflow_state = 'resolved',
         snoozed_until = NULL,
         resolved_at = COALESCE(resolved_at, datetime('now')),
         updated_at = datetime('now')
     WHERE church_id = ?
       AND workflow_state <> 'resolved'
       AND decline_event_id IN (
         SELECT id
         FROM engagement_decline_events
         WHERE church_id = ?
           AND rules_version <> ?
       )`,
    [churchId, churchId, rulesVersion],
  );
  await conn.query(
    `UPDATE engagement_decline_deliveries
     SET state = 'cancelled',
         cancellation_reason = 'rules_version_retired',
         updated_at = datetime('now')
     WHERE church_id = ?
       AND state = 'pending'
       AND event_id IN (
         SELECT id
         FROM engagement_decline_events
         WHERE church_id = ?
           AND rules_version <> ?
       )`,
    [churchId, churchId, rulesVersion],
  );
}

async function retireSupersededPrimaryTransitionsWithConnection(
  conn,
  churchId,
  rulesVersion,
  throughWeekEnd,
) {
  const weekFilter = throughWeekEnd == null ? '' : 'AND confirmed_week_end <= ?';
  const params = [churchId, rulesVersion];
  if (throughWeekEnd != null) params.push(throughWeekEnd);
  return conn.query(
    `UPDATE engagement_tier_transitions
     SET decline_event_id = NULL,
         pastoral_processed_at = datetime('now')
     WHERE church_id = ?
       AND axis = 'primary'
       AND pastoral_processed_at IS NULL
       AND rules_version <> ?
       ${weekFilter}`,
    params,
  );
}

async function loadUnprocessedPrimaryTransitions(
  conn,
  churchId,
  rulesVersion,
  throughWeekEnd,
) {
  const weekFilter = throughWeekEnd == null ? '' : 'AND transition.confirmed_week_end <= ?';
  const params = [churchId, churchId, rulesVersion];
  if (throughWeekEnd != null) params.push(throughWeekEnd);
  return conn.query(
    `SELECT transition.id,
            transition.individual_id AS individualId,
            person.family_id AS familyId,
            transition.from_tier AS fromTier,
            transition.to_tier AS toTier,
            transition.confirmed_week_end AS confirmedWeekEnd,
            transition.rules_version AS rulesVersion,
            transition.long_term_attended AS longTermAttended,
            transition.long_term_opportunities AS longTermOpportunities,
            transition.long_term_rate AS longTermRate,
            transition.confirmation_attended AS confirmationAttended,
            transition.confirmation_opportunities AS confirmationOpportunities,
            transition.confirmation_rate AS confirmationRate
     FROM engagement_tier_transitions transition
     JOIN individuals person
       ON person.id = transition.individual_id
      AND person.church_id = ?
     WHERE transition.church_id = ?
       AND transition.axis = 'primary'
       AND transition.pastoral_processed_at IS NULL
       AND transition.reconstructed_at IS NULL
       AND transition.rules_version = ?
       ${weekFilter}
     ORDER BY transition.confirmed_week_end, transition.id`,
    params,
  );
}

async function existingDeclineEventId(conn, churchId, transition) {
  const rows = await conn.query(
    `SELECT id
     FROM engagement_decline_events
     WHERE church_id = ?
       AND individual_id = ?
       AND to_tier = ?
       AND effective_week_end = ?
       AND rules_version = ?
     LIMIT 1`,
    [
      churchId,
      transition.individualId,
      transition.toTier,
      transition.confirmedWeekEnd,
      transition.rulesVersion,
    ],
  );
  return rows[0]?.id ?? null;
}

async function recoverApplicableEvents(conn, churchId, transition) {
  const recoveredEventRows = await conn.query(
    `SELECT id
     FROM engagement_decline_events
     WHERE church_id = ?
       AND individual_id = ?
       AND rules_version = ?
       AND recovered_at IS NULL
       AND CASE to_tier
             WHEN 'irregular' THEN 0
             WHEN 'casual' THEN 1
             ELSE 2
           END < ?
     ORDER BY id`,
    [
      churchId,
      transition.individualId,
      transition.rulesVersion,
      TIER_RANK[transition.toTier],
    ],
  );
  if (recoveredEventRows.length === 0) return 0;

  const recoveredEventIds = recoveredEventRows.map((event) => event.id);
  const encodedIds = JSON.stringify(recoveredEventIds);
  const recovered = await conn.query(
    `UPDATE engagement_decline_events
     SET recovered_at = datetime('now')
     WHERE church_id = ?
       AND recovered_at IS NULL
       AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
    [churchId, encodedIds],
  );
  await conn.query(
    `UPDATE pastoral_insight_states
     SET workflow_state = 'resolved',
         snoozed_until = NULL,
         resolved_at = COALESCE(resolved_at, datetime('now')),
         updated_at = datetime('now')
     WHERE church_id = ?
       AND insight_type = 'primary_decline'
       AND workflow_state <> 'resolved'
       AND decline_event_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
    [churchId, encodedIds],
  );
  await conn.query(
    `UPDATE engagement_decline_deliveries
     SET state = 'cancelled',
         cancellation_reason = 'event_recovered',
         updated_at = datetime('now')
     WHERE church_id = ?
       AND state = 'pending'
       AND event_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
    [churchId, encodedIds],
  );
  return recovered.affectedRows;
}

async function markTransitionProcessed(conn, churchId, transitionId, declineEventId) {
  return conn.query(
    `UPDATE engagement_tier_transitions
     SET decline_event_id = ?,
         pastoral_processed_at = datetime('now')
     WHERE church_id = ?
       AND id = ?
       AND axis = 'primary'
       AND pastoral_processed_at IS NULL`,
    [declineEventId, churchId, transitionId],
  );
}

async function processConfirmedPrimaryTransitions(churchId, { throughWeekEnd } = {}) {
  if (!churchId) throw new Error('A church ID is required to process confirmed tier transitions.');

  return Database.transactionForChurch(churchId, async (conn) => {
    const rulesVersion = await loadCurrentRulesVersion(conn, churchId);
    await retireSupersededRulesWithConnection(conn, churchId, rulesVersion);
    const retiredTransitions = await retireSupersededPrimaryTransitionsWithConnection(
      conn,
      churchId,
      rulesVersion,
      throughWeekEnd,
    );
    const transitions = await loadUnprocessedPrimaryTransitions(
      conn,
      churchId,
      rulesVersion,
      throughWeekEnd,
    );
    const summary = {
      transitionsProcessed: retiredTransitions.affectedRows,
      eventsCreated: 0,
      eventsRecovered: 0,
      deliveriesCreated: 0,
    };

    for (const transition of transitions) {
      let declineEventId = null;
      if (TIER_RANK[transition.toTier] < TIER_RANK[transition.fromTier]) {
        const created = await createEligibleDeliveryRowsWithConnection(conn, {
          churchId,
          individualId: transition.individualId,
          familyId: transition.familyId,
          fromTier: transition.fromTier,
          toTier: transition.toTier,
          effectiveWeekEnd: transition.confirmedWeekEnd,
          rulesVersion: transition.rulesVersion,
          primaryAttended: transition.longTermAttended,
          primaryOpportunities: transition.longTermOpportunities,
          primaryRate: transition.longTermRate,
          confirmationAttended: transition.confirmationAttended,
          confirmationOpportunities: transition.confirmationOpportunities,
          confirmationRate: transition.confirmationRate,
        });
        declineEventId = created.eventId
          ?? await existingDeclineEventId(conn, churchId, transition);
        if (declineEventId == null) {
          throw new Error(`Failed to persist decline event for tier transition ${transition.id}.`);
        }
        summary.eventsCreated += created.eventCreated;
        summary.deliveriesCreated += created.deliveriesCreated;
      } else {
        summary.eventsRecovered += await recoverApplicableEvents(conn, churchId, transition);
      }

      const processed = await markTransitionProcessed(
        conn,
        churchId,
        transition.id,
        declineEventId,
      );
      summary.transitionsProcessed += processed.affectedRows;
    }

    return summary;
  });
}

async function evaluateEngagementDeclines(churchId, options = {}) {
  if (!churchId) throw new Error('A church ID is required to evaluate engagement declines.');
  const confirmation = await evaluateEngagementTierConfirmations(churchId, {
    asOf: options.asOf ?? new Date(),
    baselineOnly: options.baselineOnly ?? false,
  });
  const pastoral = await processConfirmedPrimaryTransitions(churchId, {
    throughWeekEnd: confirmation.completedWeekEnd,
  });
  return { ...confirmation, ...pastoral };
}

module.exports = {
  evaluateEngagementDeclines,
  processConfirmedPrimaryTransitions,
  createEligibleDeliveryRowsWithConnection,
};
