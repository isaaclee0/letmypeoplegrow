# Absence Dismissal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins/coordinators to dismiss expected absences from the reports page, hiding them until 3 additional consecutive absences accumulate. Dismissed absences are also hidden from the weekly review email.

**Architecture:** New `absence_dismissals` table stores per-individual, per-gathering dismissals with the streak at dismissal time. A POST endpoint creates dismissals, a GET endpoint retrieves them. The reports page filters client-side. The weekly review email filters via SQL. Auto-cleanup removes stale dismissals when individuals attend again.

**Tech Stack:** SQLite, Express 5, React/TypeScript, existing API patterns

---

### Task 1: Add `absence_dismissals` Table to Schema

**Files:**
- Modify: `server/config/schema.js:413` (before the closing backtick of SCHEMA constant)

- [ ] **Step 1: Add table definition to schema**

In `server/config/schema.js`, add the new table just before the closing backtick (`` ` ``) of the `SCHEMA` constant (currently at line 415). Insert it after the `user_preferences` table and its index:

```sql
CREATE TABLE IF NOT EXISTS absence_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  individual_id INTEGER NOT NULL,
  gathering_type_id INTEGER NOT NULL,
  dismissed_at_streak INTEGER NOT NULL,
  dismissed_by INTEGER,
  church_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (dismissed_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(individual_id, gathering_type_id)
);
CREATE INDEX IF NOT EXISTS idx_absence_dismissals_individual ON absence_dismissals(individual_id, gathering_type_id);
CREATE INDEX IF NOT EXISTS idx_absence_dismissals_church ON absence_dismissals(church_id);
```

- [ ] **Step 2: Rebuild server container and verify startup**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs --tail=20 server
```

Expected: Server starts without errors. The table is created automatically for existing church databases on next access.

- [ ] **Step 3: Commit**

```bash
git add server/config/schema.js
git commit -m "feat: add absence_dismissals table to schema"
```

---

### Task 2: Add POST `/api/reports/dismiss-absence` Endpoint

**Files:**
- Modify: `server/routes/reports.js:523` (before `module.exports`)

This endpoint receives a key (`ind:123` or `fam:456`) and an array of gathering type IDs. For individual keys, it inserts one dismissal row per gathering. For family keys, it looks up all family members and inserts a row for each member per gathering. The current streak is computed server-side from the last 12 sessions.

- [ ] **Step 1: Add the dismiss-absence endpoint**

In `server/routes/reports.js`, add the following route before the `module.exports = router;` line:

```javascript
// Dismiss an absence entry (individual or family)
router.post('/dismiss-absence', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { key, gatheringTypeIds } = req.body;

    if (!key || !gatheringTypeIds || !Array.isArray(gatheringTypeIds) || gatheringTypeIds.length === 0) {
      return res.status(400).json({ error: 'key and gatheringTypeIds are required' });
    }

    const churchId = req.user.church_id;
    const userId = req.user.id;

    // Parse the key to get individual IDs to dismiss
    let individualIds = [];
    const [keyType, keyId] = key.split(':');

    if (keyType === 'ind') {
      individualIds = [parseInt(keyId, 10)];
    } else if (keyType === 'fam') {
      const familyId = parseInt(keyId, 10);
      const members = await Database.query(
        'SELECT id FROM individuals WHERE family_id = ? AND is_active = 1 AND church_id = ?',
        [familyId, churchId]
      );
      individualIds = members.map(m => m.id);
    } else {
      return res.status(400).json({ error: 'Invalid key format. Expected ind:{id} or fam:{id}' });
    }

    if (individualIds.length === 0) {
      return res.status(404).json({ error: 'No individuals found for the given key' });
    }

    // Compute current streak for each individual across the selected gatherings
    // Look at the last 12 sessions in descending date order
    const gatheringPlaceholders = gatheringTypeIds.map(() => '?').join(',');
    const sessions = await Database.query(
      `SELECT DISTINCT s.id, s.session_date
       FROM attendance_sessions s
       WHERE s.gathering_type_id IN (${gatheringPlaceholders})
         AND s.church_id = ?
         AND s.excluded_from_stats = 0
       ORDER BY s.session_date DESC
       LIMIT 12`,
      [...gatheringTypeIds, churchId]
    );

    const sessionIds = sessions.map(s => s.id);

    for (const individualId of individualIds) {
      let streak = 0;

      if (sessionIds.length > 0) {
        const sessionPlaceholders = sessionIds.map(() => '?').join(',');
        const records = await Database.query(
          `SELECT s.session_date, COALESCE(ar.present, 0) as present
           FROM attendance_sessions s
           LEFT JOIN attendance_records ar ON ar.session_id = s.id AND ar.individual_id = ?
           WHERE s.id IN (${sessionPlaceholders})
           ORDER BY s.session_date DESC`,
          [individualId, ...sessionIds]
        );

        for (const record of records) {
          if (record.present) break;
          streak++;
        }
      }

      // Upsert dismissal for each gathering
      for (const gatheringTypeId of gatheringTypeIds) {
        await Database.query(
          `INSERT INTO absence_dismissals (individual_id, gathering_type_id, dismissed_at_streak, dismissed_by, church_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(individual_id, gathering_type_id) DO UPDATE SET
             dismissed_at_streak = excluded.dismissed_at_streak,
             dismissed_by = excluded.dismissed_by,
             created_at = datetime('now')`,
          [individualId, gatheringTypeId, streak, userId, churchId]
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss absence error:', error);
    res.status(500).json({ error: 'Failed to dismiss absence' });
  }
});
```

- [ ] **Step 2: Rebuild server and test manually**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
```

Verify the server starts without errors by checking logs:
```bash
docker-compose -f docker-compose.dev.yml logs --tail=10 server
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/reports.js
git commit -m "feat: add POST /api/reports/dismiss-absence endpoint"
```

---

### Task 3: Add GET `/api/reports/dismissals` Endpoint

**Files:**
- Modify: `server/routes/reports.js` (after the dismiss-absence route added in Task 2)

- [ ] **Step 1: Add the dismissals GET endpoint**

In `server/routes/reports.js`, add the following route after the `dismiss-absence` route (before `module.exports`):

```javascript
// Get active dismissals for the given gatherings
router.get('/dismissals', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { gatheringTypeIds } = req.query;
    const churchId = req.user.church_id;

    if (!gatheringTypeIds || (Array.isArray(gatheringTypeIds) && gatheringTypeIds.length === 0)) {
      return res.json({ dismissals: [] });
    }

    const ids = Array.isArray(gatheringTypeIds) ? gatheringTypeIds : [gatheringTypeIds];
    const placeholders = ids.map(() => '?').join(',');

    const dismissals = await Database.query(
      `SELECT individual_id, gathering_type_id, dismissed_at_streak
       FROM absence_dismissals
       WHERE gathering_type_id IN (${placeholders}) AND church_id = ?`,
      [...ids, churchId]
    );

    res.json({
      dismissals: dismissals.map(d => ({
        individualId: d.individual_id,
        gatheringTypeId: d.gathering_type_id,
        dismissedAtStreak: d.dismissed_at_streak
      }))
    });
  } catch (error) {
    console.error('Get dismissals error:', error);
    res.status(500).json({ error: 'Failed to get dismissals' });
  }
});
```

- [ ] **Step 2: Rebuild server and verify**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs --tail=10 server
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/reports.js
git commit -m "feat: add GET /api/reports/dismissals endpoint"
```

---

### Task 4: Add Client API Methods

**Files:**
- Modify: `client/src/services/api.ts:628` (extend `reportsAPI` object)

- [ ] **Step 1: Add dismissAbsence and getDismissals to reportsAPI**

In `client/src/services/api.ts`, extend the `reportsAPI` object. After the existing `exportData` entry, add:

```typescript
  dismissAbsence: (data: { key: string; gatheringTypeIds: number[] }) =>
    api.post('/reports/dismiss-absence', data),

  getDismissals: (params: { gatheringTypeIds: number[] }) =>
    api.get('/reports/dismissals', { params }),
```

- [ ] **Step 2: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat: add dismissAbsence and getDismissals API methods"
```

---

### Task 5: Integrate Dismissals into Reports Page

**Files:**
- Modify: `client/src/pages/ReportsPage.tsx`

This task adds: fetching dismissals, filtering the absence list, and a dismiss button on each row.

- [ ] **Step 1: Add dismissals state and fetch logic**

In `ReportsPage.tsx`, add a new state variable near the other state declarations (around line 43):

```typescript
const [dismissals, setDismissals] = useState<Array<{ individualId: number; gatheringTypeId: number; dismissedAtStreak: number }>>([]);
```

Add a new `useEffect` after the existing `loadAbsenceAndVisitorDetails` effect (around line 432). This fetches dismissals whenever `selectedGatherings` changes:

```typescript
useEffect(() => {
  if (!hasReportsAccess || selectedGatherings.length === 0) return;
  const fetchDismissals = async () => {
    try {
      const response = await reportsAPI.getDismissals({
        gatheringTypeIds: selectedGatherings.map(g => g.id)
      });
      setDismissals(response.data.dismissals || []);
    } catch (e) {
      // Non-critical — just show all absences if this fails
    }
  };
  fetchDismissals();
}, [hasReportsAccess, selectedGatherings]);
```

- [ ] **Step 2: Add filtering logic and dismiss handler**

Add a `useMemo` that filters `groupedAbsences` using the dismissals data. Place it after the `attendanceChartData` useMemo block (around line 534):

```typescript
const filteredAbsences = useMemo(() => {
  if (dismissals.length === 0) return groupedAbsences;

  // Build a lookup: individualId -> max dismissedAtStreak across selected gatherings
  const dismissalMap = new Map<number, number>();
  dismissals.forEach(d => {
    const existing = dismissalMap.get(d.individualId) || 0;
    if (d.dismissedAtStreak > existing) {
      dismissalMap.set(d.individualId, d.dismissedAtStreak);
    }
  });

  return groupedAbsences.filter(g => {
    if (g.key.startsWith('ind:')) {
      const id = parseInt(g.key.split(':')[1], 10);
      const dismissedAt = dismissalMap.get(id);
      if (dismissedAt !== undefined && g.streak < dismissedAt + 3) return false;
    } else if (g.key.startsWith('fam:')) {
      const famId = parseInt(g.key.split(':')[1], 10);
      // A family is filtered out only if ALL members in absenceList for this family are dismissed
      const familyMembers = absenceList.filter(a => a.familyId === famId);
      if (familyMembers.length > 0 && familyMembers.every(m => {
        const dismissedAt = dismissalMap.get(m.individualId);
        return dismissedAt !== undefined && m.streak < dismissedAt + 3;
      })) {
        return false;
      }
    }
    return true;
  });
}, [groupedAbsences, absenceList, dismissals]);
```

Add a dismiss handler function after the `handleExportData` function:

```typescript
const handleDismissAbsence = async (key: string) => {
  try {
    await reportsAPI.dismissAbsence({
      key,
      gatheringTypeIds: selectedGatherings.map(g => g.id)
    });
    // Optimistic update: remove from displayed list
    setGroupedAbsences(prev => prev.filter(g => g.key !== key));
  } catch (e) {
    console.error('Failed to dismiss absence:', e);
  }
};
```

- [ ] **Step 3: Update the absence list rendering to use filteredAbsences and add dismiss button**

In the JSX, replace all references to `groupedAbsences` in the "Regulars With Recent Absences" panel with `filteredAbsences`. There are 4 occurrences to change (around lines 1126-1149):

Replace:
```typescript
) : groupedAbsences.length === 0 ? (
```
With:
```typescript
) : filteredAbsences.length === 0 ? (
```

Replace:
```typescript
{(showAllAbsences ? groupedAbsences : groupedAbsences.slice(0, 5)).map((g) => {
```
With:
```typescript
{(showAllAbsences ? filteredAbsences : filteredAbsences.slice(0, 5)).map((g) => {
```

Replace:
```typescript
{groupedAbsences.length > 5 && (
```
With:
```typescript
{filteredAbsences.length > 5 && (
```

Replace:
```typescript
{showAllAbsences ? 'Show less' : `Show all (${groupedAbsences.length})`}
```
With:
```typescript
{showAllAbsences ? 'Show less' : `Show all (${filteredAbsences.length})`}
```

Now update the list item rendering to add the dismiss button. Replace the existing `<li>` element (the return statement inside the `.map()`):

```typescript
return (
  <li key={g.key} className={`${base} ${color} rounded`}>
    <span className="font-medium text-gray-900 dark:text-gray-100">{g.name}</span>
    <div className="flex items-center space-x-2">
      <span className="text-sm text-gray-700 dark:text-gray-300">Missed {g.streak} {g.streak === 1 ? 'service' : 'services'} in a row</span>
      <button
        type="button"
        onClick={() => handleDismissAbsence(g.key)}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        title="Dismiss — won't show again until 3 more absences"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  </li>
);
```

Note: `XMarkIcon` is already imported at line 27.

- [ ] **Step 4: Rebuild client and verify visually**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
```

Open the reports page in the browser. Verify:
1. Absence list renders as before with an "X" button on each row
2. Clicking "X" removes the item from the list
3. Refreshing the page still hides dismissed absences

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/ReportsPage.tsx
git commit -m "feat: add absence dismissal UI to reports page"
```

---

### Task 6: Filter Dismissed Absences in Weekly Review Email

**Files:**
- Modify: `server/services/weeklyReview.js:883` (the `getNewlyDisengaged` function)

- [ ] **Step 1: Add NOT EXISTS clause to exclude dismissed individuals**

In `server/services/weeklyReview.js`, in the `getNewlyDisengaged` function, add a `NOT EXISTS` clause to the main query. The current query (starting around line 883) selects individuals who were present in weeks 4-6 but absent in weeks 1-3. Add the dismissal filter after the existing `AND NOT EXISTS` block (after line 902):

Replace the query from line 883 to 904:

```javascript
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
       AND NOT EXISTS (
         SELECT 1 FROM absence_dismissals ad
         WHERE ad.individual_id = i.id AND ad.church_id = ?
       )
     ORDER BY i.last_name, i.first_name`,
    [churchId, churchId, olderStart, recentStart, churchId, recentStart, endDate, churchId]
  );
```

This is a simpler filter than the reports page uses — it excludes anyone with ANY active dismissal. Since the weekly review doesn't compute per-gathering streaks the same way, and dismissals are auto-cleaned when someone attends, any active dismissal means the absence is still expected.

- [ ] **Step 2: Rebuild server and verify**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs --tail=10 server
```

- [ ] **Step 3: Commit**

```bash
git add server/services/weeklyReview.js
git commit -m "feat: exclude dismissed absences from weekly review email"
```

---

### Task 7: Auto-cleanup Stale Dismissals

**Files:**
- Modify: `server/services/weeklyReview.js` (add cleanup function and call it during review generation)

- [ ] **Step 1: Add cleanup function**

In `server/services/weeklyReview.js`, add a new function before the `getNewlyDisengaged` function (around line 870):

```javascript
/**
 * Clean up absence dismissals for individuals who have attended recently.
 * An individual's dismissal is removed if they were present in any of the last 3 sessions
 * for the dismissed gathering, meaning their streak has reset.
 */
async function cleanupStaleDismissals(churchId) {
  try {
    // Delete dismissals where the individual has attended recently (streak reset)
    await Database.query(
      `DELETE FROM absence_dismissals
       WHERE church_id = ?
         AND EXISTS (
           SELECT 1 FROM attendance_records ar
           JOIN attendance_sessions s ON s.id = ar.session_id
           WHERE ar.individual_id = absence_dismissals.individual_id
             AND s.gathering_type_id = absence_dismissals.gathering_type_id
             AND ar.present = 1
             AND s.church_id = ?
             AND s.excluded_from_stats = 0
             AND s.session_date >= date('now', '-21 days')
         )`,
      [churchId, churchId]
    );
  } catch (error) {
    console.error('Failed to cleanup stale dismissals:', error);
    // Non-critical — don't fail the weekly review
  }
}
```

- [ ] **Step 2: Call cleanup during weekly review generation**

Find where `getNewlyDisengaged` is called (around line 201). Add the cleanup call just before it:

```javascript
    await cleanupStaleDismissals(churchId);
    followUpData = await getNewlyDisengaged(churchId, endDate);
```

- [ ] **Step 3: Rebuild server and verify**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs --tail=10 server
```

- [ ] **Step 4: Commit**

```bash
git add server/services/weeklyReview.js
git commit -m "feat: auto-cleanup stale absence dismissals during weekly review"
```
