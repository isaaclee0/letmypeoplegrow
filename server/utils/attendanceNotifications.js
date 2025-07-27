const Database = require('../config/database');
const { sendNotificationEmail } = require('./email');
const { sendNotificationSMS } = require('./sms');

async function triggerAttendanceNotifications(gatheringTypeId, sessionDate) {
  try {
    // Get active rules for this gathering or global
    const rules = await Database.query(
      `SELECT * FROM notification_rules WHERE is_active = true AND (gathering_type_id = ? OR gathering_type_id IS NULL)` ,
      [gatheringTypeId]
    );

    for (const rule of rules) {
      const { id: ruleId, created_by, target_group, trigger_event, threshold_count, timeframe_periods } = rule;

      // Get recent sessions for this gathering
      const recentSessions = await Database.query(
        `SELECT id, session_date FROM attendance_sessions WHERE gathering_type_id = ? ORDER BY session_date DESC LIMIT ?` ,
        [gatheringTypeId, threshold_count]
      );
      if (recentSessions.length < threshold_count) continue;

      const sessionIds = recentSessions.map(s => s.id);

      let query;
      if (target_group === 'regular_attendees') {
        // Find individuals who match the pattern
        query = `
          SELECT i.id, i.first_name, i.last_name, COUNT(ar.id) as count
          FROM individuals i
          JOIN gathering_lists gl ON i.id = gl.individual_id
          LEFT JOIN attendance_records ar ON i.id = ar.individual_id AND ar.session_id IN (?) AND ar.present = ?
          WHERE gl.gathering_type_id = ?
          GROUP BY i.id
          HAVING count >= ?
        `;
        const presentValue = trigger_event === 'attends' ? true : false;
        const matches = await Database.query(query, [sessionIds, presentValue, gatheringTypeId, threshold_count]);

        for (const match of matches) {
          // Create notification
          await Database.query(
            `INSERT INTO notifications (user_id, rule_id, title, message, notification_type, reference_type, reference_id) VALUES (?, ?, ?, ?, 'attendance_pattern', 'individual', ?)` ,
            [created_by, ruleId, `${trigger_event.toUpperCase()} Threshold Reached`, `${match.first_name} ${match.last_name} has ${trigger_event} ${threshold_count} in a row.`, match.id]
          );

          // Send email/sms if configured (assuming user has preferences)
          const user = await Database.query(`SELECT * FROM users WHERE id = ?`, [created_by]);
          if (user[0].email_notifications && user[0].email) {
            await sendNotificationEmail(user[0].email, 'Attendance Notification', `${match.first_name} ${match.last_name} has ${trigger_event} ${threshold_count} in a row.`);
          }
          if (user[0].sms_notifications && user[0].mobile_number) {
            await sendNotificationSMS(user[0].mobile_number, 'Attendance Notification', `${match.first_name} ${match.last_name} has ${trigger_event} ${threshold_count} in a row.`);
          }
        }
      } // Add similar for potential_regular_visitors if needed
    }
  } catch (error) {
    console.error('Error triggering notifications:', error);
  }
}

module.exports = { triggerAttendanceNotifications }; 