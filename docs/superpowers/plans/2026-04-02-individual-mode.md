# Individual Mode per Gathering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-gathering `individual_mode` flag so youth groups and other individual-first churches get a sensible default view and an add-people form that matches their mental model.

**Architecture:** One new DB column on `gathering_types`, threaded through the server route and TypeScript types, then consumed in three places: the gathering creation wizard (sets the flag), the attendance page (uses it to default `groupByFamily`), and the Add People modal (uses it to choose which form variant to render).

**Tech Stack:** SQLite via better-sqlite3, Express.js, React 19, TypeScript, Vitest + React Testing Library (jsdom)

---

## File Map

| File | What changes |
|---|---|
| `server/config/schema.js` | Add `individual_mode INTEGER DEFAULT 0` to `gathering_types` CREATE TABLE |
| `server/routes/gatherings.js` | SELECT / INSERT / UPDATE to include `individual_mode` |
| `client/src/services/api.ts` | Add `individualMode?: boolean` to `GatheringType` interface and `gatheringsAPI.create` param type |
| `client/src/pages/ManageGatheringsPage.tsx` | Local `Gathering` + `CreateGatheringData` interfaces; new wizard question; wire to API call |
| `client/src/pages/AttendancePage.tsx` | `useEffect` to initialise `groupByFamily` from gathering's `individualMode` |
| `client/src/components/people/AddPeopleModal.tsx` | New `defaultMode` + `showModeToggle` props; individual-cards form variant; sibling linking; save logic |
| `client/src/pages/PeoplePage.tsx` | Derive `defaultMode` from `gatheringTypes`; pass new props to `AddPeopleModal` |

---

## Task 1 — Schema: add `individual_mode` column

**Files:**
- Modify: `server/config/schema.js`

- [ ] **Step 1: Add the column to the CREATE TABLE statement**

Open `server/config/schema.js` and find the `gathering_types` CREATE TABLE block. It currently ends with:

```sql
  leader_checkin_enabled INTEGER DEFAULT 0,
  kiosk_message TEXT,
  kiosk_end_time TEXT,
  group_by_family INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
```

Add `individual_mode` after `group_by_family`:

```sql
  leader_checkin_enabled INTEGER DEFAULT 0,
  kiosk_message TEXT,
  kiosk_end_time TEXT,
  group_by_family INTEGER DEFAULT 1,
  individual_mode INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
```

- [ ] **Step 2: Add an ALTER TABLE migration for existing databases**

Still in `schema.js`, find where migrations for existing tables are applied (look for `ALTER TABLE` statements or a migration runner block). Following the existing pattern, add:

```javascript
// Migrate existing gathering_types tables
try {
  db.exec('ALTER TABLE gathering_types ADD COLUMN individual_mode INTEGER DEFAULT 0');
} catch (e) {
  // Column already exists — safe to ignore
}
```

If no migration runner block exists yet, check `docs/DATABASE_MIGRATION_GUIDE_SIMPLIFIED.md` for the project's migration pattern and follow it exactly.

- [ ] **Step 3: Verify by starting the server and checking the column exists**

```bash
cd server && npm run dev
```

Then in a separate terminal:

```bash
sqlite3 server/data/churches/<any_church_id>.sqlite ".schema gathering_types"
```

Expected output includes: `individual_mode INTEGER DEFAULT 0`

- [ ] **Step 4: Commit**

```bash
git add server/config/schema.js
git commit -m "feat: add individual_mode column to gathering_types"
```

---

## Task 2 — Server: wire `individual_mode` through gatherings.js

**Files:**
- Modify: `server/routes/gatherings.js`

- [ ] **Step 1: Add `individual_mode` to the GET SELECT query**

Find the GET all gatherings handler. The SELECT currently lists columns explicitly (line ~20 and ~42). Add `gt.individual_mode` to both SELECT lists:

```sql
SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.end_time,
       gt.frequency, gt.attendance_type, gt.custom_schedule, gt.kiosk_enabled,
       gt.leader_checkin_enabled, gt.kiosk_message, gt.is_active, gt.individual_mode,
       gt.created_at,
```

Do this for both occurrences (lines ~20 and ~42).

- [ ] **Step 2: Accept `individualMode` in the POST route**

In the POST handler (line ~127), update the destructure:

```javascript
const {
  name, description, dayOfWeek, startTime, endTime, frequency,
  attendanceType, customSchedule, setAsDefault,
  kioskEnabled, leaderCheckinEnabled, kioskEndTime, kioskMessage,
  individualMode   // ← add this
} = req.body;
```

Update the INSERT query (line ~147) to include the column:

```javascript
const result = await Database.query(`
  INSERT INTO gathering_types (
    name, description, day_of_week, start_time, end_time, frequency,
    attendance_type, custom_schedule, kiosk_enabled, leader_checkin_enabled,
    kiosk_message, individual_mode, created_by, church_id
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, [
  name,
  description,
  isHeadcountWithCustom ? null : dayOfWeek,
  isHeadcountWithCustom ? null : startTime,
  isHeadcountWithCustom ? null : (endTime || null),
  isHeadcountWithCustom ? null : (frequency || 'weekly'),
  attendanceType,
  customSchedule ? JSON.stringify(customSchedule) : null,
  attendanceType === 'standard' && kioskEnabled ? true : false,
  attendanceType === 'standard' && leaderCheckinEnabled ? true : false,
  kioskMessage || null,
  attendanceType === 'standard' && individualMode ? true : false,  // ← add
  req.user.id,
  req.user.church_id
]);
```

- [ ] **Step 3: Accept `individualMode` in the PUT route**

In the PUT handler (line ~253), update the destructure:

```javascript
const {
  name, description, dayOfWeek, startTime, endTime, frequency,
  attendanceType, customSchedule,
  kioskEnabled, leaderCheckinEnabled, kioskEndTime, kioskMessage,
  individualMode   // ← add this
} = req.body;
```

Update the UPDATE query's SET clause to include `individual_mode`:

```javascript
const result = await Database.query(`
  UPDATE gathering_types
  SET name = ?, description = ?, day_of_week = ?, start_time = ?, end_time = ?,
      frequency = ?,
      attendance_type = COALESCE(?, attendance_type),
      custom_schedule = ?,
      kiosk_enabled = ?,
      leader_checkin_enabled = ?,
      kiosk_message = ?,
      individual_mode = ?
  WHERE id = ? AND church_id = ?
`, [
  name,
  description,
  isHeadcountWithCustom ? null : dayOfWeek,
  isHeadcountWithCustom ? null : startTime,
  isHeadcountWithCustom ? null : (endTime || null),
  isHeadcountWithCustom ? null : (frequency || 'weekly'),
  attendanceType,
  customSchedule ? JSON.stringify(customSchedule) : null,
  kioskValue,
  leaderCheckinValue,
  kioskMessage || null,
  attendanceType === 'standard' && individualMode ? true : false,  // ← add
  gatheringId,
  req.user.church_id
]);
```

- [ ] **Step 4: Verify via curl**

With the dev server running:

```bash
# Create a test gathering
curl -s -X POST http://localhost:3001/api/gatherings \
  -H "Content-Type: application/json" \
  -b "your-auth-cookie" \
  -d '{"name":"Youth Group","attendanceType":"standard","dayOfWeek":"Friday","startTime":"18:00","frequency":"weekly","individualMode":true}'

# Fetch gatherings — response should include individualMode: true on the new one
curl -s http://localhost:3001/api/gatherings -b "your-auth-cookie" | jq '.'
```

Expected: the new gathering has `"individualMode": true` in the JSON response.

- [ ] **Step 5: Commit**

```bash
git add server/routes/gatherings.js
git commit -m "feat: persist and return individual_mode in gatherings API"
```

---

## Task 3 — TypeScript types: add `individualMode`

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/src/pages/ManageGatheringsPage.tsx`

- [ ] **Step 1: Update `GatheringType` in api.ts**

Find the `GatheringType` interface (line ~162). Add `individualMode` after `leaderCheckinEnabled`:

```typescript
export interface GatheringType {
  id: number;
  name: string;
  description?: string;
  dayOfWeek?: string;
  startTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: { /* unchanged */ };
  endTime?: string;
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;   // ← add
  kioskMessage?: string;
  isActive: boolean;
  memberCount?: number;
  createdAt?: string;
}
```

- [ ] **Step 2: Update `gatheringsAPI.create` param type in api.ts**

Find the `create` method definition (line ~296). Add `individualMode`:

```typescript
create: (data: {
  name: string;
  description?: string;
  dayOfWeek?: string;
  startTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: { /* unchanged */ };
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;   // ← add
  setAsDefault?: boolean;
}) => api.post('/gatherings', data),
```

- [ ] **Step 3: Update local `Gathering` interface in ManageGatheringsPage.tsx**

Find the local `Gathering` interface (line ~19). Add `individualMode`:

```typescript
interface Gathering {
  id: number;
  name: string;
  description: string;
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: { /* unchanged */ };
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;   // ← add
  isActive: boolean;
  memberCount?: number;
  recentVisitorCount?: number;
}
```

- [ ] **Step 4: Update local `CreateGatheringData` interface in ManageGatheringsPage.tsx**

Find `CreateGatheringData` (line ~47). Add:

```typescript
interface CreateGatheringData {
  name: string;
  description: string;
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: { /* unchanged */ };
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;   // ← add
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.ts client/src/pages/ManageGatheringsPage.tsx
git commit -m "feat: add individualMode to GatheringType and CreateGatheringData types"
```

---

## Task 4 — Gathering wizard: people organisation question

**Files:**
- Modify: `client/src/pages/ManageGatheringsPage.tsx`

- [ ] **Step 1: Add `individualMode: false` to the `createGatheringData` initial state**

Find the `useState` call for `createGatheringData` (line ~103):

```typescript
const [createGatheringData, setCreateGatheringData] = useState<CreateGatheringData>({
  name: 'Sunday Morning Service',
  description: 'Weekly Sunday morning gathering',
  dayOfWeek: 'Sunday',
  startTime: '10:00',
  endTime: '11:00',
  frequency: 'weekly',
  attendanceType: 'standard',
  kioskEnabled: false,
  leaderCheckinEnabled: false,
  individualMode: false,   // ← add
});
```

- [ ] **Step 2: Add the wizard question UI**

In the wizard JSX (inside `showAddGatheringWizard`), find the closing `</div>` of the attendance type radio section (after line ~1192). Insert this block immediately after it — it is only shown for standard gatherings:

```tsx
{/* People organisation — only for standard gatherings */}
{createGatheringData.attendanceType === 'standard' && (
  <div>
    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
      How are people in this gathering typically organised?
    </label>
    <div className="space-y-2">
      <label className="flex items-start cursor-pointer">
        <input
          type="radio"
          name="individualMode"
          value="family"
          checked={!createGatheringData.individualMode}
          onChange={() => setCreateGatheringData({ ...createGatheringData, individualMode: false })}
          className="mt-0.5 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500"
        />
        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
          <strong>As families</strong> — parents, children, and siblings grouped together
        </span>
      </label>
      <label className="flex items-start cursor-pointer">
        <input
          type="radio"
          name="individualMode"
          value="individual"
          checked={!!createGatheringData.individualMode}
          onChange={() => setCreateGatheringData({ ...createGatheringData, individualMode: true })}
          className="mt-0.5 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500"
        />
        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
          <strong>As individuals</strong> — mostly standalone people, like a youth group or small group
        </span>
      </label>
    </div>
  </div>
)}
```

- [ ] **Step 3: Include `individualMode` in the `handleCreateGathering` call**

Find `handleCreateGathering` (line ~228). Update `gatheringData` to include `individualMode`:

```typescript
const gatheringData = {
  name: createGatheringData.name,
  description: createGatheringData.description,
  dayOfWeek: createGatheringData.dayOfWeek,
  startTime: formattedStartTime,
  frequency: createGatheringData.frequency,
  attendanceType: createGatheringData.attendanceType,
  customSchedule: createGatheringData.customSchedule,
  kioskEnabled: createGatheringData.kioskEnabled,
  leaderCheckinEnabled: createGatheringData.leaderCheckinEnabled,
  individualMode: createGatheringData.individualMode,   // ← add
};
```

- [ ] **Step 4: Include `individualMode` in the `newGathering` local state object**

In the same function (line ~258), update `newGathering`:

```typescript
const newGathering: Gathering = {
  id: newGatheringId,
  name: createGatheringData.name,
  description: createGatheringData.description,
  dayOfWeek: createGatheringData.dayOfWeek,
  startTime: createGatheringData.startTime,
  frequency: createGatheringData.frequency,
  attendanceType: createGatheringData.attendanceType,
  customSchedule: createGatheringData.customSchedule,
  kioskEnabled: createGatheringData.kioskEnabled,
  leaderCheckinEnabled: createGatheringData.leaderCheckinEnabled,
  individualMode: createGatheringData.individualMode,   // ← add
  isActive: true,
  memberCount: 0,
  recentVisitorCount: 0,
};
```

- [ ] **Step 5: Verify in browser**

```bash
docker-compose -f docker-compose.dev.yml up -d
```

Open the app → Gatherings → add a new gathering → pick "Standard Attendance" → confirm the "How are people in this gathering typically organised?" question appears → pick "As individuals" → save → verify no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/ManageGatheringsPage.tsx
git commit -m "feat: add people organisation question to gathering creation wizard"
```

---

## Task 5 — Attendance page: initialise `groupByFamily` from gathering

**Files:**
- Modify: `client/src/pages/AttendancePage.tsx`

- [ ] **Step 1: Write a failing test**

Create `client/src/pages/AttendancePage.groupByFamily.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

// Pure logic helper — mirrors the initialisation logic we'll add
function initialGroupByFamily(
  individualMode: boolean | undefined,
  storedValue: string | null
): boolean {
  if (storedValue !== null) return JSON.parse(storedValue);
  return individualMode ? false : true;
}

describe('groupByFamily initialisation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to true for a family-mode gathering with no stored pref', () => {
    expect(initialGroupByFamily(false, null)).toBe(true);
  });

  it('defaults to false for an individual-mode gathering with no stored pref', () => {
    expect(initialGroupByFamily(true, null)).toBe(false);
  });

  it('uses the stored value when present, regardless of gathering mode', () => {
    expect(initialGroupByFamily(true, 'true')).toBe(true);
    expect(initialGroupByFamily(false, 'false')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — it should pass (it tests pure logic)**

```bash
cd client && npx vitest run src/pages/AttendancePage.groupByFamily.test.ts
```

Expected: 3 passing tests. (The logic is pure so this works immediately — its purpose is to lock in the expected behaviour before we touch the component.)

- [ ] **Step 3: Add the initialisation `useEffect` to AttendancePage**

Find where `selectedGathering` is declared (the `useState` for it). Then, after the existing `useEffect` for `handleGroupByFamilyChange`, add:

```typescript
// Initialise groupByFamily whenever the selected gathering changes.
// Individual-mode gatherings default to ungrouped; family-mode gatherings default to grouped.
// A user's manual toggle choice is always respected when stored in localStorage.
useEffect(() => {
  if (!selectedGathering) return;
  const stored = localStorage.getItem(`gathering_${selectedGathering.id}_groupByFamily`);
  if (stored !== null) {
    setGroupByFamily(JSON.parse(stored));
  } else {
    setGroupByFamily(selectedGathering.individualMode ? false : true);
  }
}, [selectedGathering?.id]);
```

- [ ] **Step 4: Verify in browser**

- Create a gathering with "As individuals" selected.
- Navigate to the Attendance page and select that gathering.
- Confirm the "Group by Family" toggle is **off** by default.
- Toggle it on, navigate away and back — confirm the manual preference is respected.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AttendancePage.tsx client/src/pages/AttendancePage.groupByFamily.test.ts
git commit -m "feat: default groupByFamily to off for individual-mode gatherings"
```

---

## Task 6 — AddPeopleModal: individual-mode form variant

**Files:**
- Modify: `client/src/components/people/AddPeopleModal.tsx`

This is the largest task. Work through it step by step.

- [ ] **Step 1: Add the `IndividualCard` interface and new props**

At the top of the file, after the existing `PersonForm` interface, add:

```typescript
interface IndividualCard {
  id: string;              // temporary local id (crypto.randomUUID or Date.now().toString())
  firstName: string;
  lastName: string;
  isChild: boolean;
  siblingGroupId: string | null;  // null = solo; shared value = linked siblings
}
```

Update `AddPeopleModalProps`:

```typescript
interface AddPeopleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  gatheringTypes: GatheringType[];
  people: Person[];
  defaultMode?: 'individual' | 'family';   // ← add
  showModeToggle?: boolean;                // ← add (true when opened from People page)
}
```

- [ ] **Step 2: Add state for individual mode inside the component**

In the component body, after the existing state declarations, add:

```typescript
// Individual mode state
const [isIndividualMode, setIsIndividualMode] = useState(false);
const [individualCards, setIndividualCards] = useState<IndividualCard[]>([
  { id: Date.now().toString(), firstName: '', lastName: '', isChild: false, siblingGroupId: null }
]);
const [individualSelectedGatherings, setIndividualSelectedGatherings] = useState<{ [key: number]: boolean }>({});
const [showSiblingPickerFor, setShowSiblingPickerFor] = useState<string | null>(null);
```

- [ ] **Step 3: Sync `isIndividualMode` when modal opens**

Find the `useEffect` that runs when `isOpen` changes (or add one). Sync the mode from the prop:

```typescript
useEffect(() => {
  if (!isOpen) return;
  setIsIndividualMode(defaultMode === 'individual');
  // Reset individual cards to a single blank card on open
  setIndividualCards([
    { id: Date.now().toString(), firstName: '', lastName: '', isChild: false, siblingGroupId: null }
  ]);
  setIndividualSelectedGatherings({});
  setShowSiblingPickerFor(null);
}, [isOpen, defaultMode]);
```

- [ ] **Step 4: Add the mode toggle UI (shown only when `showModeToggle` is true)**

Inside the modal JSX, before the main form, add:

```tsx
{showModeToggle && (
  <div className="mb-4 flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
    <span className="text-sm text-gray-700 dark:text-gray-300 font-medium">
      Are these people in a family?
    </span>
    <button
      type="button"
      onClick={() => setIsIndividualMode(v => !v)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${
        !isIndividualMode ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'
      }`}
      role="switch"
      aria-checked={!isIndividualMode}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
        !isIndividualMode ? 'translate-x-6' : 'translate-x-1'
      }`} />
    </button>
    <span className="text-sm text-gray-500 dark:text-gray-400">
      {isIndividualMode ? 'No — add as individuals' : 'Yes — add as a family'}
    </span>
  </div>
)}
```

- [ ] **Step 5: Render the individual cards form when `isIndividualMode` is true**

In the modal JSX, find where the main add-person form is rendered (around line ~779). Wrap it in a conditional:

```tsx
{isIndividualMode ? (
  <div className="space-y-3">
    {/* Individual cards */}
    {individualCards.map((card, index) => (
      <div
        key={card.id}
        className={`border rounded-lg p-3 bg-white dark:bg-gray-700 space-y-3 ${
          card.siblingGroupId ? 'border-primary-300 dark:border-primary-600' : 'border-gray-200 dark:border-gray-600'
        }`}
      >
        <div className="flex gap-2 items-start">
          {/* First name */}
          <div className="flex-1">
            <input
              type="text"
              value={card.firstName}
              onChange={(e) => setIndividualCards(cards =>
                cards.map(c => c.id === card.id ? { ...c, firstName: e.target.value } : c)
              )}
              placeholder="First name"
              className="block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
            />
          </div>
          {/* Last name */}
          <div className="flex-1">
            <input
              type="text"
              value={card.lastName}
              onChange={(e) => setIndividualCards(cards =>
                cards.map(c => c.id === card.id ? { ...c, lastName: e.target.value } : c)
              )}
              placeholder="Last name"
              className="block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
            />
          </div>
          {/* Remove button — shown for all cards once there are 2+ */}
          {individualCards.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setIndividualCards(cards => {
                  const updated = cards.filter(c => c.id !== card.id);
                  // If this card was in a sibling group, check if the group now has only 1 member
                  // and if so, remove the group link from that remaining member
                  if (card.siblingGroupId) {
                    const remaining = updated.filter(c => c.siblingGroupId === card.siblingGroupId);
                    if (remaining.length === 1) {
                      return updated.map(c =>
                        c.siblingGroupId === card.siblingGroupId ? { ...c, siblingGroupId: null } : c
                      );
                    }
                  }
                  return updated;
                });
              }}
              className="text-gray-400 hover:text-red-500 mt-1"
              aria-label="Remove person"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Child checkbox + sibling link row */}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={card.isChild}
              onChange={(e) => setIndividualCards(cards =>
                cards.map(c => c.id === card.id ? { ...c, isChild: e.target.checked } : c)
              )}
              className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500 h-4 w-4"
            />
            Child
          </label>

          {/* Sibling link affordance — only shown when there are other cards */}
          {individualCards.length > 1 && (
            <div className="relative">
              {card.siblingGroupId ? (
                <button
                  type="button"
                  onClick={() => setIndividualCards(cards => {
                    const updated = cards.map(c =>
                      c.id === card.id ? { ...c, siblingGroupId: null } : c
                    );
                    // Clean up any group that now has only 1 member
                    const groupId = card.siblingGroupId!;
                    const remaining = updated.filter(c => c.siblingGroupId === groupId);
                    if (remaining.length === 1) {
                      return updated.map(c =>
                        c.siblingGroupId === groupId ? { ...c, siblingGroupId: null } : c
                      );
                    }
                    return updated;
                  })}
                  className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                >
                  ✓ Linked as sibling — remove link
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSiblingPickerFor(
                    showSiblingPickerFor === card.id ? null : card.id
                  )}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-primary-600 dark:hover:text-primary-400"
                >
                  Link as sibling →
                </button>
              )}

              {/* Sibling picker dropdown */}
              {showSiblingPickerFor === card.id && (
                <div className="absolute left-0 top-6 z-10 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg py-1 min-w-max">
                  {individualCards
                    .filter(c => c.id !== card.id)
                    .map(other => (
                      <button
                        key={other.id}
                        type="button"
                        onClick={() => {
                          const groupId = card.siblingGroupId || other.siblingGroupId || `sibling-${Date.now()}`;
                          setIndividualCards(cards =>
                            cards.map(c =>
                              (c.id === card.id || c.id === other.id || c.siblingGroupId === other.siblingGroupId)
                                ? { ...c, siblingGroupId: groupId }
                                : c
                            )
                          );
                          setShowSiblingPickerFor(null);
                        }}
                        className="block w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        {other.firstName || 'Unnamed'} {other.lastName}
                      </button>
                    ))
                  }
                </div>
              )}
            </div>
          )}

          {/* Sibling group badge */}
          {card.siblingGroupId && (
            <span className="text-xs text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/30 px-2 py-0.5 rounded-full">
              siblings
            </span>
          )}
        </div>
      </div>
    ))}

    {/* Add another person */}
    {individualCards.length < 10 && (
      <button
        type="button"
        onClick={() => setIndividualCards(cards => [
          ...cards,
          { id: Date.now().toString(), firstName: '', lastName: '', isChild: false, siblingGroupId: null }
        ])}
        className="w-full py-2 px-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:border-primary-400 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
      >
        + Add another person
      </button>
    )}

    {/* Gathering assignment */}
    {gatheringTypes.filter(g => g.attendanceType !== 'headcount').length > 0 && (
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Assign to gatherings
        </label>
        <div className="space-y-2">
          {gatheringTypes
            .filter(g => g.attendanceType !== 'headcount')
            .map(g => (
              <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!individualSelectedGatherings[g.id]}
                  onChange={(e) => setIndividualSelectedGatherings(prev => ({
                    ...prev,
                    [g.id]: e.target.checked
                  }))}
                  className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500 h-4 w-4"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">{g.name}</span>
              </label>
            ))
          }
        </div>
      </div>
    )}
  </div>
) : (
  // Existing family form — do NOT alter anything inside this block.
  // The <form> tag, all its children, and its onSubmit handler remain exactly as they were before this task.
  <form onSubmit={(e) => { e.preventDefault(); handleAddPeople(); }} className="space-y-4">
    {/* leave all existing children here — person type radios, person rows, gathering checkboxes, notes, submit button */}
  </form>
)}
```

**Important:** Do NOT remove or alter the existing family form JSX — only wrap it in the `else` branch of the conditional.

- [ ] **Step 6: Add the individual mode save handler**

Find `handleAddPeople` (line ~460). Add a new `handleAddIndividuals` function alongside it:

```typescript
const handleAddIndividuals = async () => {
  try {
    setIsLoading(true);
    setError('');

    // Validate: every card must have a first name
    for (const card of individualCards) {
      if (!card.firstName.trim()) {
        setError('First name is required for all people');
        return;
      }
    }

    // Separate sibling groups from solo individuals
    const siblingGroups = new Map<string, IndividualCard[]>();
    const soloCards: IndividualCard[] = [];

    for (const card of individualCards) {
      if (card.siblingGroupId) {
        const group = siblingGroups.get(card.siblingGroupId) ?? [];
        group.push(card);
        siblingGroups.set(card.siblingGroupId, group);
      } else {
        soloCards.push(card);
      }
    }

    const selectedGatheringIds = Object.entries(individualSelectedGatherings)
      .filter(([, checked]) => checked)
      .map(([id]) => parseInt(id));

    // Helper: create a family + individuals + assign to gatherings
    const createGroup = async (cards: IndividualCard[]) => {
      const familyName = generateFamilyName(cards.map(c => ({
        firstName: c.firstName.trim(),
        lastName: c.lastName.trim(),
        lastUnknown: false,
      })));
      const familyResponse = await familiesAPI.create({ familyName });
      const individuals = await Promise.all(
        cards.map(card =>
          individualsAPI.create({
            firstName: card.firstName.trim(),
            lastName: card.lastName.trim() || 'Unknown',
            familyId: familyResponse.data.id,
            isChild: card.isChild,
          })
        )
      );
      const ids = individuals.map(r => r.data.id);
      for (const gId of selectedGatheringIds) {
        await csvImportAPI.massAssign(gId, ids);
      }
    };

    // Create sibling groups
    for (const [, groupCards] of siblingGroups) {
      await createGroup(groupCards);
    }

    // Create solo individuals
    for (const card of soloCards) {
      await createGroup([card]);
    }

    await onSuccess();
    onClose();
  } catch (err: any) {
    setError(err.response?.data?.error || 'Failed to add people');
  } finally {
    setIsLoading(false);
  }
};
```

- [ ] **Step 7: Wire the save button for individual mode**

The individual cards form renders outside the existing `<form>` element, so it needs its own save button. Add one at the bottom of the `isIndividualMode` branch, after the gathering-assignment checkboxes:

```tsx
{/* Save button — individual mode only */}
<div className="flex justify-end pt-2">
  <button
    type="button"
    onClick={handleAddIndividuals}
    disabled={isLoading}
    className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
  >
    {isLoading ? 'Saving...' : 'Add People'}
  </button>
</div>
```

The existing `<form>`'s submit button is unchanged — it only appears in the family-mode branch and calls `handleAddPeople` as before.

- [ ] **Step 8: Write a test for the sibling grouping logic**

Create `client/src/components/people/AddPeopleModal.siblings.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// Mirror the grouping logic from handleAddIndividuals
interface Card { id: string; firstName: string; siblingGroupId: string | null }

function groupCards(cards: Card[]) {
  const siblingGroups = new Map<string, Card[]>();
  const soloCards: Card[] = [];
  for (const card of cards) {
    if (card.siblingGroupId) {
      const g = siblingGroups.get(card.siblingGroupId) ?? [];
      g.push(card);
      siblingGroups.set(card.siblingGroupId, g);
    } else {
      soloCards.push(card);
    }
  }
  return { siblingGroups, soloCards };
}

describe('individual card sibling grouping', () => {
  it('puts solo cards in soloCards', () => {
    const cards: Card[] = [
      { id: '1', firstName: 'Alice', siblingGroupId: null },
      { id: '2', firstName: 'Bob', siblingGroupId: null },
    ];
    const { soloCards, siblingGroups } = groupCards(cards);
    expect(soloCards).toHaveLength(2);
    expect(siblingGroups.size).toBe(0);
  });

  it('groups linked cards by siblingGroupId', () => {
    const cards: Card[] = [
      { id: '1', firstName: 'Alice', siblingGroupId: 'g1' },
      { id: '2', firstName: 'Bob', siblingGroupId: 'g1' },
      { id: '3', firstName: 'Carol', siblingGroupId: null },
    ];
    const { soloCards, siblingGroups } = groupCards(cards);
    expect(soloCards).toHaveLength(1);
    expect(soloCards[0].firstName).toBe('Carol');
    expect(siblingGroups.get('g1')).toHaveLength(2);
  });

  it('handles multiple sibling groups', () => {
    const cards: Card[] = [
      { id: '1', firstName: 'A', siblingGroupId: 'g1' },
      { id: '2', firstName: 'B', siblingGroupId: 'g1' },
      { id: '3', firstName: 'C', siblingGroupId: 'g2' },
      { id: '4', firstName: 'D', siblingGroupId: 'g2' },
    ];
    const { soloCards, siblingGroups } = groupCards(cards);
    expect(soloCards).toHaveLength(0);
    expect(siblingGroups.size).toBe(2);
  });
});
```

- [ ] **Step 9: Run the sibling grouping tests**

```bash
cd client && npx vitest run src/components/people/AddPeopleModal.siblings.test.ts
```

Expected: 3 passing.

- [ ] **Step 10: Verify in browser**

- Open People page → click "Add People"
- If any gathering is individual_mode, the toggle "Are these people in a family?" should appear, defaulting to off
- In individual mode: confirm card UI renders, "+ Add another person" works up to 10, sibling picker dropdown works, remove button works
- Save with 2 solo people and 2 linked siblings → check the People page shows 3 family entries (two solo + one linked pair)

- [ ] **Step 11: Commit**

```bash
git add client/src/components/people/AddPeopleModal.tsx \
        client/src/components/people/AddPeopleModal.siblings.test.ts
git commit -m "feat: add individual-mode form variant to AddPeopleModal with sibling linking"
```

---

## Task 7 — PeoplePage: pass `defaultMode` and `showModeToggle` to modal

**Files:**
- Modify: `client/src/pages/PeoplePage.tsx`

- [ ] **Step 1: Derive `defaultMode` from `gatheringTypes`**

Find where the `AddPeopleModal` is rendered (line ~2227). Before it, add a derived value:

```typescript
const addPeopleDefaultMode = gatheringTypes.some(g => g.individualMode)
  ? 'individual' as const
  : 'family' as const;
```

- [ ] **Step 2: Pass the new props to `AddPeopleModal`**

Update the JSX:

```tsx
<AddPeopleModal
  isOpen={showAddModal}
  onClose={() => setShowAddModal(false)}
  onSuccess={async () => {
    await loadPeople();
    await loadFamilies();
    showSuccess('People added successfully');
  }}
  gatheringTypes={gatheringTypes}
  people={people}
  defaultMode={addPeopleDefaultMode}
  showModeToggle={true}
/>
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd client && npx vitest run
```

Expected: all tests pass (AttendancePage.groupByFamily.test.ts and AddPeopleModal.siblings.test.ts).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/PeoplePage.tsx
git commit -m "feat: pass defaultMode and showModeToggle to AddPeopleModal from PeoplePage"
```

---

## Task 8 — Final integration check

- [ ] **Step 1: Build via Docker**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d
docker-compose -f docker-compose.dev.yml logs -f client
```

Expected: build completes with no TypeScript or Vite errors.

- [ ] **Step 2: End-to-end smoke test**

1. Register a new church account (or use a dev account)
2. Complete onboarding → confirm gathering wizard auto-opens
3. Create a gathering → pick "Standard Attendance" → pick "As individuals" → save
4. Navigate to Attendance → select the new gathering → confirm "Group by Family" is **off** by default
5. Navigate to People → click "Add People" → confirm the mode toggle appears, defaulting to "add as individuals"
6. Add 3 people: two linked as siblings (same last name), one solo
7. Confirm People page shows 2 entries (sibling pair + solo) in individual view
8. Check that group-by-family mode still works (toggle it on — siblings appear together)

- [ ] **Step 3: Final commit if any fixups were needed**

```bash
git add -p
git commit -m "fix: integration fixups for individual mode feature"
```
