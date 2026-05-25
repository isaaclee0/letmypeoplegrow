# PCO Source-of-Truth Mode

**Date:** 2026-05-25
**Status:** Approved design (single spec, phased implementation)

## Problem

When a church connects Planning Center (PCO) and turns sync on, PCO should be the
single source of truth for its regular/member population. Today LMPG still lets
users add, edit, merge, and delete those people freely, which silently diverges
from PCO — LMPG changes never flow back, so the two systems disagree. We also have
no way to reconcile people who exist in LMPG but not in PCO.

Visitors are different: PCO does not track casual visitors, so LMPG must remain
the place to add and manage them.

## Goal

Introduce **PCO source-of-truth mode**. While active, LMPG's *regular* population
converges to PCO: regulars are PCO-owned and not hand-managed, people not in PCO
are surfaced and archived through review, and only **visitors** are created and
managed by hand. Gathering associations and attendance remain LMPG-owned for
everyone.

## Mode activation (gate)

Mode is **active** for a church when `church_settings.planning_center_sync_indicator = 1`.

This is the same signal that drives the existing "PCO" badge (mapped to the
client's `planningCenterSyncEnabled` by `families.js` `getAll`). Reusing it keeps
the badge, the field lock, and all mode behavior consistent. It is deliberately
distinct from `planning_center_sync_enabled` (which gates the nightly cron).

A shared helper computes the gate in one place per layer:
- Backend: `isPcoModeActive(churchId)` → reads `planning_center_sync_indicator`.
- Frontend: `planningCenterSyncEnabled` (already in `PeoplePage` state).

## Definitions

- **Regular:** `individuals.people_type = 'regular'`.
- **Visitor:** `people_type IN ('local_visitor', 'traveller_visitor')`.
- **Linked:** `individuals.planning_center_id` is non-empty.
- **Extra:** active, `regular`, **not** linked (manually added or never matched).
  Visitors are never extras.

## Reconciliation of "no editing" vs "name + age only"

Earlier we agreed the PCO-*owned attributes* to lock are **first name, last name,
age group (`is_child`)** — these are what PCO controls. The later "no editing,
merging, or whatever" intent refers to **structural/destructive operations**
(merge, delete, manual archive) and **creation of regulars**, not to every field.

So for a **linked** person:
- **Locked attributes:** first name, last name, age group.
- **Still editable:** people type, family assignment, badges, gathering
  associations. (Family/grouping is LMPG-organizational; PCO household *membership*
  is not synced today, so locking it would freeze incorrect groupings.)
- **Disabled operations:** edit of locked attributes, merge, delete (soft and
  permanent), manual archive, manual restore. Lifecycle is sync-driven.

This explicit split is the single source of behavior; if it's wrong, change it
here.

---

## Phase 1 — Lockdown (read-only linked people + no hand-added regulars)

### Backend guards (`server/routes/individuals.js`, `server/routes/families.js`)

When mode is active:

- `PUT /individuals/:id`: if the target is **linked**, omit `first_name`,
  `last_name`, `is_child` from the dynamic `UPDATE` (cannot change regardless of
  payload). Other fields proceed. If nothing remains, 200 no-op.
- `POST /individuals` (create): reject creating a **regular** (`people_type`
  omitted or `'regular'`) with 409/403 and a clear message ("Add members in
  Planning Center"). Creating a visitor is allowed.
- `DELETE /individuals/:id`, `DELETE /individuals/:id/permanent`,
  `POST /individuals/:id/restore`: reject for **linked** people (sync owns
  lifecycle). Visitors and extras unaffected.
- `POST /individuals/deduplicate` and `families.js` `POST /merge`,
  `POST /merge-individuals`: reject when any involved individual is **linked**.
- CSV import (`csvImportAPI`): reject/disable importing regulars while mode is
  active (visitors-only path may remain if one exists; otherwise block import).

Guards use a small reusable check (linked-ness from the row + `isPcoModeActive`).
Rejections return a consistent shape the client can show.

### Frontend (`PeoplePage.tsx`, `MassEditModal.tsx`)

Compute `isPcoLocked(person) = planningCenterSyncEnabled && !!person.planningCenterId`.

- **MassEditModal, single locked person:** disable First Name, Last Name,
  Adult/Child inputs with a hint ("Managed by Planning Center"). People type,
  family, badges, gatherings remain enabled.
- **MassEditModal, bulk with some locked:** keep name/age inputs usable (apply to
  unlocked people); show a note "N Planning Center–linked people won't have their
  name or age changed." Backend enforces the per-person skip.
- **Add Person (regular):** hide/disable the button while mode is active; keep the
  visitor-add path. CSV import of people: hide/disable while mode is active.
- **Row/bulk actions:** hide/disable Merge, Delete/Archive, and Restore for linked
  people while mode is active.

## Phase 2 — Extras: archive & restore via Sync & Review

### Engine (`planningCenter/diffEngine.js`, `matcher.js`, `planningCenterSync.js`)

- `loadChurchState` must also select `people_type` and continue including archived
  rows (it already selects all individuals regardless of `is_active`).
- The matcher already matches unlinked individuals to available PCO people. Keep
  that, but the **diffEngine** re-buckets the leftovers using `people_type` and
  `is_active`:
  - **extra:** active + `regular` + unmatched → new `archiveExtras` bucket.
  - **unmatched-visitor:** `visitor` + unmatched → no action (informational only).
  - **restore:** an **archived** individual that now matches a PCO person →
    emit into a `restore` bucket (link **and** reactivate on apply), instead of a
    plain link.
- Plan output gains: `archiveExtras: [{individualId, firstName, lastName}]` and
  `restore: [{individualId, pcoId}]`. The existing `unmatched` is **replaced** by a
  dedicated `unmatchedVisitors` bucket (unmatched regulars now flow to
  `archiveExtras`, so a generic "unmatched" bucket no longer makes sense).

### Apply (`planningCenter/apply.js`)

- `archiveExtras`: `UPDATE individuals SET is_active = 0 ...` (counts as archived).
  Applied only when the reviewer confirms (selections may allow per-item skip,
  consistent with the add bucket's `skipAddPcoIds`).
- `restore`: `UPDATE individuals SET planning_center_id = ?, is_active = 1 ...`
  (links + reactivates).

### Frontend (`PlanningCenterSyncReview.tsx`)

- New review section "Not in PCO — will be archived (N)" listing extras, with
  per-item skip checkboxes (like the Add list). Default: archive all.
- `restore` and the existing `reactivate`/`link` fold into the auto-applied
  summary line.
- Summary chips gain `archiveExtras` (and visitor-unmatched count, informational).

## Phase 3 — Visitor promotion (review decision)

### Engine

- When a **visitor** matches a PCO person, do **not** auto-link. Emit into a
  dedicated `visitorMatches` bucket (kept separate from `ambiguous`, which is for
  multi-candidate regulars):
  `{individualId, firstName, lastName, candidate: {pcoId, ...}}`.
- A **"declined link" marker** prevents re-prompting every sync. Add
  `individuals.pco_link_declined` (INTEGER DEFAULT 0) via the existing migration
  pattern in `database.js`. Declined visitors are excluded from future visitor-match
  prompts (until cleared).

### Apply

- **Promote:** set `planning_center_id` and `people_type = 'regular'` (PCO takes
  ownership; person becomes a locked regular).
- **Keep as visitor:** set `pco_link_declined = 1`; leave `people_type` and link
  untouched.

### Frontend

- A "Visitors found in Planning Center — promote or keep?" section, radio per
  person: *Promote to member* / *Keep as visitor*. Choices pass through
  `selections` to apply.

---

## Cross-cutting

### Error handling / edge cases

- **Mode off:** none of the above applies; current behavior unchanged, even if
  stale `planning_center_id`s exist.
- **Empty update after stripping locked fields:** 200 no-op.
- **Guarded op attempted via API while mode on:** consistent rejection payload;
  frontend already hides the affordance (defense in depth).
- **Extra later appears in PCO:** restore bucket links + reactivates on next
  review.
- **Visitor declined, later genuinely becomes a member in PCO:** they appear as a
  normal PCO `add` (new linked regular) since `pco_link_declined` suppresses only
  the *visitor-match prompt*; the duplicate, if any, is the user's to resolve.
  (Acceptable; revisit if it bites.)
- **Person not found / wrong church:** unchanged 404s.

### Testing

Backend:
- Edit locked attributes on a linked person → unchanged; people_type/family/badge
  change still applies; gathering assign/remove still works.
- Create regular while mode on → rejected; create visitor → allowed.
- Delete/merge/dedup involving a linked person → rejected; visitor delete → allowed.
- Plan: active unmatched regular → `archiveExtras`; unmatched visitor → no archive;
  archived individual matching PCO → `restore` (links + reactivates).
- Apply: archiveExtras sets `is_active=0`; restore sets link + `is_active=1`;
  promote sets link + `people_type='regular'`; keep sets `pco_link_declined=1`.

Frontend (manual):
- Linked person edit modal: name/age disabled, other fields editable.
- Mode on: Add-regular and CSV import hidden; visitor add available; merge/delete
  hidden for linked people.
- Sync & Review shows extras and visitor-promotion sections; Apply respects skips
  and choices.

### Out of scope

- Syncing PCO household *membership* changes into LMPG family groupings.
- Syncing PCO `nickname` for display (separate future enhancement).
- Two-way sync (LMPG → PCO writes). LMPG remains read-only toward PCO.

## Implementation order

Phases are independently shippable and should land in order: **1 → 2 → 3**. Each
delivers value alone (Phase 1: stop drift; Phase 2: converge population; Phase 3:
visitor crossover). The writing-plans step will sequence tasks accordingly.
