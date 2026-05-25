# Lock PCO-Linked Person Details

**Date:** 2026-05-25
**Status:** Approved design

## Problem

Planning Center (PCO) is the source of truth for churches that have connected and
synced. Today, any admin or coordinator can edit a synced person's name and age
group in Let My People Grow (LMPG), which silently diverges from PCO — LMPG edits
never flow back, so the two systems disagree.

We want to prevent editing of PCO-controlled details for linked people, while
keeping LMPG-local organisation (gathering associations, people type, family,
badges) fully editable.

## Goal

When a person is PCO-linked **and** the church's PCO sync indicator is on, make
their **name and age group read-only for all users**. Everything else stays
editable.

## Scope

### Locked fields
- `first_name`
- `last_name`
- `is_child` (age group: adult/child)

### Always editable (not locked)
- People type (`people_type`)
- Family assignment (`family_id`)
- Badges (`badge_text`, `badge_color`, `badge_icon`)
- Gathering associations (separate routes, untouched)

### Out of scope (this change)
- Delete / archive / merge of linked people — the sync reconciles these, so we
  leave them as-is for now.
- Nickname support — PCO has a `nickname` field; if churches want preferred-name
  display later, the correct approach is to **sync** PCO's nickname (keeping PCO
  authoritative) rather than allow local editing. Deferred to a future follow-up.

## Lock condition

A person is **PCO-locked** when **both** are true:

1. The church's `church_settings.planning_center_sync_indicator = 1`, and
2. The individual has a non-empty `planning_center_id`.

This is the **same signal** that drives the existing "PCO" badge on the People
page (see `families.js` `getAll`, which maps `planning_center_sync_indicator` to
the client's `planningCenterSyncEnabled`). Using the same signal keeps the badge
and the lock consistent: if a person shows the PCO badge, their name/age is
locked.

> Note: `planning_center_sync_indicator` is intentionally distinct from
> `planning_center_sync_enabled` (the latter gates the nightly cron). The lock and
> badge use the *indicator*.

## Architecture (Approach A: defense in depth)

Enforce on both layers. The backend guarantees integrity (covers bulk edit,
family-editor, and direct API calls); the frontend explains *why* fields are
read-only.

### Backend

Route: `PUT /api/individuals/:id` (`server/routes/individuals.js`).

1. Before building the update, fetch the individual's `planning_center_id`
   (already fetching the row for `family_id` — extend that select), and the
   church's `planning_center_sync_indicator` from `church_settings`.
2. Compute `isLocked = sync_indicator === 1 && planning_center_id is non-empty`.
3. When `isLocked`, **omit** `first_name`, `last_name`, and `is_child` from the
   dynamic `UPDATE` field list — regardless of what the payload contains. This
   means locked values cannot change through this route by any caller.
4. Non-locked fields (`people_type`, `family_id`, badges) proceed as today.
5. If, after stripping, there are **no fields left to update**, return a success
   no-op (HTTP 200) instead of executing an empty `UPDATE`. (The `people_type`
   family-sync logic should still run only when `people_type` was actually
   applied.)

This automatically protects:
- Single-person edit (MassEditModal)
- Bulk edit (MassEditModal across multiple people) — locked people keep their
  name/age while unlocked people in the same batch are updated.
- Family-editor flow — which also calls `individualsAPI.update()` and passes the
  current name through.

### Frontend

Helper in `PeoplePage.tsx`:
```
isPcoLocked(person) = planningCenterSyncEnabled && !!person.planningCenterId
```
(`planningCenterSyncEnabled` already exists in page state; `Person.planningCenterId`
was added in the per-person badge work.)

`MassEditModal` gains lock awareness via new props:
- `lockNameAge?: boolean` — true when editing a **single** locked person.
- `lockedCount?: number` — number of locked people in a **bulk** selection.

Behaviour:
- **Single locked person:** disable the First Name, Last Name, and Adult/Child
  inputs, and show a short hint (e.g. *"Managed by Planning Center"*).
- **Bulk with some locked:** keep the Last Name and Adult/Child inputs usable
  (they apply to unlocked people), and show an informational note:
  *"N Planning Center–linked people won't have their name or age changed."*
- People type, family, badges, and gathering checkboxes remain enabled in all
  cases.

`handleEditPerson` / the bulk open handler in `PeoplePage.tsx` compute the lock
props from the selected person(s) and pass them to `MassEditModal`.

## Data flow

1. People load with `planningCenterId` (already returned by `GET /api/individuals`).
2. `planningCenterSyncEnabled` loads via `familiesAPI.getAll()` (already wired).
3. Opening the edit modal computes lock status from these and disables inputs.
4. On save, the frontend sends its usual payload; the backend independently
   recomputes the lock and strips locked fields. The two layers agree because
   they use the same condition.

## Error handling / edge cases

- **Empty update after stripping:** return 200 no-op (don't run an empty SQL
  `UPDATE`).
- **Person not found / wrong church:** unchanged 404 behaviour.
- **Sync indicator off:** nothing is locked (fields editable as today), even if a
  stale `planning_center_id` exists.
- **Unlinked person while sync on:** editable (no `planning_center_id`).
- **Bulk batch mixing locked + unlocked:** unlocked updated, locked skipped per
  field; no error surfaced for the skip (frontend note communicates it).

## Testing

Backend:
- PUT a name change on a locked individual → name unchanged; a simultaneous
  `people_type` change still applies; family-type sync still runs.
- PUT a name change on an unlinked individual (sync on) → name changes.
- PUT with only locked fields on a locked person → 200 no-op, no DB change.
- Gathering assign/remove on a locked person → still works (separate route,
  untouched).

Frontend (manual):
- Edit a PCO-badged person → First/Last name + Adult/Child disabled with hint;
  people type / family / badges / gatherings editable.
- Edit a non-linked person → all fields editable.
- Bulk-select a mix → note shows the locked count; saving updates only unlocked
  names/ages.
