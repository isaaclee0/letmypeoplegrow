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
         AND excluded_from_stats = 0
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
         AND excluded_from_stats = 0
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

  // Enriched data for AI insight
  const hasStandardGatherings = gatherings.some(g => g.attendance_type === 'standard');
  let engagementChanges = [];
  let visitorRetention = null;
  let crossGatheringTrends = [];
  let familyPatterns = [];

  if (hasStandardGatherings) {
    engagementChanges = await getRegularEngagementChanges(churchId, endDate);
    visitorRetention = await getLocalVisitorRetention(churchId, endDate);
    familyPatterns = await getFamilyAttendancePatterns(churchId, endDate);
  }
  const crossGatheringResult = await getCrossGatheringTrends(churchId, endDate);
  crossGatheringTrends = crossGatheringResult.trends || [];
  const crossGatheringShifts = crossGatheringResult.individualShifts || [];

  // Follow-up and visitor data (only for standard gatherings)
  let followUpData = { people: [], total: 0 };
  let weeklyVisitors = null;
  if (hasStandardGatherings) {
    followUpData = await getNewlyDisengaged(churchId, endDate);
    weeklyVisitors = await getWeeklyVisitorBreakdown(churchId, startDate, endDate);
  }

  // Getting started data for new churches
  const isNewChurch = weeklyTotals.length < 3;
  let gettingStarted = null;
  if (isNewChurch) {
    const gatheringCount = gatherings.length;
    const peopleCountResult = await Database.query(
      `SELECT COUNT(*) as cnt FROM individuals WHERE is_active = 1 AND church_id = ?`,
      [churchId]
    );
    gettingStarted = {
      gatheringCount,
      peopleCount: peopleCountResult[0]?.cnt || 0,
      weeksTracked: weeklyTotals.length
    };
  }

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
    weeklyTotals,
    engagementChanges,
    visitorRetention,
    crossGatheringTrends,
    crossGatheringShifts,
    familyPatterns,
    followUpPeople: followUpData.people,
    followUpTotal: followUpData.total,
    weeklyVisitors,
    gettingStarted
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
       AND as_t.excluded_from_stats = 0
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
 * Get regulars whose attendance pattern has changed recently.
 * Returns top 5 most significant changes sorted by severity.
 */
async function getRegularEngagementChanges(churchId, endDate) {
  const eightWeeksAgo = new Date(endDate);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const twelveWeeksAgo = new Date(endDate);
  twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
  const startDate8 = eightWeeksAgo.toISOString().split('T')[0];
  const startDate12 = twelveWeeksAgo.toISOString().split('T')[0];

  // Get active regulars with at least one attendance record in last 12 weeks
  const regulars = await Database.query(
    `SELECT DISTINCT i.id, i.first_name, i.last_name, i.family_id, f.family_name
     FROM individuals i
     LEFT JOIN families f ON f.id = i.family_id AND f.church_id = i.church_id
     WHERE i.people_type = 'regular' AND i.is_active = 1 AND i.church_id = ?
       AND EXISTS (
         SELECT 1 FROM attendance_records ar
         JOIN attendance_sessions s ON s.id = ar.session_id
         WHERE ar.individual_id = i.id AND ar.church_id = ? AND s.session_date >= ?
           AND s.excluded_from_stats = 0
       )`,
    [churchId, churchId, startDate12]
  );

  // Get standard gathering sessions in 8-week window grouped by week
  const sessions = await Database.query(
    `SELECT s.id, s.session_date, s.gathering_type_id
     FROM attendance_sessions s
     JOIN gathering_types gt ON gt.id = s.gathering_type_id
     WHERE s.session_date >= ? AND s.session_date <= ? AND s.church_id = ?
       AND gt.attendance_type = 'standard'
       AND s.excluded_from_stats = 0
     ORDER BY s.session_date`,
    [startDate8, endDate, churchId]
  );

  if (sessions.length === 0) return [];

  // Group sessions by week
  const weekSessions = new Map();
  for (const s of sessions) {
    const d = new Date(s.session_date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(new Date(s.session_date).setDate(diff)).toISOString().split('T')[0];
    if (!weekSessions.has(weekStart)) weekSessions.set(weekStart, []);
    weekSessions.get(weekStart).push(s);
  }
  const weeks = [...weekSessions.keys()].sort();
  const totalWeeks = weeks.length;
  if (totalWeeks < 3) return []; // need at least 3 weeks for pattern detection

  // For each regular, compute per-week attendance (present in ANY session that week)
  const sessionIds = sessions.map(s => s.id);
  const attendanceRows = await Database.query(
    `SELECT individual_id, session_id, present
     FROM attendance_records
     WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) AND church_id = ?`,
    [...sessionIds, churchId]
  );

  // Build session→week lookup
  const sessionWeekMap = new Map();
  for (const [weekStart, sessionsInWeek] of weekSessions) {
    for (const s of sessionsInWeek) {
      sessionWeekMap.set(s.id, weekStart);
    }
  }

  // Per-person per-week attendance
  const personWeeks = new Map(); // personId → Set of weeks attended
  for (const row of attendanceRows) {
    if (!row.present) continue;
    const week = sessionWeekMap.get(row.session_id);
    if (!week) continue;
    if (!personWeeks.has(row.individual_id)) personWeeks.set(row.individual_id, new Set());
    personWeeks.get(row.individual_id).add(week);
  }

  // Analyse each regular
  const changes = [];
  for (const person of regulars) {
    const attended = personWeeks.get(person.id) || new Set();
    const totalAttended = attended.size;
    const rate = totalAttended / totalWeeks;

    // Check recent weeks (last 2-3)
    const recentWeeks = weeks.slice(-3);
    const recentAttended = recentWeeks.filter(w => attended.has(w)).length;

    // Check earlier weeks
    const earlierWeeks = weeks.slice(0, -3);
    const earlierAttended = earlierWeeks.filter(w => attended.has(w)).length;
    const earlierRate = earlierWeeks.length > 0 ? earlierAttended / earlierWeeks.length : 0;

    // Consecutive misses from the end
    let consecutiveMisses = 0;
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (!attended.has(weeks[i])) consecutiveMisses++;
      else break;
    }

    // Consecutive recent attendances
    let consecutivePresent = 0;
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (attended.has(weeks[i])) consecutivePresent++;
      else break;
    }

    // Disengaging: was attending >60% but missed last 2+ weeks
    if (earlierRate > 0.6 && consecutiveMisses >= 2) {
      changes.push({
        type: 'disengaging',
        personId: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        familyId: person.family_id,
        familyName: person.family_name,
        totalAttended,
        totalWeeks,
        consecutiveMisses,
        severity: consecutiveMisses * 10 + (earlierRate * 10) // higher = more severe
      });
    }
    // Re-engaging: was attending <40% earlier but last 3+ weeks straight
    else if (earlierRate < 0.4 && consecutivePresent >= 3) {
      changes.push({
        type: 're-engaging',
        personId: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        familyId: person.family_id,
        familyName: person.family_name,
        totalAttended,
        totalWeeks,
        consecutivePresent,
        severity: consecutivePresent * 5
      });
    }
  }

  // Group by family for family-level drift
  const familyGroups = new Map();
  for (const c of changes) {
    if (c.familyId) {
      if (!familyGroups.has(c.familyId)) familyGroups.set(c.familyId, []);
      familyGroups.get(c.familyId).push(c);
    }
  }

  const results = [];
  const processedPersonIds = new Set();

  // Emit family-level entries where ALL members share the same change type
  for (const [familyId, members] of familyGroups) {
    if (members.length > 1 && members.every(m => m.type === members[0].type)) {
      const rep = members[0];
      results.push({
        type: rep.type,
        isFamily: true,
        familyId,
        familyName: rep.familyName,
        memberCount: members.length,
        totalAttended: rep.totalAttended,
        totalWeeks: rep.totalWeeks,
        consecutiveMisses: rep.consecutiveMisses,
        consecutivePresent: rep.consecutivePresent,
        severity: Math.max(...members.map(m => m.severity)) + 5 // family bonus
      });
      members.forEach(m => processedPersonIds.add(m.personId));
    }
  }

  // Add remaining individual entries
  for (const c of changes) {
    if (!processedPersonIds.has(c.personId)) {
      results.push({
        type: c.type,
        isFamily: false,
        personId: c.personId,
        firstName: c.firstName,
        lastName: c.lastName,
        familyId: c.familyId,
        familyName: c.familyName,
        totalAttended: c.totalAttended,
        totalWeeks: c.totalWeeks,
        consecutiveMisses: c.consecutiveMisses,
        consecutivePresent: c.consecutivePresent,
        severity: c.severity
      });
    }
  }

  // Sort by severity descending, return top 5
  results.sort((a, b) => b.severity - a.severity);
  return results.slice(0, 5);
}

/**
 * Get local visitor retention stats for last 4 weeks, compared to prior 4 weeks.
 */
async function getLocalVisitorRetention(churchId, endDate) {
  const fourWeeksAgo = new Date(endDate);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const eightWeeksAgo = new Date(endDate);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const start4 = fourWeeksAgo.toISOString().split('T')[0];
  const start8 = eightWeeksAgo.toISOString().split('T')[0];

  // Find local visitors whose first attendance record falls in each window
  const getWindowStats = async (windowStart, windowEnd, analysisEnd) => {
    // Local visitors whose earliest attendance is within the window
    // total_visits is scoped up to analysisEnd so both windows are comparable
    const newVisitors = await Database.query(
      `SELECT i.id, i.first_name, i.last_name,
        MIN(s.session_date) as first_visit,
        COUNT(DISTINCT s.session_date) as total_visits
       FROM individuals i
       JOIN attendance_records ar ON ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = i.church_id
       JOIN attendance_sessions s ON s.id = ar.session_id AND s.session_date <= ? AND s.excluded_from_stats = 0
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
       WHERE i.people_type = 'local_visitor' AND i.church_id = ?
       GROUP BY i.id
       HAVING first_visit >= ? AND first_visit < ?`,
      [analysisEnd, churchId, windowStart, windowEnd]
    );

    const newCount = newVisitors.length;
    const returnedCount = newVisitors.filter(v => v.total_visits >= 2).length;
    const returnRate = newCount > 0 ? Math.round((returnedCount / newCount) * 100) : null;
    const integrationCandidates = newVisitors
      .filter(v => v.total_visits >= 3)
      .sort((a, b) => b.total_visits - a.total_visits)
      .slice(0, 3);

    return { newCount, returnedCount, returnRate, integrationCandidates };
  };

  // current window: [start4, endDate), prior window: [start8, start4)
  // Both windows count total_visits up to endDate for apples-to-apples comparison
  const current = await getWindowStats(start4, endDate, endDate);
  const prior = await getWindowStats(start8, start4, endDate);

  return {
    current,
    prior,
    returnRateChange: (current.returnRate !== null && prior.returnRate !== null)
      ? current.returnRate - prior.returnRate : null
  };
}

/**
 * Get per-gathering trend direction over 8 weeks.
 */
async function getCrossGatheringTrends(churchId, endDate) {
  const eightWeeksAgo = new Date(endDate);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const startDate = eightWeeksAgo.toISOString().split('T')[0];

  const gatherings = await Database.query(
    `SELECT id, name, attendance_type FROM gathering_types WHERE is_active = 1 AND church_id = ?`,
    [churchId]
  );

  const trends = [];
  for (const g of gatherings) {
    const sessions = await Database.query(
      `SELECT id, session_date, headcount_mode
       FROM attendance_sessions
       WHERE gathering_type_id = ? AND session_date >= ? AND session_date <= ? AND church_id = ?
         AND excluded_from_stats = 0
       ORDER BY session_date`,
      [g.id, startDate, endDate, churchId]
    );

    if (sessions.length < 3) continue;

    const counts = [];
    for (const s of sessions) {
      let cnt = 0;
      if (g.attendance_type === 'headcount') {
        const hr = await Database.query(
          `SELECT headcount FROM headcount_records WHERE session_id = ? AND church_id = ?`,
          [s.id, churchId]
        );
        if (hr.length > 0) {
          const mode = s.headcount_mode || 'separate';
          if (mode === 'combined') cnt = hr.reduce((sum, r) => sum + r.headcount, 0);
          else if (mode === 'averaged') cnt = Math.round(hr.reduce((sum, r) => sum + r.headcount, 0) / hr.length);
          else cnt = Math.max(...hr.map(r => r.headcount));
        }
      } else {
        const cr = await Database.query(
          `SELECT COUNT(DISTINCT CASE WHEN present = 1 THEN individual_id END) as cnt
           FROM attendance_records WHERE session_id = ? AND church_id = ?`,
          [s.id, churchId]
        );
        cnt = cr[0]?.cnt || 0;
      }
      counts.push(cnt);
    }

    // Compare first half avg to second half avg
    const mid = Math.floor(counts.length / 2);
    const firstHalf = counts.slice(0, mid);
    const secondHalf = counts.slice(mid);
    const firstAvg = Math.round(firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length);
    const secondAvg = Math.round(secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length);

    let direction = 'stable';
    const changePct = firstAvg > 0 ? Math.round(((secondAvg - firstAvg) / firstAvg) * 100) : 0;
    if (changePct > 10) direction = 'growing';
    else if (changePct < -10) direction = 'shrinking';

    trends.push({
      name: g.name,
      gatheringId: g.id,
      attendanceType: g.attendance_type,
      direction,
      firstAvg,
      secondAvg,
      changePct,
      sessionCount: sessions.length
    });
  }

  // Detect individual cross-gathering shifts (standard gatherings only)
  const standardGatherings = gatherings.filter(g => g.attendance_type === 'standard');
  const individualShifts = [];

  if (standardGatherings.length >= 2) {
    // For each standard gathering, get individuals who attended 2+ times in first half but 0 in second half
    const allSessions = await Database.query(
      `SELECT s.id, s.session_date, s.gathering_type_id
       FROM attendance_sessions s
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
       WHERE s.session_date >= ? AND s.session_date <= ? AND s.church_id = ?
         AND s.excluded_from_stats = 0
       ORDER BY s.session_date`,
      [startDate, endDate, churchId]
    );

    // Split into first/second half by date
    const midDate = new Date((new Date(startDate).getTime() + new Date(endDate).getTime()) / 2)
      .toISOString().split('T')[0];

    // Per-person per-gathering: count first-half and second-half attendances
    const personGatheringCounts = new Map(); // `${personId}-${gatheringId}` → { first, second }
    const sessionGatheringMap = new Map();
    for (const s of allSessions) {
      sessionGatheringMap.set(s.id, { gatheringId: s.gathering_type_id, isFirst: s.session_date < midDate });
    }

    const allSessionIds = allSessions.map(s => s.id);
    if (allSessionIds.length > 0) {
      const records = await Database.query(
        `SELECT individual_id, session_id, present FROM attendance_records
         WHERE session_id IN (${allSessionIds.map(() => '?').join(',')}) AND present = 1 AND church_id = ?`,
        [...allSessionIds, churchId]
      );

      for (const r of records) {
        const info = sessionGatheringMap.get(r.session_id);
        if (!info) continue;
        const key = `${r.individual_id}-${info.gatheringId}`;
        if (!personGatheringCounts.has(key)) personGatheringCounts.set(key, { first: 0, second: 0 });
        if (info.isFirst) personGatheringCounts.get(key).first++;
        else personGatheringCounts.get(key).second++;
      }

      // Find people who dropped a gathering (2+ first half, 0 second half)
      // but still attend another gathering (second half > 0)
      const personDropped = new Map(); // personId → [gatheringId they dropped]
      const personActive = new Map();  // personId → [gatheringId they still attend]

      for (const [key, counts] of personGatheringCounts) {
        const [personId, gatheringId] = key.split('-').map(Number);
        if (counts.first >= 2 && counts.second === 0) {
          if (!personDropped.has(personId)) personDropped.set(personId, []);
          personDropped.get(personId).push(gatheringId);
        }
        if (counts.second > 0) {
          if (!personActive.has(personId)) personActive.set(personId, []);
          personActive.get(personId).push(gatheringId);
        }
      }

      // Only flag people who dropped one gathering but still attend another
      for (const [personId, droppedIds] of personDropped) {
        const activeIds = personActive.get(personId) || [];
        if (activeIds.length === 0) continue; // dropped everything — handled by engagement changes

        const person = await Database.query(
          `SELECT first_name, last_name, family_id, f.family_name
           FROM individuals i LEFT JOIN families f ON f.id = i.family_id AND f.church_id = i.church_id
           WHERE i.id = ? AND i.church_id = ?`,
          [personId, churchId]
        );
        if (person.length === 0) continue;

        const droppedNames = droppedIds.map(id => standardGatherings.find(g => g.id === id)?.name).filter(Boolean);
        const activeNames = activeIds.map(id => standardGatherings.find(g => g.id === id)?.name).filter(Boolean);

        individualShifts.push({
          personId,
          firstName: person[0].first_name,
          lastName: person[0].last_name,
          familyId: person[0].family_id,
          familyName: person[0].family_name,
          droppedGatherings: droppedNames,
          activeGatherings: activeNames
        });
      }
    }
  }

  return { trends, individualShifts: individualShifts.slice(0, 3) };
}

/**
 * Get family-level attendance patterns over 8 weeks.
 * Returns top 5 most noteworthy patterns.
 */
async function getFamilyAttendancePatterns(churchId, endDate) {
  const eightWeeksAgo = new Date(endDate);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const startDate = eightWeeksAgo.toISOString().split('T')[0];

  // Get families with active regular members
  const families = await Database.query(
    `SELECT DISTINCT f.id, f.family_name, COUNT(i.id) as member_count
     FROM families f
     JOIN individuals i ON i.family_id = f.id AND i.church_id = f.church_id
     WHERE i.people_type = 'regular' AND i.is_active = 1 AND f.church_id = ?
     GROUP BY f.id
     HAVING member_count >= 2`,
    [churchId]
  );

  if (families.length === 0) return [];

  // Get standard sessions in window
  const sessions = await Database.query(
    `SELECT s.id, s.session_date
     FROM attendance_sessions s
     JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
     WHERE s.session_date >= ? AND s.session_date <= ? AND s.church_id = ?
       AND s.excluded_from_stats = 0
     ORDER BY s.session_date`,
    [startDate, endDate, churchId]
  );

  if (sessions.length === 0) return [];

  // Group sessions by week
  const weekSessions = new Map();
  for (const s of sessions) {
    const d = new Date(s.session_date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(new Date(s.session_date).setDate(diff)).toISOString().split('T')[0];
    if (!weekSessions.has(weekStart)) weekSessions.set(weekStart, []);
    weekSessions.get(weekStart).push(s);
  }
  const weeks = [...weekSessions.keys()].sort();
  if (weeks.length < 3) return [];

  const sessionIds = sessions.map(s => s.id);
  const sessionWeekMap = new Map();
  for (const [weekStart, sessionsInWeek] of weekSessions) {
    for (const s of sessionsInWeek) {
      sessionWeekMap.set(s.id, weekStart);
    }
  }

  const patterns = [];
  for (const family of families) {
    // Get all members
    const members = await Database.query(
      `SELECT id FROM individuals WHERE family_id = ? AND people_type = 'regular' AND is_active = 1 AND church_id = ?`,
      [family.id, churchId]
    );
    const memberIds = new Set(members.map(m => m.id));
    if (members.length === 0) continue;

    // Get attendance for all members
    const attendance = await Database.query(
      `SELECT individual_id, session_id, present
       FROM attendance_records
       WHERE individual_id IN (${members.map(() => '?').join(',')})
         AND session_id IN (${sessionIds.map(() => '?').join(',')})
         AND church_id = ?`,
      [...members.map(m => m.id), ...sessionIds, churchId]
    );

    // Per-week: count how many members attended
    const weekMemberCounts = new Map(); // week → count of members present
    for (const row of attendance) {
      if (!row.present) continue;
      const week = sessionWeekMap.get(row.session_id);
      if (!week) continue;
      if (!weekMemberCounts.has(week)) weekMemberCounts.set(week, new Set());
      weekMemberCounts.get(week).add(row.individual_id);
    }

    const totalMembers = memberIds.size;
    let fullAbsentWeeks = 0; // weeks where nobody came
    let partialWeeks = 0;    // weeks where some but not all came
    let fullPresentWeeks = 0;

    for (const week of weeks) {
      const presentCount = weekMemberCounts.get(week)?.size || 0;
      if (presentCount === 0) fullAbsentWeeks++;
      else if (presentCount < totalMembers) partialWeeks++;
      else fullPresentWeeks++;
    }

    // Recent pattern (last 3 weeks)
    const recentWeeks = weeks.slice(-3);
    let recentFullAbsent = 0;
    let recentFullPresent = 0;
    for (const week of recentWeeks) {
      const presentCount = weekMemberCounts.get(week)?.size || 0;
      if (presentCount === 0) recentFullAbsent++;
      else if (presentCount === totalMembers) recentFullPresent++;
    }

    // Flag noteworthy patterns
    let pattern = null;
    let significance = 0;

    if (recentFullAbsent >= 2 && fullPresentWeeks > fullAbsentWeeks) {
      // Family was mostly present but recently all absent
      pattern = 'whole-family-absent';
      significance = recentFullAbsent * 10 + totalMembers;
    } else if (partialWeeks > weeks.length * 0.5) {
      // Consistently partial attendance
      pattern = 'partial-attendance';
      significance = partialWeeks + totalMembers;
    } else if (recentFullPresent >= 3 && fullPresentWeeks <= weeks.length * 0.5) {
      // Newly consistent
      pattern = 'newly-consistent';
      significance = recentFullPresent * 5 + totalMembers;
    }

    if (pattern) {
      patterns.push({
        familyId: family.id,
        familyName: family.family_name,
        memberCount: totalMembers,
        pattern,
        totalWeeks: weeks.length,
        fullAbsentWeeks,
        partialWeeks,
        fullPresentWeeks,
        significance
      });
    }
  }

  patterns.sort((a, b) => b.significance - a.significance);
  return patterns.slice(0, 5);
}

/**
 * Get regulars who newly became disengaged: present in weeks 4-6 but absent in weeks 1-3.
 * Returns up to 5 people with the gatherings they used to attend, plus total count.
 */
async function getNewlyDisengaged(churchId, endDate) {
  const threeWeeksAgo = new Date(endDate);
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
  const sixWeeksAgo = new Date(endDate);
  sixWeeksAgo.setDate(sixWeeksAgo.getDate() - 42);
  const recentStart = threeWeeksAgo.toISOString().split('T')[0];
  const olderStart = sixWeeksAgo.toISOString().split('T')[0];

  // Find active regulars who were present in weeks 4-6 but NOT present in weeks 1-3
  const disengaged = await Database.query(
    `SELECT i.id, i.first_name, i.last_name
     FROM individuals i
     WHERE i.people_type = 'regular' AND i.is_active = 1 AND i.church_id = ?
       AND EXISTS (
         SELECT 1 FROM attendance_records ar
         JOIN attendance_sessions s ON s.id = ar.session_id
         JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
         WHERE ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = ?
           AND s.session_date >= ? AND s.session_date < ?
           AND s.excluded_from_stats = 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM attendance_records ar
         JOIN attendance_sessions s ON s.id = ar.session_id
         JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
         WHERE ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = ?
           AND s.session_date >= ? AND s.session_date <= ?
           AND s.excluded_from_stats = 0
       )
     ORDER BY i.last_name, i.first_name`,
    [churchId, churchId, olderStart, recentStart, churchId, recentStart, endDate]
  );

  const total = disengaged.length;
  const capped = disengaged.slice(0, 5);

  // For each person, find which gatherings they attended in weeks 4-6
  const result = [];
  for (const person of capped) {
    const gatheringRows = await Database.query(
      `SELECT DISTINCT gt.name
       FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
       WHERE ar.individual_id = ? AND ar.present = 1 AND ar.church_id = ?
         AND s.session_date >= ? AND s.session_date < ?
         AND s.excluded_from_stats = 0
       ORDER BY gt.name`,
      [person.id, churchId, olderStart, recentStart]
    );
    result.push({
      firstName: person.first_name,
      lastName: person.last_name,
      gatherings: gatheringRows.map(g => g.name)
    });
  }

  return { people: result, total };
}

/**
 * Get this week's local visitors categorized as first-time or returning.
 */
async function getWeeklyVisitorBreakdown(churchId, startDate, endDate) {
  // Get local visitors who attended this week
  const visitors = await Database.query(
    `SELECT DISTINCT i.id, i.first_name, i.last_name
     FROM individuals i
     JOIN attendance_records ar ON ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = i.church_id
     JOIN attendance_sessions s ON s.id = ar.session_id
     JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
     WHERE i.people_type = 'local_visitor' AND i.is_active = 1 AND i.church_id = ?
       AND s.session_date >= ? AND s.session_date <= ?
       AND s.excluded_from_stats = 0`,
    [churchId, startDate, endDate]
  );

  if (visitors.length === 0) return null;

  const firstTime = [];
  const returning = [];

  for (const visitor of visitors) {
    // Check if they have any attendance before this week
    const prior = await Database.query(
      `SELECT 1 FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       WHERE ar.individual_id = ? AND ar.present = 1 AND ar.church_id = ?
         AND s.session_date < ?
         AND s.excluded_from_stats = 0
       LIMIT 1`,
      [visitor.id, churchId, startDate]
    );

    // Get which gathering(s) they attended this week
    const gatheringRows = await Database.query(
      `SELECT DISTINCT gt.name
       FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
       WHERE ar.individual_id = ? AND ar.present = 1 AND ar.church_id = ?
         AND s.session_date >= ? AND s.session_date <= ?
         AND s.excluded_from_stats = 0
       ORDER BY gt.name`,
      [visitor.id, churchId, startDate, endDate]
    );
    const gatheringNames = gatheringRows.map(g => g.name);

    const entry = {
      firstName: visitor.first_name,
      lastName: visitor.last_name,
      gatherings: gatheringNames
    };

    if (prior.length > 0) {
      returning.push(entry);
    } else {
      firstTime.push(entry);
    }
  }

  return { firstTime, returning };
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
