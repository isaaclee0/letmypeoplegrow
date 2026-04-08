const Database = require('../config/database');
const { sendEmail, sendCaregiverNotificationEmail } = require('./email');
const { sendNotificationSMS } = require('./sms');

/**
 * Triggered after an attendance session is saved.
 * Evaluates active notification rules and dispatches notifications to:
 *   1. Configured app users (existing behaviour)
 *   2. Family caregivers (new: users + contacts assigned to the individual's family)
 */
async function triggerAttendanceNotifications(gatheringTypeId, sessionDate) {
  try {
    // Fetch rules scoped to this gathering type, plus global rules (gathering_type_id IS NULL)
    const rules = await Database.query(
      `SELECT * FROM notification_rules
       WHERE is_active = 1
         AND (gathering_type_id = ? OR gathering_type_id IS NULL)`,
      [gatheringTypeId]
    );
    if (!rules.length) return;

    // Get the most recent sessions for this gathering type
    const maxThreshold = Math.max(...rules.map(r => r.threshold_count));
    const recentSessions = await Database.query(
      `SELECT id, session_date FROM attendance_sessions
       WHERE gathering_type_id = ? AND excluded_from_stats = 0
       ORDER BY session_date DESC LIMIT ?`,
      [gatheringTypeId, maxThreshold]
    );

    for (const rule of rules) {
      const { id: ruleId, created_by, target_group, trigger_event, threshold_count } = rule;

      if (recentSessions.length < threshold_count) continue;
      if (target_group !== 'regular_attendees') continue;

      const sessionIds = recentSessions.slice(0, threshold_count).map(s => s.id);
      const placeholders = sessionIds.map(() => '?').join(',');
      const presentValue = trigger_event === 'attends' ? 1 : 0;

      // Find individuals on the roster who match the consecutive pattern
      const matches = await Database.query(
        `SELECT i.id, i.first_name, i.last_name, i.family_id,
                COUNT(ar.id) as match_count
         FROM individuals i
         JOIN gathering_lists gl ON i.id = gl.individual_id AND gl.gathering_type_id = ?
         LEFT JOIN attendance_records ar
           ON i.id = ar.individual_id
           AND ar.session_id IN (${placeholders})
           AND ar.present = ?
         WHERE i.is_active = 1
         GROUP BY i.id
         HAVING match_count >= ?`,
        [gatheringTypeId, ...sessionIds, presentValue, threshold_count]
      );

      for (const individual of matches) {
        // --- 1. Notify the rule creator (app user) ---
        const existingNotification = await Database.query(
          `SELECT id FROM notifications
           WHERE user_id = ? AND rule_id = ? AND reference_id = ?
             AND created_at > datetime('now', '-7 days')`,
          [created_by, ruleId, individual.id]
        );
        if (!existingNotification.length) {
          const title = trigger_event === 'misses'
            ? `Missed ${threshold_count} in a row`
            : `Attended ${threshold_count} in a row`;
          const message = `${individual.first_name} ${individual.last_name} has ${trigger_event === 'misses' ? 'missed' : 'attended'} ${threshold_count} consecutive sessions.`;

          await Database.query(
            `INSERT INTO notifications (user_id, rule_id, title, message, notification_type, reference_type, reference_id, church_id)
             VALUES (?, ?, ?, ?, 'attendance_pattern', 'individual', ?, ?)`,
            [created_by, ruleId, title, message, individual.id, rule.church_id]
          );

          const [notifyUser] = await Database.query(
            `SELECT * FROM users WHERE id = ?`,
            [created_by]
          );
          if (notifyUser) {
            if (notifyUser.email_notifications && notifyUser.email) {
              try {
                await sendEmail(
                  notifyUser.email,
                  title,
                  `<p>${message}</p>`,
                  message
                );
              } catch (e) { console.error('Failed to send notification email to user:', e); }
            }
            if (notifyUser.sms_notifications && notifyUser.mobile_number) {
              try {
                await sendNotificationSMS(notifyUser.mobile_number, title, message);
              } catch (e) { console.error('Failed to send notification SMS to user:', e); }
            }
          }
        }

        // --- 2. Notify family caregivers ---
        if (!individual.family_id) continue;

        const caregivers = await Database.query(
          `SELECT
             fc.id as assignment_id,
             fc.caregiver_type,
             fc.user_id,
             fc.contact_id,
             CASE fc.caregiver_type WHEN 'user' THEN u.first_name ELSE c.first_name END as first_name,
             CASE fc.caregiver_type WHEN 'user' THEN u.last_name ELSE c.last_name END as last_name,
             CASE fc.caregiver_type WHEN 'user' THEN u.email ELSE c.email END as email,
             CASE fc.caregiver_type WHEN 'user' THEN u.mobile_number ELSE c.mobile_number END as mobile_number,
             CASE fc.caregiver_type WHEN 'user' THEN u.primary_contact_method ELSE c.primary_contact_method END as primary_contact_method,
             CASE fc.caregiver_type WHEN 'user' THEN u.email_notifications ELSE 1 END as email_notifications,
             CASE fc.caregiver_type WHEN 'user' THEN u.sms_notifications ELSE 0 END as sms_notifications
           FROM family_caregivers fc
           LEFT JOIN users u ON fc.user_id = u.id AND u.church_id = ?
           LEFT JOIN contacts c ON fc.contact_id = c.id AND c.is_active = 1
           WHERE fc.family_id = ? AND fc.church_id = ?`,
          [rule.church_id, individual.family_id, rule.church_id]
        );

        const [family] = await Database.query(
          `SELECT id, family_name FROM families WHERE id = ?`,
          [individual.family_id]
        );

        const [gatheringTypeRow] = await Database.query(
          `SELECT name FROM gathering_types WHERE id = ?`,
          [gatheringTypeId]
        );
        const gatheringTypeName = gatheringTypeRow?.name || 'their gathering';

        for (const caregiver of caregivers) {
          if (caregiver.caregiver_type === 'user') {
            // User caregivers: insert in-app notification (with dedup)
            const existingCaregiverNotif = await Database.query(
              `SELECT id FROM notifications
               WHERE user_id = ? AND rule_id = ? AND reference_id = ?
                 AND created_at > datetime('now', '-7 days')`,
              [caregiver.user_id, ruleId, individual.id]
            );
            if (existingCaregiverNotif.length) continue;

            const title = `Follow up: ${individual.first_name} ${individual.last_name}`;
            const message = `${individual.first_name} ${individual.last_name} has missed ${threshold_count} consecutive ${gatheringTypeName} sessions.`;
            await Database.query(
              `INSERT INTO notifications (user_id, rule_id, title, message, notification_type, reference_type, reference_id, church_id)
               VALUES (?, ?, ?, ?, 'attendance_pattern', 'individual', ?, ?)`,
              [caregiver.user_id, ruleId, title, message, individual.id, rule.church_id]
            );
          } else {
            // Contact caregivers: log + send email/SMS (with dedup)
            const existingContactNotif = await Database.query(
              `SELECT id FROM contact_notifications
               WHERE contact_id = ? AND individual_id = ? AND rule_id = ?
                 AND created_at > datetime('now', '-7 days')`,
              [caregiver.contact_id, individual.id, ruleId]
            );
            if (existingContactNotif.length) continue;

            const title = `Follow up: ${individual.first_name} ${individual.last_name}`;
            const message = `${individual.first_name} ${individual.last_name} has missed ${threshold_count} consecutive ${gatheringTypeName} sessions.`;

            let emailSent = 0;
            let smsSent = 0;

            if (caregiver.email && caregiver.primary_contact_method === 'email') {
              try {
                await sendCaregiverNotificationEmail(
                  caregiver, individual, family, threshold_count, gatheringTypeName
                );
                emailSent = 1;
              } catch (e) {
                console.error(`Failed to send caregiver email to ${caregiver.email}:`, e);
              }
            }
            if (caregiver.mobile_number && caregiver.primary_contact_method === 'sms') {
              try {
                await sendNotificationSMS(
                  caregiver.mobile_number,
                  'Attendance follow-up',
                  `Hi ${caregiver.first_name}, just a heads-up — ${individual.first_name} ${individual.last_name} has missed ${threshold_count} consecutive ${gatheringTypeName} sessions.`
                );
                smsSent = 1;
              } catch (e) {
                console.error(`Failed to send caregiver SMS to ${caregiver.mobile_number}:`, e);
              }
            }

            await Database.query(
              `INSERT INTO contact_notifications (church_id, contact_id, family_id, individual_id, rule_id, title, message, email_sent, sms_sent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [rule.church_id, caregiver.contact_id, individual.family_id, individual.id, ruleId, title, message, emailSent, smsSent]
            );
          }
        }
      }
    }
  } catch (error) {
    console.error('Error triggering attendance notifications:', error);
  }
}

module.exports = { triggerAttendanceNotifications };
