# Absence Dismissal Feature

## Problem

The reports page shows regulars with consecutive absences, but some absences are expected (chronic illness, holidays) and not concerning. These clutter the absence list for admins/coordinators and appear in the weekly review email unnecessarily.

## Solution

Allow admins/coordinators to dismiss an absence entry from the reports page. A dismissed person/family reappears only after accumulating 3 additional consecutive absences beyond their streak at dismissal time. Dismissals are shared across all users and respected by the weekly review email.

## Data Model

New table `absence_dismissals`:

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `individual_id` | INTEGER NOT NULL | FK to `individuals` |
| `gathering_type_id` | INTEGER NOT NULL | FK to `gathering_types` |
| `dismissed_at_streak` | INTEGER NOT NULL | Streak count when dismissed |
| `dismissed_by` | INTEGER | FK to `users` |
| `church_id` | TEXT | Church isolation |
| `created_at` | TEXT DEFAULT (datetime('now')) | |

Constraints:
- `UNIQUE(individual_id, gathering_type_id)` — one active dismissal per person per gathering
- Standard foreign keys to `individuals`, `gathering_types`, `users`

When a family group is dismissed, a row is inserted for each family member. This keeps the schema flat and survives family grouping changes.

### Re-show Logic

A dismissed person reappears when: `current_streak >= dismissed_at_streak + 3`

### Auto-cleanup

When a person's streak resets to 0 (they attended), their dismissal row is deleted. This happens:
- On the server during weekly review processing
- Could also be cleaned up lazily when dismissals are fetched

## API

### `POST /api/reports/dismiss-absence`

Requires role: `admin` or `coordinator`.

**Request body:**
```json
{
  "key": "ind:123",
  "gatheringTypeIds": [1, 2]
}
```

- `key` uses the existing `groupedAbsences` key format: `ind:{id}` for individuals, `fam:{id}` for family groups
- `gatheringTypeIds` is the array of currently selected gatherings on the reports page
- For `fam:` keys, look up all family members and insert a dismissal row for each
- The current streak must be computed at dismiss time to populate `dismissed_at_streak`

**Response:** `{ success: true }`

### `GET /api/reports/dismissals`

Requires role: `admin` or `coordinator`.

**Query params:** `gatheringTypeIds[]` — the gatherings to fetch dismissals for.

**Response:**
```json
{
  "dismissals": [
    { "individualId": 123, "gatheringTypeId": 1, "dismissedAtStreak": 4 }
  ]
}
```

Used by the reports page to filter the absence list client-side.

## Frontend Changes

### Reports Page (`ReportsPage.tsx`)

1. **Fetch dismissals:** After metrics load, fetch active dismissals for the selected gatherings via `GET /api/reports/dismissals`.

2. **Filter absences:** Before rendering `groupedAbsences`, filter out entries where all associated individuals have an active dismissal and `current_streak < dismissed_at_streak + 3`.

3. **Dismiss button:** Add an "X" button on each absence row. On click:
   - Call `POST /api/reports/dismiss-absence` with the item's `key` and `selectedGatherings` IDs
   - On success, remove the item from the displayed list immediately (optimistic update)
   - No confirmation modal needed

## Weekly Review Email Integration

### `getNewlyDisengaged` in `weeklyReview.js`

Add a `NOT EXISTS` clause to exclude individuals with active dismissals where `current_streak < dismissed_at_streak + 3`. The streak computation already happens in this function's logic, so the check integrates naturally.

### Auto-cleanup

During weekly review processing, delete dismissal rows for individuals whose streak is 0 (they've attended recently). This keeps the table clean and ensures returning members show up fresh if they start missing again.

## Scope

- Per-gathering dismissals (dismiss from Sunday but still show on Wednesday)
- Family-grouped dismissals dismiss all members when the absence was shown as a family
- Shared across all admins/coordinators (server-side storage)
- No reason/note field — this is not a CRM
- No undo UI — auto-cleanup on attendance handles the lifecycle
