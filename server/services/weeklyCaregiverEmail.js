'use strict';

const Database = require('../config/database');
const { sendWeeklyCaregiverDigestEmail } = require('../utils/email');
const { calculateConsecutiveAbsenceStreaks } = require('./attendancePeriodStreaks');
const { getPastoralInsights } = require('./engagement/pastoral');
const { getEngagementWindow } = require('./engagement/opportunities');

const recipientKey = (type, id) => `${type}:${id}`;

function formattedFamilyName(rawName = '') {
  const surname = (rawName.split(',')[0] || rawName).trim();
  return surname
    ? `${surname.charAt(0).toUpperCase()}${surname.slice(1).toLowerCase()} family`
    : 'Family';
}

function addCard(digests, caregiver, card, deliveryId = null) {
  const emailKey = caregiver.email.trim().toLowerCase();
  let digest = digests.get(emailKey);
  if (!digest) {
    digest = {
      caregiver: { email: caregiver.email, first_name: caregiver.firstName, last_name: caregiver.lastName },
      recipientIds: [], entries: [], deliveryIds: [],
    };
    digests.set(emailKey, digest);
  }
  const key = recipientKey(caregiver.type, caregiver.id);
  if (!digest.recipientIds.some((recipient) => recipientKey(recipient.type, recipient.id) === key)) {
    digest.recipientIds.push({ type: caregiver.type, id: caregiver.id });
  }
  let existing = digest.entries.find((entry) => entry.personId === card.personId
    && entry.familyId === card.familyId);
  if (!existing) {
    existing = { ...card, recipientIds: [] };
    digest.entries.push(existing);
  } else {
    for (const reason of card.reasons) {
      const reasonKey = reason.type === 'primary_tier_decline'
        ? `${reason.type}:${reason.eventId}` : reason.type;
      if (!existing.reasons.some((candidate) => (candidate.type === 'primary_tier_decline'
        ? `${candidate.type}:${candidate.eventId}` : candidate.type) === reasonKey)) {
        existing.reasons.push(reason);
      }
    }
    if (existing.eventId == null && card.eventId != null) existing.eventId = card.eventId;
  }
  if (!existing.recipientIds.some((recipient) => recipientKey(recipient.type, recipient.id) === key)) {
    existing.recipientIds.push({ type: caregiver.type, id: caregiver.id });
  }
  if (deliveryId != null && !digest.deliveryIds.includes(deliveryId)) digest.deliveryIds.push(deliveryId);
}

async function loadAbsenceCards(churchId, threshold) {
  const caregivers = await Database.query(
    `SELECT fc.family_id AS familyId, fc.caregiver_type AS type,
            CASE fc.caregiver_type WHEN 'user' THEN u.id ELSE c.id END AS id,
            CASE fc.caregiver_type WHEN 'user' THEN u.first_name ELSE c.first_name END AS firstName,
            CASE fc.caregiver_type WHEN 'user' THEN u.last_name ELSE c.last_name END AS lastName,
            CASE fc.caregiver_type WHEN 'user' THEN u.email ELSE c.email END AS email
     FROM family_caregivers fc
     LEFT JOIN users u ON fc.caregiver_type = 'user' AND u.id = fc.user_id AND u.church_id = ?
     LEFT JOIN contacts c ON fc.caregiver_type = 'contact' AND c.id = fc.contact_id AND c.church_id = ?
     WHERE fc.church_id = ?
       AND ((fc.caregiver_type = 'user' AND u.is_active = 1
             AND u.email IS NOT NULL AND trim(u.email) <> '' AND u.email_notifications = 1)
         OR (fc.caregiver_type = 'contact' AND c.is_active = 1
             AND c.email IS NOT NULL AND trim(c.email) <> '' AND c.primary_contact_method = 'email'))
     ORDER BY fc.id`,
    [churchId, churchId, churchId],
  );
  if (caregivers.length === 0) return [];
  const familyIds = [...new Set(caregivers.map((row) => row.familyId))];
  const familyPlaceholders = familyIds.map(() => '?').join(',');
  const members = await Database.query(
    `SELECT i.id, i.first_name AS firstName, i.last_name AS lastName,
            i.family_id AS familyId, f.family_name AS familyName
     FROM individuals i JOIN families f ON f.id = i.family_id AND f.church_id = ?
     WHERE i.family_id IN (${familyPlaceholders}) AND i.church_id = ?
       AND i.people_type = 'regular' AND i.is_active = 1 ORDER BY i.id`,
    [churchId, ...familyIds, churchId],
  );
  if (members.length === 0) return [];
  const sessions = await Database.query(
    `WITH ranked_sessions AS (
       SELECT s.id, s.session_date, s.gathering_type_id,
              gt.name AS gathering_name, gt.frequency,
              ROW_NUMBER() OVER (PARTITION BY s.gathering_type_id
                ORDER BY s.session_date DESC, s.id DESC) AS gathering_rank
       FROM attendance_sessions s JOIN gathering_types gt ON gt.id = s.gathering_type_id
       WHERE s.church_id = ? AND gt.church_id = ?
         AND gt.attendance_type = 'standard' AND gt.is_active = 1
         AND s.session_status = 'held'
         AND s.excluded_from_stats = 0
         AND (s.roster_provenance_version >= 1
              OR (s.roster_provenance_version = 0 AND s.roster_snapshotted = 1)))
     SELECT id, session_date, gathering_type_id, gathering_name, frequency
     FROM ranked_sessions WHERE gathering_rank <= 12 ORDER BY session_date DESC, id DESC`,
    [churchId, churchId],
  );
  if (sessions.length === 0) return [];
  const sessionIds = sessions.map((row) => row.id);
  const attendanceRows = await Database.query(
    `SELECT individual_id, session_id, present FROM attendance_records
     WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) AND church_id = ?`,
    [...sessionIds, churchId],
  );
  const streaks = calculateConsecutiveAbsenceStreaks({
    sessions, attendanceRows, individualIds: members.map((member) => member.id), maxPeriods: 12,
  });
  const absent = members.filter((member) => (streaks.get(Number(member.id)) || 0) >= threshold);
  if (absent.length === 0) return [];
  const ids = absent.map((member) => member.id);
  const history = await Database.query(
    `SELECT ar.individual_id AS individualId, s.session_date AS date, gt.name AS gatheringName
     FROM attendance_records ar
     JOIN attendance_sessions s ON s.id = ar.session_id AND s.church_id = ?
     JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.church_id = ?
     WHERE ar.individual_id IN (${ids.map(() => '?').join(',')}) AND ar.church_id = ?
       AND ar.present = 1 AND gt.attendance_type = 'standard'
       AND s.session_status = 'held' AND s.excluded_from_stats = 0
       AND (s.roster_provenance_version >= 1
            OR (s.roster_provenance_version = 0 AND s.roster_snapshotted = 1))
     ORDER BY s.session_date DESC, s.id DESC`,
    [churchId, churchId, ...ids, churchId],
  );
  const presentByPerson = new Map();
  for (const row of history) {
    const values = presentByPerson.get(row.individualId) || [];
    if (values.length < 3) values.push({ date: row.date, gatheringName: row.gatheringName });
    presentByPerson.set(row.individualId, values);
  }
  const caregiversByFamily = new Map();
  for (const caregiver of caregivers) {
    const values = caregiversByFamily.get(caregiver.familyId) || [];
    values.push(caregiver);
    caregiversByFamily.set(caregiver.familyId, values);
  }
  return absent.flatMap((member) => {
    const streak = streaks.get(Number(member.id));
    const lastAttendances = presentByPerson.get(member.id) || [];
    const gatheringName = sessions[0]?.gathering_name || null;
    const card = {
      type: 'individual', personId: member.id, familyId: member.familyId, eventId: null,
      name: `${member.firstName} ${member.lastName}`,
      familyName: formattedFamilyName(member.familyName), streak, gatheringName, lastAttendances,
      reasons: [{
        type: 'consecutive_absence', streak, gatheringName,
        lastPresentDates: lastAttendances.map((attendance) => attendance.date),
      }],
    };
    return (caregiversByFamily.get(member.familyId) || []).map((caregiver) => ({ caregiver, card }));
  });
}

function cancellationReason(row) {
  if (row.recoveredAt != null) return 'event_recovered';
  if (Number(row.personActive) !== 1 || row.peopleType !== 'regular') return 'person_ineligible';
  if (row.currentFamilyId !== row.familyAtDetectionId) return 'family_changed';
  if (row.assignmentId == null || row.assignmentFamilyId !== row.familyAtDetectionId
      || row.assignmentType !== row.recipientType
      || row.assignmentRecipientId !== row.recipientId) return 'assignment_removed';
  if (Number(row.recipientActive) !== 1 || !row.email?.trim()
      || (row.recipientType === 'user' && Number(row.emailNotifications) !== 1)
      || (row.recipientType === 'contact' && row.primaryContactMethod !== 'email')) {
    return 'recipient_ineligible';
  }
  if (row.workflowState === 'dismissed') return 'pastoral_dismissed';
  if (row.workflowState === 'resolved' || row.workflowState == null) return 'pastoral_resolved';
  return null;
}

async function loadPendingDeclineCards(churchId, { now, mutateDeliveryState }) {
  const pastoral = await getPastoralInsights(churchId, { asOf: now, includeAll: true, includeSnoozed: true });
  const rows = await Database.query(
    `SELECT d.id AS deliveryId, d.recipient_type AS recipientType, d.recipient_id AS recipientId,
            e.id AS eventId, e.individual_id AS personId,
            e.family_at_detection_id AS familyAtDetectionId, e.from_tier AS fromTier,
            e.to_tier AS toTier, e.effective_week_end AS effectiveWeekEnd,
            e.recovered_at AS recoveredAt, i.first_name AS personFirstName,
            i.last_name AS personLastName, i.family_id AS currentFamilyId,
            i.is_active AS personActive, i.people_type AS peopleType, f.family_name AS familyName,
            fc.id AS assignmentId, fc.family_id AS assignmentFamilyId,
            fc.caregiver_type AS assignmentType,
            CASE fc.caregiver_type WHEN 'user' THEN fc.user_id ELSE fc.contact_id END AS assignmentRecipientId,
            CASE d.recipient_type WHEN 'user' THEN u.first_name ELSE c.first_name END AS recipientFirstName,
            CASE d.recipient_type WHEN 'user' THEN u.last_name ELSE c.last_name END AS recipientLastName,
            CASE d.recipient_type WHEN 'user' THEN u.email ELSE c.email END AS email,
            CASE d.recipient_type WHEN 'user' THEN u.is_active ELSE c.is_active END AS recipientActive,
            u.email_notifications AS emailNotifications, c.primary_contact_method AS primaryContactMethod,
            pis.workflow_state AS workflowState
     FROM engagement_decline_deliveries d
     JOIN engagement_decline_events e ON e.id = d.event_id AND e.church_id = ?
     LEFT JOIN individuals i ON i.id = e.individual_id AND i.church_id = ?
     LEFT JOIN families f ON f.id = i.family_id AND f.church_id = ?
     LEFT JOIN family_caregivers fc ON fc.id = d.family_caregiver_id AND fc.church_id = ?
     LEFT JOIN users u ON d.recipient_type = 'user' AND u.id = d.recipient_id AND u.church_id = ?
     LEFT JOIN contacts c ON d.recipient_type = 'contact' AND c.id = d.recipient_id AND c.church_id = ?
     LEFT JOIN pastoral_insight_states pis ON pis.decline_event_id = e.id
       AND pis.church_id = ? AND pis.insight_type = 'primary_decline'
     WHERE d.church_id = ? AND d.state = 'pending' ORDER BY d.id`,
    [churchId, churchId, churchId, churchId, churchId, churchId, churchId, churchId],
  );
  const output = [];
  for (const row of rows) {
    const reason = cancellationReason(row);
    if (reason) {
      if (mutateDeliveryState) {
        await Database.query(
          `UPDATE engagement_decline_deliveries SET state = 'cancelled', cancellation_reason = ?,
             updated_at = datetime('now') WHERE church_id = ? AND id = ? AND state = 'pending'`,
          [reason, churchId, row.deliveryId],
        );
      }
      continue;
    }
    if (row.workflowState !== 'open') continue;
    const insight = pastoral.insights.find((item) => item.type === 'primary_decline'
      && item.declineEventId === row.eventId);
    if (!insight) continue;
    output.push({
      caregiver: {
        type: row.recipientType, id: row.recipientId, email: row.email,
        firstName: row.recipientFirstName, lastName: row.recipientLastName,
      },
      deliveryId: row.deliveryId,
      card: {
        type: 'individual', personId: row.personId, familyId: row.currentFamilyId,
        eventId: row.eventId, name: `${row.personFirstName} ${row.personLastName}`,
        familyName: formattedFamilyName(row.familyName),
        reasons: [{
          type: 'primary_tier_decline', eventId: row.eventId,
          fromTier: row.fromTier, toTier: row.toTier,
          effectiveWeekEnd: row.effectiveWeekEnd,
          opportunityEvidence: insight.profiles.primary,
        }],
      },
    });
  }
  return { cards: output, completedWeekEnd: pastoral.window.completedWeekEnd };
}

async function generateCaregiverDigests(churchId, options = {}) {
  const now = options.now || new Date();
  const [settings] = await Database.query(
    `SELECT church_name, caregiver_absence_threshold, timezone
     FROM church_settings WHERE church_id = ? LIMIT 1`, [churchId],
  );
  if (!settings) return [];
  const digests = new Map();
  if (options.includeAbsences !== false) {
    for (const item of await loadAbsenceCards(churchId, settings.caregiver_absence_threshold ?? 3)) {
      addCard(digests, item.caregiver, item.card);
    }
  }
  let completedWeekEnd = getEngagementWindow(now, settings.timezone || 'UTC').completedWeekEnd;
  if (options.includePendingDeclines !== false) {
    const declines = await loadPendingDeclineCards(churchId, {
      now, mutateDeliveryState: options.mutateDeliveryState !== false,
    });
    completedWeekEnd = declines.completedWeekEnd;
    for (const item of declines.cards) addCard(digests, item.caregiver, item.card, item.deliveryId);
  }
  for (const digest of digests.values()) {
    digest.completedWeekEnd = completedWeekEnd;
    digest.recipientIds.sort((left, right) => left.type === right.type
      ? left.id - right.id : (left.type === 'user' ? -1 : 1));
    digest.entries.sort((left, right) => left.name.localeCompare(right.name)
      || left.personId - right.personId);
  }
  return [...digests.values()];
}

async function updateAttempt(churchId, deliveryIds, success, error) {
  for (const deliveryId of deliveryIds) {
    if (success) {
      await Database.query(
        `UPDATE engagement_decline_deliveries SET state = 'delivered', attempts = attempts + 1,
           last_attempt_at = datetime('now'), last_error = NULL, delivered_at = datetime('now'),
           updated_at = datetime('now') WHERE church_id = ? AND id = ? AND state = 'pending'`,
        [churchId, deliveryId],
      );
    } else {
      await Database.query(
        `UPDATE engagement_decline_deliveries SET attempts = attempts + 1,
           last_attempt_at = datetime('now'), last_error = ?, updated_at = datetime('now')
         WHERE church_id = ? AND id = ? AND state = 'pending'`,
        [String(error?.message || error || 'Email provider failed'), churchId, deliveryId],
      );
    }
  }
}

async function sendWeeklyCaregiverDigests(churchId, options = {}) {
  const now = options.now || new Date();
  const testMode = options.testMode === true;
  const emailProvider = options.sendEmail || sendWeeklyCaregiverDigestEmail;
  let sent = 0;
  try {
    const [settings] = await Database.query(
      `SELECT church_name, timezone FROM church_settings WHERE church_id = ? LIMIT 1`, [churchId],
    );
    if (!settings) return 0;
    const digests = await generateCaregiverDigests(churchId, {
      now,
      includeAbsences: options.includeAbsences,
      mutateDeliveryState: !testMode,
    });
    for (const digest of digests) {
      const firstRecipient = digest.recipientIds[0];
      const messageKey = firstRecipient
        ? `engagement-digest:${churchId}:${firstRecipient.type}:${firstRecipient.id}:${digest.completedWeekEnd}`
        : undefined;
      try {
        await emailProvider(digest.caregiver.email, digest.caregiver.first_name,
          settings.church_name, digest.entries, {
            timeZone: settings.timezone || 'UTC', now, testMode, messageKey,
            recipientIds: digest.recipientIds,
          });
        if (!testMode) await updateAttempt(churchId, digest.deliveryIds, true);
        sent += 1;
      } catch (error) {
        if (!testMode) await updateAttempt(churchId, digest.deliveryIds, false, error);
        console.error(`Caregiver digest: Failed to send to ${digest.caregiver.email}:`, error.message);
      }
    }
  } catch (error) {
    console.error(`Caregiver digest: Error for church ${churchId}:`, error.message);
  }
  return sent;
}

module.exports = { generateCaregiverDigests, sendWeeklyCaregiverDigests };
