# Weekly Review AI Insight — Enriched Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the weekly review AI insight with per-person engagement changes, local visitor retention, cross-gathering trends, and family attendance patterns — all anonymised before sending to Claude.

**Architecture:** Four new query functions in `weeklyReview.js` gather enriched data. `weeklyReviewInsight.js` builds an obfuscation map, constructs a richer context, calls Claude, then rehydrates names in the response. Falls back to algorithmic insight on API failure or insufficient data.

**Tech Stack:** Node.js, SQLite (better-sqlite3), Anthropic Messages API (Claude Haiku 4.5)

**Spec:** `docs/superpowers/specs/2026-03-26-weekly-review-ai-insight-design.md`

---

### Task 1: Split visitor counts in existing gathering stats

**Files:**
- Modify: `server/services/weeklyReview.js:76-86` (visitor count query)

The existing query counts all visitors together. Split into `localVisitorCount` and `travellerVisitorCount`.

- [ ] **Step 1: Update the standard attendance count query**

In `generateWeeklyReviewData()`, replace the visitor count query (lines 76-85):

```js
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
```

Also update the variable declarations near line 54-55 from:
```js
let count = 0;
let visitorCount = 0;
```
to:
```js
let count = 0;
let visitorCount = 0;
let localVisitorCount = 0;
let travellerVisitorCount = 0;
```

- [ ] **Step 2: Add split counts to gatheringStats and track local-only total**

Update the `gatheringStats.push()` call to include:

```js
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
```

- [ ] **Step 3: Rebuild and verify server starts**

```bash
docker-compose -f docker-compose.dev.yml up -d server && sleep 3 && docker-compose -f docker-compose.dev.yml logs --tail=5 server
```

Expected: Server starts without errors.

- [ ] **Step 4: Commit**

```bash
git add server/services/weeklyReview.js
git commit -m "feat(weekly-review): split local/traveller visitor counts in gathering stats"
```

---

### Task 2: Add enriched data queries to weeklyReview.js

**Files:**
- Modify: `server/services/weeklyReview.js` (add 4 new functions, call from `generateWeeklyReviewData`)

- [ ] **Step 1: Add `getRegularEngagementChanges` function**

Add after the `getWeeklyTotals` function (after line 239). This queries per-person attendance for active regulars over 8 weeks, grouped by family, detecting disengaging and re-engaging patterns.

```js
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
```

- [ ] **Step 2: Add `getLocalVisitorRetention` function**

```js
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
  const getWindowStats = async (windowStart, windowEnd) => {
    // Local visitors whose earliest attendance is within the window
    // total_visits is scoped to the analysis period (windowStart to outer endDate)
    const newVisitors = await Database.query(
      `SELECT i.id, i.first_name, i.last_name,
        MIN(s.session_date) as first_visit,
        COUNT(DISTINCT s.session_date) as total_visits
       FROM individuals i
       JOIN attendance_records ar ON ar.individual_id = i.id AND ar.present = 1 AND ar.church_id = i.church_id
       JOIN attendance_sessions s ON s.id = ar.session_id AND s.session_date <= ?
       JOIN gathering_types gt ON gt.id = s.gathering_type_id AND gt.attendance_type = 'standard'
       WHERE i.people_type = 'local_visitor' AND i.church_id = ?
       GROUP BY i.id
       HAVING first_visit >= ? AND first_visit < ?`,
      [windowEnd, churchId, windowStart, windowEnd]
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
  const current = await getWindowStats(start4, endDate);
  const prior = await getWindowStats(start8, start4);

  return {
    current,
    prior,
    returnRateChange: (current.returnRate !== null && prior.returnRate !== null)
      ? current.returnRate - prior.returnRate : null
  };
}
```

- [ ] **Step 3: Add `getCrossGatheringTrends` function**

```js
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
```

- [ ] **Step 4: Add `getFamilyAttendancePatterns` function**

```js
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
```

- [ ] **Step 5: Call the new functions from `generateWeeklyReviewData`**

Before the `return` statement (before line 170), add:

```js
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
```

Update the return object to include:

```js
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
    familyPatterns
  };
```

- [ ] **Step 6: Rebuild and verify server starts**

```bash
docker-compose -f docker-compose.dev.yml up -d server && sleep 3 && docker-compose -f docker-compose.dev.yml logs --tail=10 server
```

Expected: Server starts without errors.

- [ ] **Step 7: Commit**

```bash
git add server/services/weeklyReview.js
git commit -m "feat(weekly-review): add enriched data queries for AI insight

Add getRegularEngagementChanges, getLocalVisitorRetention,
getCrossGatheringTrends (with individual shifts), and
getFamilyAttendancePatterns."
```

---

### Task 3: Rewrite weeklyReviewInsight.js with obfuscation and enriched context

**Files:**
- Modify: `server/services/weeklyReviewInsight.js` (full rewrite)

- [ ] **Step 1: Add obfuscation map builder**

Replace the entire `buildContext` function and add new functions before it. Keep `callClaude` and `generateAlgorithmicInsight` as-is for now.

Add at the top of the file (after the `PLATFORM_API_KEY` line):

```js
/**
 * Build an obfuscation mapping: real names → delimited identifiers.
 * Returns { map: { '[Family-A]': 'Mackie', ... }, reverseMap: { 'Mackie': '[Family-A]', ... } }
 */
function buildObfuscationMap(reviewData) {
  const map = {};       // identifier → real name (for rehydration)
  const reverseMap = {}; // real name → identifier (for obfuscation)
  let familyCounter = 0;
  let personCounter = 0;

  const familyLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  const addFamily = (familyName) => {
    if (!familyName || reverseMap[familyName]) return;
    const letter = familyCounter < 26 ? familyLetters[familyCounter] : `${familyLetters[Math.floor(familyCounter / 26) - 1]}${familyLetters[familyCounter % 26]}`;
    const id = `[Family-${letter}]`;
    map[id] = familyName;
    reverseMap[familyName] = id;
    familyCounter++;
  };

  const addPerson = (firstName, lastName) => {
    const fullName = `${firstName} ${lastName}`;
    if (reverseMap[fullName]) return;
    personCounter++;
    const id = `[Person-${personCounter}]`;
    map[id] = fullName;
    reverseMap[fullName] = id;
  };

  // Process engagement changes
  if (reviewData.engagementChanges) {
    for (const c of reviewData.engagementChanges) {
      if (c.isFamily && c.familyName) {
        addFamily(c.familyName);
      } else if (c.firstName && c.lastName) {
        addPerson(c.firstName, c.lastName);
        if (c.familyName) addFamily(c.familyName);
      }
    }
  }

  // Process visitor retention candidates
  if (reviewData.visitorRetention?.current?.integrationCandidates) {
    for (const v of reviewData.visitorRetention.current.integrationCandidates) {
      addPerson(v.first_name, v.last_name);
    }
  }

  // Process cross-gathering shifts
  if (reviewData.crossGatheringShifts) {
    for (const s of reviewData.crossGatheringShifts) {
      addPerson(s.firstName, s.lastName);
      if (s.familyName) addFamily(s.familyName);
    }
  }

  // Process family patterns
  if (reviewData.familyPatterns) {
    for (const f of reviewData.familyPatterns) {
      if (f.familyName) addFamily(f.familyName);
    }
  }

  return { map, reverseMap };
}
```

- [ ] **Step 2: Rewrite `buildContext` with enriched data and obfuscation**

Replace the existing `buildContext` function:

```js
/**
 * Check minimum data thresholds for enriched insight.
 */
function meetsMinimumThresholds(reviewData) {
  if ((reviewData.weeklyTotals || []).length < 3) return false;

  // All-headcount churches have no individual-level data for enriched insights
  const hasStandard = (reviewData.gatherings || []).some(g => g.attendanceType === 'standard');
  if (!hasStandard) return false;

  let dataPoints = 0;
  dataPoints += (reviewData.engagementChanges || []).length;
  if (reviewData.visitorRetention?.current?.newCount > 0) dataPoints++;
  dataPoints += (reviewData.crossGatheringTrends || []).filter(t => t.direction !== 'stable').length;
  dataPoints += (reviewData.crossGatheringShifts || []).length;
  dataPoints += (reviewData.familyPatterns || []).length;

  return dataPoints >= 3;
}

function buildContext(reviewData, reverseMap) {
  const obfuscate = (name) => reverseMap[name] || name;

  // Gathering summary (local visitors only)
  const gatheringSummary = reviewData.gatherings.map(g => {
    let line = `${g.name}: ${g.count} attendees on ${g.date}`;
    if (g.deltaPercent !== null) {
      const dir = g.deltaPercent > 0 ? 'up' : g.deltaPercent < 0 ? 'down' : 'flat';
      line += ` (${dir} ${Math.abs(g.deltaPercent)}% vs 3-week avg of ${g.avgPrevious})`;
    }
    if (g.localVisitorCount > 0) line += `, ${g.localVisitorCount} local visitors`;
    return line;
  }).join('\n');

  // Engagement changes
  let engagementSection = '';
  if (reviewData.engagementChanges && reviewData.engagementChanges.length > 0) {
    const lines = reviewData.engagementChanges.map(c => {
      if (c.isFamily) {
        const name = obfuscate(c.familyName);
        if (c.type === 'disengaging') {
          return `- ${name} family (${c.memberCount} members): attended ${c.totalAttended}/${c.totalWeeks} weeks, missed last ${c.consecutiveMisses} weeks`;
        } else {
          return `- ${name} family (${c.memberCount} members): newly consistent — ${c.consecutivePresent} straight weeks`;
        }
      } else {
        const name = obfuscate(`${c.firstName} ${c.lastName}`);
        const familyNote = c.familyName ? ` (${obfuscate(c.familyName)} family)` : '';
        if (c.type === 'disengaging') {
          return `- ${name}${familyNote}: attended ${c.totalAttended}/${c.totalWeeks} weeks, missed last ${c.consecutiveMisses} weeks`;
        } else {
          return `- ${name}${familyNote}: newly consistent — ${c.consecutivePresent} straight weeks after sporadic attendance`;
        }
      }
    });
    engagementSection = `\nRegulars with changed patterns (last 8 weeks):\n${lines.join('\n')}`;
  }

  // Visitor retention
  let visitorSection = '';
  if (reviewData.visitorRetention?.current) {
    const cur = reviewData.visitorRetention.current;
    const lines = [];
    lines.push(`- ${cur.newCount} new local visitors, ${cur.returnedCount} returned for 2nd+ visit (${cur.returnRate !== null ? cur.returnRate + '% return rate' : 'no data'})`);
    if (reviewData.visitorRetention.prior.returnRate !== null) {
      lines.push(`- Prior 4-week return rate was ${reviewData.visitorRetention.prior.returnRate}%`);
    }
    for (const v of cur.integrationCandidates) {
      const name = obfuscate(`${v.first_name} ${v.last_name}`);
      lines.push(`- ${name}: visited ${v.total_visits} times in last month (strong integration candidate)`);
    }
    if (lines.length > 0) {
      visitorSection = `\nLocal visitor retention (last 4 weeks):\n${lines.join('\n')}`;
    }
  }

  // Cross-gathering trends
  let trendSection = '';
  if (reviewData.crossGatheringTrends && reviewData.crossGatheringTrends.length > 0) {
    const lines = reviewData.crossGatheringTrends.map(t => {
      return `- ${t.name}: ${t.direction} (avg ${t.firstAvg} → ${t.secondAvg} over ${t.sessionCount} sessions)`;
    });
    // Individual cross-gathering shifts
    if (reviewData.crossGatheringShifts && reviewData.crossGatheringShifts.length > 0) {
      for (const s of reviewData.crossGatheringShifts) {
        const name = obfuscate(`${s.firstName} ${s.lastName}`);
        lines.push(`- ${name}: stopped attending ${s.droppedGatherings.join(', ')} but still attends ${s.activeGatherings.join(', ')}`);
      }
    }
    trendSection = `\nCross-gathering patterns:\n${lines.join('\n')}`;
  }

  // Family patterns
  let familySection = '';
  if (reviewData.familyPatterns && reviewData.familyPatterns.length > 0) {
    const lines = reviewData.familyPatterns.map(f => {
      const name = obfuscate(f.familyName);
      if (f.pattern === 'whole-family-absent') {
        return `- ${name} family (${f.memberCount} members): whole family absent ${f.fullAbsentWeeks} of last ${f.totalWeeks} weeks (was mostly present before)`;
      } else if (f.pattern === 'partial-attendance') {
        return `- ${name} family (${f.memberCount} members): only some members attending ${f.partialWeeks} of ${f.totalWeeks} weeks`;
      } else {
        return `- ${name} family (${f.memberCount} members): newly consistent — full family present last ${f.fullPresentWeeks} weeks`;
      }
    });
    familySection = `\nFamily attendance patterns:\n${lines.join('\n')}`;
  }

  // Weekly totals
  const trendSummary = reviewData.weeklyTotals
    .map(w => `Week of ${w.weekStart}: ${w.total}`)
    .join(', ');

  return `Week: ${reviewData.weekStartDate} to ${reviewData.weekEndDate}

This week's gatherings:
${gatheringSummary}

Total attendance: ${reviewData.totalAttendance}
Total local visitors: ${reviewData.totalLocalVisitors}
${engagementSection}${visitorSection}${trendSection}${familySection}

Weekly totals (last 8 weeks):
${trendSummary}`;
}
```

- [ ] **Step 3: Add rehydration function**

```js
/**
 * Replace anonymised identifiers with real names in a single pass.
 * Then strip any remaining unreplaced identifiers.
 */
function rehydrateNames(text, nameMap) {
  if (!text || Object.keys(nameMap).length === 0) return text;

  // Build a regex matching all known identifiers in one pass
  const escaped = Object.keys(nameMap).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'g');
  let result = text.replace(pattern, match => nameMap[match] || match);

  // Strip any remaining un-rehydrated identifiers
  result = result.replace(/\[Family-[A-Z]+\]/g, 'a family');
  result = result.replace(/\[Person-\d+\]/g, 'someone');

  return result;
}
```

- [ ] **Step 4: Update `generateInsight` and system prompt**

Replace the `generateInsight` function:

```js
const SYSTEM_PROMPT = 'You are an attendance analyst for a church. Given this week\'s data, provide ONE brief, actionable insight (2-3 sentences). Pick the single most noteworthy pattern from: engagement changes among regulars, local visitor retention, cross-gathering trends, or family attendance shifts. Be warm and pastoral in tone. Do not use markdown formatting. Local visitors are people the church hopes will return and integrate. Traveller visitors are passing through and not expected to return — do not flag their non-return as a problem.';

async function generateInsight(reviewData) {
  if (!PLATFORM_API_KEY) {
    return generateAlgorithmicInsight(reviewData);
  }

  // Check minimum data thresholds
  if (!meetsMinimumThresholds(reviewData)) {
    return generateAlgorithmicInsight(reviewData);
  }

  try {
    const { map, reverseMap } = buildObfuscationMap(reviewData);
    const context = buildContext(reviewData, reverseMap);
    const response = await callClaude(context);
    if (!response) return generateAlgorithmicInsight(reviewData);

    const rehydrated = rehydrateNames(response, map);

    // Append CTA
    return rehydrated + '\n\n<em>Get deeper insights with <strong>AI Insights</strong> in your settings.</em>';
  } catch (err) {
    console.error('Weekly review AI insight failed, falling back to algorithmic:', err.message);
    return generateAlgorithmicInsight(reviewData);
  }
}
```

- [ ] **Step 5: Update `callClaude` with new system prompt and max_tokens**

In the `callClaude` function, update the request body:

```js
const body = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 150,
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: context }]
});
```

- [ ] **Step 6: Rebuild and verify server starts**

```bash
docker-compose -f docker-compose.dev.yml up -d server && sleep 3 && docker-compose -f docker-compose.dev.yml logs --tail=10 server
```

Expected: Server starts without errors.

- [ ] **Step 7: Commit**

```bash
git add server/services/weeklyReviewInsight.js
git commit -m "feat(weekly-review): enriched AI insight with obfuscation and rehydration

Rewrite buildContext with 4 data categories: engagement changes,
local visitor retention, cross-gathering trends, family patterns.
Add obfuscation map, single-pass rehydration, post-rehydration
validation, and minimum data thresholds."
```

---

### Task 4: Manual integration test

**Files:** None (testing only)

- [ ] **Step 1: Trigger a test email via the existing test mechanism**

Use the admin panel or run a direct test from inside the container:

```bash
docker exec church_attendance_server_dev node -e "
const Database = require('./config/database');
const { generateWeeklyReviewData } = require('./services/weeklyReview');
const { generateInsight } = require('./services/weeklyReviewInsight');

Database.initialize();
const churchId = 'red_9f3a7c2e5b10';

Database.setChurchContext(churchId, async () => {
  const data = await generateWeeklyReviewData(churchId);
  if (!data) { console.log('No data'); return; }
  console.log('Engagement changes:', JSON.stringify(data.engagementChanges, null, 2));
  console.log('Visitor retention:', JSON.stringify(data.visitorRetention, null, 2));
  console.log('Cross-gathering trends:', JSON.stringify(data.crossGatheringTrends, null, 2));
  console.log('Family patterns:', JSON.stringify(data.familyPatterns, null, 2));
  console.log('---');
  const insight = await generateInsight(data);
  console.log('AI Insight:', insight);
});
"
```

Expected: The enriched data categories are populated and the AI returns a contextual insight with real names rehydrated.

- [ ] **Step 2: Verify obfuscation is working**

Check the server logs — the context sent to Claude should not contain any real names. Add a temporary `console.log` in `buildContext` if needed to verify, then remove it.

- [ ] **Step 3: Send a full test email**

Trigger `processChurch` for the test church (or use whatever test email mechanism exists in the settings page) and verify the email arrives with a meaningful, name-containing insight.

- [ ] **Step 4: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix(weekly-review): adjustments from integration testing"
```
