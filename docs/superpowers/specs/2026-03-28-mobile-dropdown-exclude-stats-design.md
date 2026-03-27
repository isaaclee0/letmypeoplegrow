# Mobile Gathering Dropdown & Exclude from Stats

**Date:** 2026-03-28
**Status:** Approved

## Overview

Two changes to the Attendance Page:
1. Replace the finicky mobile scrollable tab strip with a native `<select>` dropdown
2. Add the ability to mark attendance sessions as "excluded from stats" (DNM / incomplete data)

---

## Change 1: Mobile Gathering Dropdown

### Current State
Mobile uses a horizontally scrollable tab strip with drag-to-scroll, fade indicators, and touch handlers (via `useTabSlider` hook). This is finicky and not smooth on mobile.

### Design
- Replace the mobile tab strip (`block md:hidden` section, lines ~2464-2539 in AttendancePage.tsx) with a native `<select>` element.
- The `<select>` lists all gatherings using `orderedGatherings` (falling back to `gatherings`). Selecting one calls `handleGatheringChange()`.
- An "Edit Order" button (pencil icon) sits beside the dropdown, visible only when 2+ gatherings exist. It opens the existing `openReorderModal()`.
- Desktop tabs remain unchanged — the `useTabSlider` hook continues to be used for desktop only.
- The mobile fade indicators, touch handlers, and mobile `tabSliderRef` become unused on mobile but require no breaking changes since desktop still uses the hook. The hook handles null refs safely (all handlers guard with `if (!sliderRef.current) return`).

### UI Layout
```
[ Select: Sunday Morning Service  v ] [ pencil icon ]
```

Styled with standard Tailwind form classes to match the app's design language. Dark mode support included.

---

## Change 2: Exclude from Stats

### Problem
Sometimes a gathering doesn't meet (e.g., extreme weather) or has incomplete data. Currently there's no way to exclude these sessions from reporting, which skews stats.

### Design

#### Schema
Add `excluded_from_stats INTEGER DEFAULT 0` to the `attendance_sessions` table in `server/config/schema.js`.

For existing databases, add an `ALTER TABLE` migration in the schema initialization block (same pattern as other migrations in the codebase).

#### API
- **New endpoint:** `PATCH /api/attendance/sessions/:sessionId/exclude`
  - Toggles `excluded_from_stats` between 0 and 1
  - Restricted to `admin` and `coordinator` roles
  - Returns the updated session with the new `excluded_from_stats` value
  - **Session must exist:** Returns 404 if no session row exists (sessions are created lazily on first attendance interaction — you cannot exclude a session that was never started). The UI hides the menu item when there is no session.
  - **Church isolation:** The UPDATE query must filter by both `id = :sessionId` AND `church_id = req.user.church_id` to enforce church isolation.

- **Existing endpoint:** The attendance GET endpoints (`getFull`, etc.) include `excluded_from_stats` in their response so the frontend knows the current state.

- **WebSocket broadcast:** When exclusion is toggled, broadcast a `session:excluded` event to all clients in the same gathering+date room, following the existing pattern for `attendance:update` and `headcount:update`. Other connected clients update their UI accordingly.

#### Frontend — Attendance Page
- A three-dot menu (EllipsisHorizontalIcon, already imported) near the gathering name/date header area.
- Menu contains: "Exclude from stats" / "Include in stats" (label toggles based on current state).
- Only visible to users with `admin` or `coordinator` role.
- When a session is excluded:
  - A banner appears: "This session is excluded from stats" with an option to re-include.
  - The attendance list (individuals, families, visitors) is greyed out (`opacity-50 pointer-events-none`).
  - Headcount mode similarly greyed out and non-interactive.
  - Existing attendance data is preserved — not deleted.

#### Reporting — Queries to Update
All reporting/stats queries that reference `attendance_sessions` need `AND excluded_from_stats = 0` (or equivalent) added. Files affected:

| File | Queries | Description |
|------|---------|-------------|
| `server/routes/reports.js` | ~8 queries | Dashboard charts, metrics, visitor counts, export |
| `server/services/weeklyReview.js` | ~10 queries | Weekly session comparisons, totals, regulars, visitors, inactive |
| `server/services/weeklyReviewScheduler.js` | 1 query | `hasMainGatheringData` — email trigger |
| `server/routes/ai.js` | ~5 queries | AI context: attendance summaries, headcounts, individual records |
| `server/routes/attendance.js` | ~2 queries | Visitor absence counts, last N service dates |
| `server/routes/individuals.js` | 1 query | Individual attendance history |
| `server/routes/gatherings.js` | ~2 queries | Gathering stats, has-records check |
| `server/utils/attendanceNotifications.js` | 1 query | Notification threshold logic |
| `server/services/websocket.js` | 1 query | Service dates for UI |
| `server/admin/index.js` | 2 queries | Admin dashboard stats |

**Important distinction:** Only queries that **aggregate across multiple sessions** for reporting purposes need the filter. Queries that fetch data for a **single session** the user is viewing (e.g., the `/full` endpoint) should NOT add the filter — users need to view and manage excluded sessions. All data (attendance records, headcount records) for excluded sessions is preserved.

**Pattern:** Where the query already has a WHERE clause on `attendance_sessions`, add `AND as.excluded_from_stats = 0`. Where it's a JOIN, add the condition to the JOIN or a WHERE clause. Use the table alias consistently.

#### Permissions
- Only `admin` and `coordinator` roles can toggle the exclusion.
- `attendance_taker` role sees the banner but cannot change the state.

---

## Out of Scope
- Audit trail (who excluded, when, why) — can be added later if needed
- Bulk exclusion of multiple sessions
- Reason/note field for why a session was excluded
