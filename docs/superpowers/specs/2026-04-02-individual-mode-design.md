# Individual Mode per Gathering

**Date:** 2026-04-02
**Status:** Approved

## Problem

The app was built around families as the primary organisational unit. Some churches — youth groups, small groups — work primarily with standalone individuals. A new user onboarding a youth group encounters family-grouped UI that doesn't match their mental model, and the Add People form is oriented toward entering a whole family at once.

Observed symptoms:
- New user tapping search fields that had nothing to search
- Add People form asking for family context that isn't relevant
- Group-by-family view defaulting on for gatherings where it adds noise

## Decision

Add a per-gathering `individual_mode` flag. A gathering can be family-first (default, existing behaviour) or individual-first. Two things change in individual mode: the attendance page defaults to ungrouped view, and the Add People modal uses an individual-cards form instead of the family form.

Per-gathering (not per-church) because a church may have both a Sunday family service and a youth group. When a church has only one gathering, the effect is church-wide.

## Scope — Approach B

- Per-gathering `individual_mode` flag set in the gathering creation wizard
- Attendance page: `groupByFamily` defaults to `false` for individual-mode gatherings
- Add People modal: individual-cards variant for individual-mode gatherings, with optional sibling linking

Out of scope: People page structural changes (gathering-driven mode switching on the People page).

---

## Design

### 1. Data Model

New column on `gathering_types`:

```sql
individual_mode  BOOLEAN  DEFAULT 0
```

Added to `server/config/schema.js`. The existing per-church SQLite migration system applies it automatically on next server start for any church database that doesn't have it yet.

No other schema changes.

### 2. Gathering Creation Wizard

A new step is added to the add-gathering wizard in `ManageGatheringsPage.tsx`, shown only when `attendanceType === 'standard'` (headcount gatherings don't track individuals, so the question is irrelevant).

The step appears after the attendance type selection:

> **How are people in this gathering typically organised?**
>
> ○ As families — parents, children, and siblings grouped together *(default)*
> ○ As individuals — mostly standalone people, like a youth group or small group

- Family is pre-selected so existing users feel no friction
- The answer maps directly to `individual_mode: false / true` in the create payload

### 3. Attendance Page

**File:** `client/src/pages/AttendancePage.tsx`

When a gathering loads, the initial value of `groupByFamily` is determined as follows:

```
if gathering.individualMode === true
  → groupByFamily defaults to false
else
  → groupByFamily reads from localStorage (existing behaviour, defaults to true)
```

The user can still manually toggle group-by-family during a session. That toggle preference is saved to localStorage as usual — so `individual_mode` sets the *default*, not a permanent lock.

No other changes to the attendance page.

### 4. Add People Modal

**File:** `client/src/components/people/AddPeopleModal.tsx`

The modal receives a new optional prop:

```ts
defaultMode?: 'individual' | 'family'
```

**Entry point logic:**

| Opened from | `defaultMode` passed |
|---|---|
| Attendance page, individual-mode gathering | `'individual'` |
| Attendance page, family-mode gathering | `'family'` |
| People page | determined by whether any gathering has `individual_mode = true`; if so, `'individual'`, otherwise `'family'` |

**From the attendance page** (either mode): no toggle shown — the form opens directly in the mode determined by the gathering, no choice offered.

**From the People page**: a toggle is shown at the top of the modal — *"Are these people in a family?"* — pre-set based on `defaultMode`. Toggling it switches between the two form variants. This gives the user explicit control since the People page has no single gathering context.

#### Family mode form
Unchanged — existing behaviour.

#### Individual mode form

A stack of person cards:

- **Per card:** first name, last name, child checkbox, remove button
- One card shown on open; "+ Add another person" adds rows up to a maximum of 10
- **Sibling linking:** each card has an optional "Link as sibling →" affordance — a small inline picker listing the other people currently in the batch. Selecting one marks both as siblings with a subtle visual connector between their cards.
- **Gathering assignment:** a shared set of gathering checkboxes below all cards, applying to every person in the batch

**Save behaviour:**
- People linked as siblings → created under one shared family record, auto-named from their shared last name (e.g. "Smith Family"), same logic as the existing `generateFamilyName()` utility
- Unlinked people → each gets their own solo family record, created silently (the family concept is an implementation detail, not surfaced in the UI)

---

## Files Affected

| File | Change |
|---|---|
| `server/config/schema.js` | Add `individual_mode BOOLEAN DEFAULT 0` to `gathering_types` |
| `server/routes/gatherings.js` | Accept and persist `individual_mode` on create/update; return it in GET responses |
| `client/src/services/api.ts` | Add `individualMode` to `GatheringType` interface |
| `client/src/pages/ManageGatheringsPage.tsx` | New wizard step for individual/family mode question |
| `client/src/pages/AttendancePage.tsx` | Initialise `groupByFamily` based on `gathering.individualMode` |
| `client/src/components/people/AddPeopleModal.tsx` | New individual-cards form variant; `defaultMode` prop; sibling linking |
| `client/src/pages/PeoplePage.tsx` | Pass correct `defaultMode` to AddPeopleModal based on gatherings |

---

## Out of Scope

- People page structural changes (gathering-driven mode switching)
- Retroactively applying `individual_mode` to existing gatherings (they stay as `false` / family-first)
- Changing the editing experience for existing people
