# Mobile Gathering Dropdown & Exclude from Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the finicky mobile gathering tab strip with a native dropdown, and add the ability to exclude attendance sessions from stats.

**Architecture:** Two independent changes. Change 1 is frontend-only — swap the mobile tab strip for a `<select>`. Change 2 spans schema, API, WebSocket, frontend, and reporting queries — add `excluded_from_stats` column and filter it in all stats queries.

**Tech Stack:** React/TypeScript, Node.js/Express, SQLite, Socket.io, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-28-mobile-dropdown-exclude-stats-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `client/src/pages/AttendancePage.tsx` | Replace mobile tabs with `<select>`, add exclude UI |
| Modify | `server/config/schema.js` | Add `excluded_from_stats` column to `attendance_sessions` |
| Modify | `server/startup.js` | Add migration for existing databases |
| Modify | `server/routes/attendance.js` | Add PATCH exclude endpoint, return `excluded_from_stats` in responses |
| Modify | `client/src/services/api.ts` | Add `toggleExcludeFromStats` API method |
| Modify | `server/services/websocket.js` | Broadcast `session:excluded` event |
| Modify | `server/routes/reports.js` | Filter excluded sessions from all stats queries |
| Modify | `server/services/weeklyReview.js` | Filter excluded sessions from weekly review queries |
| Modify | `server/services/weeklyReviewScheduler.js` | Filter excluded sessions from `hasMainGatheringData` |
| Modify | `server/routes/ai.js` | Filter excluded sessions from AI context queries |
| Modify | `server/routes/individuals.js` | Filter excluded sessions from attendance history |
| Modify | `server/routes/gatherings.js` | Filter excluded sessions from gathering stats |
| Modify | `server/utils/attendanceNotifications.js` | Filter excluded sessions from notification logic |
| Modify | `server/admin/index.js` | Filter excluded sessions from admin stats |

---

## Task 1: Mobile Gathering Dropdown (Frontend Only)

**Files:**
- Modify: `client/src/pages/AttendancePage.tsx:2463-2539` (mobile tab section)

- [ ] **Step 1: Replace mobile tab strip with native `<select>`**

In `AttendancePage.tsx`, replace the mobile tab section (the `<div className="block md:hidden">` block, lines ~2463-2539) with:

```tsx
{/* Mobile: Dropdown selector */}
<div className="block md:hidden">
  <div className="flex items-center space-x-2">
    <select
      value={selectedGathering?.id || ''}
      onChange={(e) => {
        const gathering = (orderedGatherings.length ? orderedGatherings : gatherings)
          .find(g => g.id === parseInt(e.target.value));
        if (gathering) handleGatheringChange(gathering);
      }}
      className="flex-1 h-10 px-3 text-sm font-medium border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500"
    >
      {(orderedGatherings.length ? orderedGatherings : gatherings).map((gathering) => (
        <option key={gathering.id} value={gathering.id}>
          {gathering.name}
        </option>
      ))}
    </select>

    {(orderedGatherings.length ? orderedGatherings : gatherings).length > 1 && (
      <button
        onClick={() => openReorderModal()}
        className="h-10 w-10 flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        title="Edit gathering order"
      >
        <PencilIcon className="h-4 w-4" />
      </button>
    )}
  </div>
</div>
```

This replaces the entire `block md:hidden` div including the fade indicators and touch/drag handlers on mobile. Desktop tabs remain unchanged.

- [ ] **Step 2: Build and verify in Docker**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs -f client
```

Check logs for build errors. Visually verify on mobile viewport that the dropdown works and desktop tabs are unaffected.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/AttendancePage.tsx
git commit -m "feat: replace mobile gathering tabs with native dropdown

Replaces the finicky horizontal scrollable tab strip on mobile with a
clean native <select> dropdown. Edit Order button sits beside the
dropdown. Desktop tabs unchanged."
```

---

## Task 2: Schema & Migration for `excluded_from_stats`

**Files:**
- Modify: `server/config/schema.js:210-224` (attendance_sessions CREATE TABLE)
- Modify: `server/startup.js:14-18` (migrationFiles array), `server/startup.js:56-72` (migration execution)

- [ ] **Step 1: Add column to schema.js**

In `server/config/schema.js`, add `excluded_from_stats INTEGER DEFAULT 0` to the `attendance_sessions` CREATE TABLE, after the `roster_snapshotted` line:

```sql
  roster_snapshotted INTEGER DEFAULT 0,
  excluded_from_stats INTEGER DEFAULT 0,
```

- [ ] **Step 2: Add migration to startup.js**

In `server/startup.js`, add to the `migrationFiles` array (line ~18):

```javascript
{ version: 'v1.11.0_add_excluded_from_stats', name: 'add_excluded_from_stats', description: 'Add excluded_from_stats column to attendance_sessions' }
```

Then add the migration handler after the last `if (migration.version === ...)` block (after line ~72):

```javascript
if (migration.version === 'v1.11.0_add_excluded_from_stats') {
  const cols = await Database.query(`PRAGMA table_info(attendance_sessions)`);
  if (!cols.some(c => c.name === 'excluded_from_stats')) {
    await Database.query(`ALTER TABLE attendance_sessions ADD COLUMN excluded_from_stats INTEGER DEFAULT 0`);
    console.log(`  ✅ Added excluded_from_stats column to attendance_sessions`);
  }
}
```

- [ ] **Step 3: Build and verify**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs -f server
```

Check logs for successful migration message.

- [ ] **Step 4: Commit**

```bash
git add server/config/schema.js server/startup.js
git commit -m "feat: add excluded_from_stats column to attendance_sessions

Adds schema column and migration for marking sessions as excluded
from reporting stats (e.g., gatherings that did not meet)."
```

---

## Task 3: API Endpoint for Toggling Exclusion

**Files:**
- Modify: `server/routes/attendance.js:1-9` (imports), add new route
- Modify: `server/services/websocket.js:1190` (add broadcast method)
- Modify: `client/src/services/api.ts:359-420` (attendanceAPI)

- [ ] **Step 1: Add PATCH endpoint to attendance.js**

Add after the existing routes (before the parameterized routes to avoid shadowing). Place it near line ~965 (after the `/visitors/all` and `/people/all` routes, before the `/:gatheringTypeId/:date` routes):

```javascript
// Toggle exclude from stats for a session (Admin and Coordinator only)
router.patch('/sessions/:sessionId/exclude',
  disableCache,
  requireRole(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const { sessionId } = req.params;

      // Find session with church isolation
      const sessions = await Database.query(
        'SELECT id, excluded_from_stats, gathering_type_id, session_date FROM attendance_sessions WHERE id = ? AND church_id = ?',
        [sessionId, req.user.church_id]
      );

      if (sessions.length === 0) {
        return res.status(404).json({ error: 'Session not found.' });
      }

      const session = sessions[0];
      const newValue = session.excluded_from_stats ? 0 : 1;

      await Database.query(
        'UPDATE attendance_sessions SET excluded_from_stats = ? WHERE id = ? AND church_id = ?',
        [newValue, sessionId, req.user.church_id]
      );

      // Broadcast to other connected clients
      const { broadcastSessionExcluded } = require('../utils/websocketBroadcast');
      broadcastSessionExcluded(
        session.gathering_type_id,
        session.session_date,
        req.user.church_id,
        { excludedFromStats: newValue === 1 }
      );

      res.json({
        message: newValue ? 'Session excluded from stats.' : 'Session included in stats.',
        excludedFromStats: newValue === 1,
        sessionId: parseInt(sessionId)
      });
    } catch (error) {
      console.error('Toggle exclude from stats error:', error);
      res.status(500).json({ error: 'Failed to update session.' });
    }
  }
);
```

- [ ] **Step 2: Add WebSocket broadcast helper**

Check `server/utils/websocketBroadcast.js` for existing broadcast functions, then add:

```javascript
function broadcastSessionExcluded(gatheringId, date, churchId, data) {
  if (!webSocketService) {
    return;
  }
  webSocketService.broadcastAttendanceUpdate(gatheringId, date, churchId, {
    type: 'session_excluded',
    ...data
  });
}
```

Add `broadcastSessionExcluded` to the `module.exports` object at line ~164.

- [ ] **Step 3: Return `excluded_from_stats` in getFull response**

In `server/routes/attendance.js`, in the `/full` endpoint (~line 1194), update the session query to also SELECT `excluded_from_stats`:

```javascript
'SELECT id, roster_snapshotted, excluded_from_stats FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
```

Then include it in the response data (~line 1465). Add to the `responseData` object:

```javascript
const responseData = processApiResponse({
  sessionId: sessionId,
  excludedFromStats: sessions.length > 0 ? (sessions[0].excluded_from_stats === 1) : false,
  attendanceList: attendanceList.map(attendee => ({
```

Also do the same for the regular GET `/:gatheringTypeId/:date` endpoint — update its session query similarly and include `excludedFromStats` in its response.

- [ ] **Step 4: Add API method to client**

In `client/src/services/api.ts`, add to the `attendanceAPI` object (after `updateUserHeadcount`, before the closing `}`):

```typescript
toggleExcludeFromStats: (sessionId: number) =>
  api.patch(`/attendance/sessions/${sessionId}/exclude`),
```

- [ ] **Step 5: Build and verify**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs -f server
```

- [ ] **Step 6: Commit**

```bash
git add server/routes/attendance.js server/utils/websocketBroadcast.js server/services/websocket.js client/src/services/api.ts
git commit -m "feat: add API endpoint for toggling session exclude-from-stats

PATCH /api/attendance/sessions/:sessionId/exclude toggles the flag.
Restricted to admin/coordinator. Broadcasts via WebSocket.
Returns excludedFromStats in getFull and GET responses."
```

---

## Task 4: Frontend UI for Exclude from Stats

**Files:**
- Modify: `client/src/pages/AttendancePage.tsx`

- [ ] **Step 1: Add state for excludedFromStats and sessionId**

Near the existing state declarations (~line 68), add:

```tsx
const [excludedFromStats, setExcludedFromStats] = useState(false);
const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
```

- [ ] **Step 2: Set state from API response**

In the data fetch effect (where `attendanceAPI.getFull` is called, ~line 966), after processing the response, set:

```tsx
setExcludedFromStats(apiResponse.data.excludedFromStats || false);
setCurrentSessionId(apiResponse.data.sessionId || null);
```

Reset these when gathering/date changes (in the early return guard ~line 898):

```tsx
setExcludedFromStats(false);
setCurrentSessionId(null);
```

- [ ] **Step 3: Handle WebSocket session:excluded event**

In the WebSocket event handler (~line 1427), add handling for `session_excluded` type:

```tsx
// Handle session exclusion updates
if (data.type === 'session_excluded') {
  setExcludedFromStats(data.excludedFromStats);
}
```

- [ ] **Step 4: Add exclude toggle UI**

Add an "Excluded from stats" banner and toggle button. Place it after the date/controls grid section (~line 2733, after the closing `</div>` of the grid) and before the Attendance Summary Bar:

```tsx
{/* Excluded from Stats Banner */}
{excludedFromStats && (
  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg px-4 py-3 flex items-center justify-between">
    <div className="flex items-center space-x-2">
      <XMarkIcon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
      <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
        This session is excluded from stats
      </span>
    </div>
    {(user?.role === 'admin' || user?.role === 'coordinator') && currentSessionId && (
      <button
        onClick={async () => {
          try {
            await attendanceAPI.toggleExcludeFromStats(currentSessionId);
            setExcludedFromStats(false);
            showSuccess('Session included in stats');
          } catch (err) {
            console.error('Failed to include session:', err);
          }
        }}
        className="text-sm text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 underline"
      >
        Include in stats
      </button>
    )}
  </div>
)}
```

- [ ] **Step 5: Add three-dot menu with exclude option**

Add a menu button near the gathering name in the controls area. A good location is after the "Meeting Date" label section (~line 2689), inside the grid. Add a third column or place it in the header area.

Simpler approach: add the exclude option as a small button next to the date label, only for admin/coordinator when a session exists:

```tsx
{/* Exclude from Stats Toggle - Admin/Coordinator only */}
{(user?.role === 'admin' || user?.role === 'coordinator') && currentSessionId && !excludedFromStats && (
  <div className="flex items-center justify-end md:col-span-2">
    <button
      onClick={async () => {
        try {
          await attendanceAPI.toggleExcludeFromStats(currentSessionId);
          setExcludedFromStats(true);
          showSuccess('Session excluded from stats');
        } catch (err) {
          console.error('Failed to exclude session:', err);
        }
      }}
      className="text-xs text-gray-500 dark:text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 flex items-center space-x-1"
    >
      <XMarkIcon className="h-3.5 w-3.5" />
      <span>Exclude from stats</span>
    </button>
  </div>
)}
```

- [ ] **Step 6: Grey out attendance list when excluded**

Wrap the attendance list and visitor sections with a conditional opacity/pointer-events class. Find the attendance content sections (starting ~line 2738 for the summary bar, ~line 2894 for the main content) and add a wrapper:

```tsx
<div className={excludedFromStats ? 'opacity-50 pointer-events-none' : ''}>
  {/* existing attendance content */}
</div>
```

Apply this to:
- The Attendance Summary Bar (~line 2738)
- The main attendance/headcount content (~line 2894)
- The visitors section (~line 3142)
- The add visitor button/modal trigger (~line 3314)

- [ ] **Step 7: Build and verify**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs -f client
```

Verify:
- Banner appears when session is excluded
- Attendance list is greyed out and non-interactive
- Admin/coordinator can toggle, attendance_taker sees banner but no toggle
- WebSocket broadcasts update other tabs

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/AttendancePage.tsx
git commit -m "feat: add exclude-from-stats UI on attendance page

Shows amber banner when session is excluded. Attendance list greyed
out and non-interactive. Admin/coordinator can toggle. Syncs via
WebSocket to other connected clients."
```

---

## Task 5: Filter Excluded Sessions from Reporting Queries

This is the largest task — updating all stats/aggregation queries across the codebase to add `AND excluded_from_stats = 0` (or equivalent alias like `AND as_table.excluded_from_stats = 0`).

**Important:** Only add the filter to queries that aggregate across multiple sessions for reporting. Do NOT add it to single-session data-fetch queries (like the `/full` endpoint).

**Files:**
- Modify: `server/routes/reports.js`
- Modify: `server/services/weeklyReview.js`
- Modify: `server/services/weeklyReviewScheduler.js`
- Modify: `server/routes/ai.js`
- Modify: `server/routes/attendance.js` (getLastNServiceDates, getVisitorAbsenceCounts)
- Modify: `server/routes/individuals.js`
- Modify: `server/routes/gatherings.js`
- Modify: `server/utils/attendanceNotifications.js`
- Modify: `server/admin/index.js`

- [ ] **Step 1: Update `server/routes/reports.js`**

Find every query that references `attendance_sessions` (aliased as `as_table` or similar). Add `AND as_table.excluded_from_stats = 0` (or the appropriate alias) to each WHERE clause. This includes:
- Dashboard headcount query (~line 142)
- Dashboard standard query (~line 168)
- Dashboard mixed headcount query (~line 193)
- Visitor breakdown query (~line 242)
- Total visitors query (~line 440)
- Export: distinct sessions (~line 542)
- Export: people who attended (~line 578)
- Export: attendance data matrix (~line 603)

For each query, find where `attendance_sessions` appears and add the filter. Use the alias the query uses (often `as_table` in reports.js).

- [ ] **Step 2: Update `server/services/weeklyReview.js`**

Add `AND excluded_from_stats = 0` to all `attendance_sessions` queries. Functions to update:
- `getWeeklySessionsForGathering` (~line 40)
- `getWeeklyTotals` (~line 245)
- `getRegularsAttendanceForWeek` (~line 313)
- `getNewVisitors` (~line 515)
- `getInactiveRegulars` (~line 876)
- `getNewVisitorsThisWeek` (~line 927)
- `getSessionDates` (~line 567)
- `getWeatherData` (~line 653) — use the alias from the query

- [ ] **Step 3: Update `server/services/weeklyReviewScheduler.js`**

Update `hasMainGatheringData` query (~line 98) to add `AND s.excluded_from_stats = 0` (use the alias in the query).

- [ ] **Step 4: Update `server/routes/ai.js`**

Add filter to all `attendance_sessions` queries in `getChurchAttendanceContext`:
- Standard attendance summary (~line 158)
- Headcount summary (~line 181)
- Individual records (~line 203)
- Weather history dates (~line 653)

- [ ] **Step 5: Update `server/routes/attendance.js` (stats queries only)**

Update these helper functions:
- `getLastNServiceDates` (~line 748): Add `AND excluded_from_stats = 0` to the WHERE clause
- `getVisitorAbsenceCounts` (~line 825): Add `AND s.excluded_from_stats = 0` (using the session alias)

Do NOT update single-session queries like the GET or POST endpoints.

- [ ] **Step 6: Update `server/routes/individuals.js`**

Update individual attendance history query (~line 557) to add `AND as_table.excluded_from_stats = 0` (use the appropriate alias).

- [ ] **Step 7: Update `server/routes/gatherings.js`**

Update:
- `hasAttendanceRecords` query (~line 194): Do NOT filter here — this checks if a gathering was ever used (for deletion safety), not for stats. Excluded sessions still count as "used."
- Gathering details stats query (~line 30): Add filter to attendance_sessions JOIN/subquery (this is a stats aggregation)

- [ ] **Step 8: Update `server/utils/attendanceNotifications.js`**

Update recent sessions query (~line 17): Add `AND excluded_from_stats = 0`

- [ ] **Step 9: Update `server/services/websocket.js`**

Update the `getServiceDates` query (~line 918) that queries `attendance_sessions` for visitor filtering. Add `AND excluded_from_stats = 0` to the WHERE clause.

- [ ] **Step 10: Update `server/admin/index.js`**

Update:
- Admin dashboard attendance stats (~line 132): Add filter
- User activity count (~line 176): Add filter

- [ ] **Step 11: Build and verify**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs -f server
```

Check server starts without errors. Test the dashboard still loads correctly.

- [ ] **Step 12: Commit**

```bash
git add server/routes/reports.js server/services/weeklyReview.js server/services/weeklyReviewScheduler.js server/routes/ai.js server/routes/attendance.js server/routes/individuals.js server/routes/gatherings.js server/utils/attendanceNotifications.js server/services/websocket.js server/admin/index.js
git commit -m "feat: filter excluded sessions from all stats and reporting queries

Adds excluded_from_stats = 0 filter to ~35 queries across reports,
weekly review, AI insights, attendance helpers, individual history,
gathering stats, notifications, and admin dashboard."
```

---

## Task 6: Final Integration Verification

- [ ] **Step 1: Full rebuild and smoke test**

```bash
docker-compose -f docker-compose.dev.yml down
docker-compose -f docker-compose.dev.yml build
docker-compose -f docker-compose.dev.yml up -d
```

- [ ] **Step 2: Verify end-to-end**

Test checklist:
1. Mobile: gathering dropdown works, can select gatherings, can open Edit Order
2. Desktop: tabs unchanged, still work as before
3. Take attendance for a session, then exclude it — banner appears, list greys out
4. Re-include the session — banner disappears, list becomes interactive
5. Check dashboard — excluded session should not appear in charts/stats
6. Open a second browser tab — WebSocket sync works when toggling exclusion
7. Login as attendance_taker — banner visible but no toggle button

- [ ] **Step 3: Commit any fixes**

If any issues found during verification, fix and commit.
