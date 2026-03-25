const Database = require('../config/database');

/**
 * Generate weekly review data for a single church.
 * Must be called within a church context (Database.setChurchContext).
 *
 * @param {string} churchId
 * @returns {object|null} Review data, or null if no attendance was recorded
 */
async function generateWeeklyReviewData(churchId) {
  // Get church settings
  const settings = await Database.query(
    `SELECT church_name, timezone FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  if (settings.length === 0) return null;
  const churchName = settings[0].church_name;
  const timezone = settings[0].timezone || 'UTC';

  // Determine the week window: last 7 days from now
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const endDate = now.toISOString().split('T')[0];
  const startDate = weekAgo.toISOString().split('T')[0];

  // Get all active gathering types
  const gatherings = await Database.query(
    `SELECT id, name, attendance_type, day_of_week FROM gathering_types WHERE is_active = 1 AND church_id = ?`,
    [churchId]
  );

  if (gatherings.length === 0) return null;

  const gatheringStats = [];
  let totalAttendance = 0;
  let totalVisitors = 0;
  let totalLocalVisitors = 0;
  let hasAnyData = false;

  for (const gathering of gatherings) {
    // Get this week's session
    const sessions = await Database.query(
      `SELECT id, session_date, headcount_mode
       FROM attendance_sessions
       WHERE gathering_type_id = ? AND session_date >= ? AND session_date <= ? AND church_id = ?
       ORDER BY session_date DESC`,
      [gathering.id, startDate, endDate, churchId]
    );

    if (sessions.length === 0) continue;
    hasAnyData = true;

    const session = sessions[0]; // most recent session this week
    let count = 0;
    let visitorCount = 0;
    let localVisitorCount = 0;
    let travellerVisitorCount = 0;

    if (gathering.attendance_type === 'headcount') {
      // Headcount gathering
      const headcountRows = await Database.query(
        `SELECT headcount, updated_by FROM headcount_records WHERE session_id = ? AND church_id = ?`,
        [session.id, churchId]
      );
      const mode = session.headcount_mode || 'separate';
      if (headcountRows.length > 0) {
        if (mode === 'combined') {
          count = headcountRows.reduce((sum, r) => sum + r.headcount, 0);
        } else if (mode === 'averaged') {
          count = Math.round(headcountRows.reduce((sum, r) => sum + r.headcount, 0) / headcountRows.length);
        } else {
          // separate: use max
          count = Math.max(...headcountRows.map(r => r.headcount));
        }
      }
    } else {
      // Standard attendance
      const countResult = await Database.query(
        `SELECT
          COUNT(DISTINCT CASE WHEN ar.present = 1 THEN ar.individual_id END) as present_count,
          COUNT(DISTINCT CASE WHEN ar.present = 1 AND ar.people_type_at_time = 'local_visitor' THEN ar.individual_id END) as local_visitor_count,
          COUNT(DISTINCT CASE WHEN ar.present = 1 AND ar.people_type_at_time = 'traveller_visitor' THEN ar.individual_id END) as traveller_visitor_count
        FROM attendance_records ar
        WHERE ar.session_id = ? AND ar.church_id = ?`,
        [session.id, churchId]
      );
      count = countResult[0]?.present_count || 0;
      localVisitorCount = countResult[0]?.local_visitor_count || 0;
      travellerVisitorCount = countResult[0]?.traveller_visitor_count || 0;
      visitorCount = localVisitorCount + travellerVisitorCount;
    }

    // Get last 3 sessions before this week for average comparison
    const prevSessions = await Database.query(
      `SELECT id, session_date, headcount_mode
       FROM attendance_sessions
       WHERE gathering_type_id = ? AND session_date < ? AND church_id = ?
       ORDER BY session_date DESC LIMIT 3`,
      [gathering.id, startDate, churchId]
    );

    let avgPrevious = null;
    if (prevSessions.length > 0) {
      let prevTotal = 0;
      for (const ps of prevSessions) {
        if (gathering.attendance_type === 'headcount') {
          const hr = await Database.query(
            `SELECT headcount FROM headcount_records WHERE session_id = ? AND church_id = ?`,
            [ps.id, churchId]
          );
          const mode = ps.headcount_mode || 'separate';
          if (hr.length > 0) {
            if (mode === 'combined') {
              prevTotal += hr.reduce((s, r) => s + r.headcount, 0);
            } else if (mode === 'averaged') {
              prevTotal += Math.round(hr.reduce((s, r) => s + r.headcount, 0) / hr.length);
            } else {
              prevTotal += Math.max(...hr.map(r => r.headcount));
            }
          }
        } else {
          const cr = await Database.query(
            `SELECT COUNT(DISTINCT CASE WHEN present = 1 THEN individual_id END) as cnt
             FROM attendance_records WHERE session_id = ? AND church_id = ?`,
            [ps.id, churchId]
          );
          prevTotal += cr[0]?.cnt || 0;
        }
      }
      avgPrevious = Math.round(prevTotal / prevSessions.length);
    }

    let delta = null;
    let deltaPercent = null;
    if (avgPrevious !== null && avgPrevious > 0) {
      delta = count - avgPrevious;
      deltaPercent = Math.round((delta / avgPrevious) * 100);
    }

    totalAttendance += count;
    totalVisitors += visitorCount;
    totalLocalVisitors += localVisitorCount;

    gatheringStats.push({
      name: gathering.name,
      date: session.session_date,
      attendanceType: gathering.attendance_type,
      count,
      visitorCount,
      localVisitorCount,
      travellerVisitorCount,
      avgPrevious,
      delta,
      deltaPercent
    });
  }

  if (!hasAnyData) return null;

  // Get recipients: admins and coordinators with email_notifications=1 and valid email
  const recipients = await Database.query(
    `SELECT id, first_name, last_name, email
     FROM users
     WHERE role IN ('admin', 'coordinator')
       AND is_active = 1
       AND email_notifications = 1
       AND email IS NOT NULL
       AND email != ''
       AND church_id = ?`,
    [churchId]
  );

  // Get last 8 weeks of weekly totals for AI insight context
  const eightWeeksAgo = new Date(now);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const weeklyTotals = await getWeeklyTotals(churchId, eightWeeksAgo.toISOString().split('T')[0], endDate);

  return {
    churchName,
    timezone,
    weekStartDate: startDate,
    weekEndDate: endDate,
    gatherings: gatheringStats,
    totalAttendance,
    totalVisitors,
    totalLocalVisitors,
    recipients,
    weeklyTotals
  };
}

/**
 * Get weekly attendance totals for trend analysis.
 */
async function getWeeklyTotals(churchId, startDate, endDate) {
  // Get all sessions in range grouped by week
  const sessions = await Database.query(
    `SELECT as_t.id, as_t.session_date, as_t.headcount_mode, gt.attendance_type
     FROM attendance_sessions as_t
     JOIN gathering_types gt ON gt.id = as_t.gathering_type_id
     WHERE as_t.session_date >= ? AND as_t.session_date <= ? AND as_t.church_id = ?
     ORDER BY as_t.session_date`,
    [startDate, endDate, churchId]
  );

  // Group by ISO week
  const weekMap = new Map();
  for (const s of sessions) {
    const d = new Date(s.session_date);
    // Get Monday of the week
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(d.setDate(diff)).toISOString().split('T')[0];

    if (!weekMap.has(weekStart)) weekMap.set(weekStart, []);
    weekMap.get(weekStart).push(s);
  }

  const totals = [];
  for (const [weekStart, weekSessions] of weekMap) {
    let total = 0;
    for (const s of weekSessions) {
      if (s.attendance_type === 'headcount') {
        const hr = await Database.query(
          `SELECT headcount FROM headcount_records WHERE session_id = ? AND church_id = ?`,
          [s.id, churchId]
        );
        if (hr.length > 0) {
          const mode = s.headcount_mode || 'separate';
          if (mode === 'combined') total += hr.reduce((sum, r) => sum + r.headcount, 0);
          else if (mode === 'averaged') total += Math.round(hr.reduce((sum, r) => sum + r.headcount, 0) / hr.length);
          else total += Math.max(...hr.map(r => r.headcount));
        }
      } else {
        const cr = await Database.query(
          `SELECT COUNT(DISTINCT CASE WHEN present = 1 THEN individual_id END) as cnt
           FROM attendance_records WHERE session_id = ? AND church_id = ?`,
          [s.id, churchId]
        );
        total += cr[0]?.cnt || 0;
      }
    }
    totals.push({ weekStart, total });
  }

  totals.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return totals;
}

/**
 * Detect the most common gathering day for a church.
 * Returns the day after (i.e. if most gatherings are Sunday, returns 'Monday').
 */
async function detectSendDay(churchId) {
  const gatherings = await Database.query(
    `SELECT day_of_week, COUNT(*) as cnt
     FROM gathering_types
     WHERE is_active = 1 AND day_of_week IS NOT NULL AND church_id = ?
     GROUP BY day_of_week
     ORDER BY cnt DESC
     LIMIT 1`,
    [churchId]
  );

  if (gatherings.length === 0) return 'Monday'; // default

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mainDay = gatherings[0].day_of_week;
  const idx = days.indexOf(mainDay);
  // Day after
  return days[(idx + 1) % 7];
}

module.exports = { generateWeeklyReviewData, detectSendDay };
