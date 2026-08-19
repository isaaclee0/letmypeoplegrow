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

  const [subject] = await conn.query(
    `SELECT i.id
     FROM individuals i
     WHERE i.id = ?
       AND i.church_id = ?
       AND i.family_id = ?
       AND i.is_active = 1
       AND i.people_type = 'regular'`,
    [individualId, churchId, familyId],
  );
  if (!subject) return creation;

  const recipients = await conn.query(
    `SELECT fc.id AS familyCaregiverId,
            fc.caregiver_type AS recipientType,
            CASE fc.caregiver_type
              WHEN 'user' THEN fc.user_id
              ELSE fc.contact_id
            END AS recipientId
     FROM family_caregivers fc
     LEFT JOIN users u
       ON fc.caregiver_type = 'user'
      AND u.id = fc.user_id
      AND u.church_id = ?
     LEFT JOIN contacts c
       ON fc.caregiver_type = 'contact'
      AND c.id = fc.contact_id
      AND c.church_id = ?
     WHERE fc.church_id = ?
       AND fc.family_id = ?
       AND (
         (fc.caregiver_type = 'user'
          AND u.is_active = 1
          AND u.email IS NOT NULL
          AND trim(u.email) <> ''
          AND u.email_notifications = 1)
         OR
         (fc.caregiver_type = 'contact'
          AND c.is_active = 1
          AND c.email IS NOT NULL
          AND trim(c.email) <> ''
          AND c.primary_contact_method = 'email')
       )
     ORDER BY fc.id`,
    [churchId, churchId, churchId, familyId],
  );

  let created = 0;
  for (const recipient of recipients) {
    const result = await conn.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id,
          family_caregiver_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
       ON CONFLICT(church_id, event_id, recipient_type, recipient_id) DO NOTHING`,
      [
        churchId,
        inserted.insertId,
        recipient.recipientType,
        recipient.recipientId,
        recipient.familyCaregiverId,
      ],
    );
    created += result.affectedRows;
  }
  creation.deliveriesCreated = created;
  return creation;
}

async function upsertBaselineState(conn, {
  churchId,
  individualId,
  rulesVersion,
  completedWeekEnd,
  currentTier,
  activeTier,
}) {
  await conn.query(
    `INSERT INTO engagement_evaluation_state
       (church_id, individual_id, rules_version, last_evaluated_week_end,
        current_tier, active_lowest_decline_tier, baseline_suppressed,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(church_id, individual_id) DO UPDATE SET
       rules_version = excluded.rules_version,
       last_evaluated_week_end = excluded.last_evaluated_week_end,
       current_tier = excluded.current_tier,
       active_lowest_decline_tier = excluded.active_lowest_decline_tier,
       baseline_suppressed = excluded.baseline_suppressed,
       updated_at = datetime('now')`,
    [
      churchId,
      individualId,
      rulesVersion,
      completedWeekEnd,
      currentTier,
      activeTier,
      activeTier === null ? 0 : 1,
    ],
  );
}

async function openEvents(conn, { churchId, individualId, rulesVersion }) {
  return conn.query(
    `SELECT id, to_tier AS toTier
     FROM engagement_decline_events
     WHERE church_id = ?
       AND individual_id = ?
       AND rules_version = ?
       AND recovered_at IS NULL
     ORDER BY CASE to_tier
       WHEN 'irregular' THEN 0
       WHEN 'casual' THEN 1
       ELSE 2
     END, id DESC`,
    [churchId, individualId, rulesVersion],
  );
}

async function recoverSurpassedEvents(conn, {
  churchId,
  individualId,
  rulesVersion,
  currentTier,
  baselineSuppressed,
}) {
  const before = await openEvents(conn, { churchId, individualId, rulesVersion });
  let recovered = 0;
  for (const event of before) {
    if (TIER_RANK[event.toTier] >= TIER_RANK[currentTier]) continue;
    const result = await conn.query(
      `UPDATE engagement_decline_events
       SET recovered_at = datetime('now')
       WHERE id = ? AND church_id = ? AND recovered_at IS NULL`,
      [event.id, churchId],
    );
    recovered += result.affectedRows;
  }

  const remaining = await openEvents(conn, { churchId, individualId, rulesVersion });
  if (remaining.length > 0) {
    return {
      activeTier: remaining[0].toTier,
      baselineSuppressed,
      recovered,
    };
  }

  const returnsToSuppressedTier = baselineSuppressed === 1 && currentTier !== 'core';
  return {
    activeTier: returnsToSuppressedTier ? currentTier : null,
    baselineSuppressed: returnsToSuppressedTier ? 1 : 0,
    recovered,
  };
}

async function persistState(conn, {
  churchId,
  individualId,
  rulesVersion,
  completedWeekEnd,
  currentTier,
  activeTier,
  baselineSuppressed,
}) {
  await conn.query(
    `UPDATE engagement_evaluation_state
     SET rules_version = ?,
         last_evaluated_week_end = ?,
         current_tier = ?,
         active_lowest_decline_tier = ?,
         baseline_suppressed = ?,
         updated_at = datetime('now')
     WHERE church_id = ? AND individual_id = ?`,
    [
      rulesVersion,
      completedWeekEnd,
      currentTier,
      activeTier,
      baselineSuppressed,
      churchId,
      individualId,
    ],
  );
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

    for (const [individualId, profile] of profiles.current) {
      const comparison = profiles.comparison.get(individualId);
      const currentTier = classifiedTier(profile.primary.status);
      const comparisonTier = classifiedTier(comparison?.primary?.status);
      const [state] = await conn.query(
        `SELECT rules_version AS rulesVersion,
                last_evaluated_week_end AS lastEvaluatedWeekEnd,
                current_tier AS currentTier,
                active_lowest_decline_tier AS activeTier,
                baseline_suppressed AS baselineSuppressed
         FROM engagement_evaluation_state
         WHERE church_id = ? AND individual_id = ?`,
        [churchId, individualId],
      );

      if (!state || state.rulesVersion !== rulesVersion) {
        const activeTier = isDecline(currentTier, comparisonTier) ? currentTier : null;
        await upsertBaselineState(conn, {
          churchId,
          individualId,
          rulesVersion,
          completedWeekEnd,
          currentTier,
          activeTier,
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
        const recovery = await recoverSurpassedEvents(conn, {
          churchId,
          individualId,
          rulesVersion,
          currentTier,
          baselineSuppressed,
        });
        activeTier = recovery.activeTier;
        baselineSuppressed = recovery.baselineSuppressed;
        summary.eventsRecovered += recovery.recovered;
      } else if (isDecline(currentTier, comparisonTier)
          && isDecline(currentTier, state.currentTier)
          && (activeTier === null || TIER_RANK[currentTier] < TIER_RANK[activeTier])) {
        const creation = await createEligibleDeliveryRowsWithConnection(conn, {
          churchId,
          individualId,
          familyId: profile.familyId,
          fromTier: comparisonTier,
          toTier: currentTier,
          effectiveWeekEnd: completedWeekEnd,
          rulesVersion,
        });
        summary.eventsCreated += creation.eventCreated;
        summary.deliveriesCreated += creation.deliveriesCreated;
        activeTier = currentTier;
      }

      await persistState(conn, {
        churchId,
        individualId,
        rulesVersion,
        completedWeekEnd,
        currentTier,
        activeTier,
        baselineSuppressed,
      });
    }

    return summary;
  });
}

module.exports = {
  evaluateEngagementDeclines,
  createEligibleDeliveryRowsWithConnection,
};
