# PCO Batch Gathering Auto-Removal

## Problem

`computePlan()` (`server/services/planningCenter/diffEngine.js`) and its
`gatheringEligible` bucket (added in
`docs/superpowers/specs/2026-07-06-pco-gathering-sync-for-linked-people-design.md`)
only ever **add** people to a batch's assigned gathering. Nothing ever removes them.

Concretely: a person is in a "Youth" batch (custom-tab field filter), assigned to the
Youth gathering. They turn 18 and PCO removes the youth custom-tab value. Their PCO
`status` stays `active` — so `diffEngine.js`'s per-linked-individual loop
(`server/services/planningCenter/diffEngine.js:124-138`) doesn't archive them (that
only fires on `status === 'inactive'`), and since `isEligible(p, filterConfig)` now
returns `false` for the Youth batch, they simply stop appearing in `gatheringEligible`.
Nothing deletes their existing `gathering_lists` row. They stay on the Youth roster
indefinitely, even though they may now correctly belong to a different batch/gathering
(e.g. an "Adults" batch, which — if it matches them — adds them there independently;
it never touches the stale Youth row).

## Goal

A per-batch, opt-in setting: when enabled, a batch's own sync run removes people from
its assigned gathering the moment they no longer match its filter — but **only**
people that batch itself put there. A gathering row added manually by a coordinator,
or by a *different* batch also targeting the same gathering, must never be touched by
a batch that didn't add it.

Out of scope: reconciling a batch's *previous* gathering after an admin reassigns it
to a different one, and any cross-batch coordination to avoid the brief
remove-then-re-add "flicker" when two batches target the same gathering (see Edge
Cases).

## Design

### Schema (additive)

```sql
ALTER TABLE planning_center_sync_batches
  ADD COLUMN gathering_auto_remove_enabled INTEGER DEFAULT 0;

ALTER TABLE gathering_lists
  ADD COLUMN added_by_pco_batch_id INTEGER
    REFERENCES planning_center_sync_batches(id) ON DELETE SET NULL;
```

`gathering_auto_remove_enabled` only has an effect when the batch also has a
`gathering_type_id` set. `added_by_pco_batch_id` is nullable — most existing rows
(manual additions, or anything added before this feature shipped) have no owner and
are never candidates for auto-removal.

### `diffEngine.js`: no changes

`gatheringEligible` (and `link`/`restore`/`add`, which already feed
`touchedIndividualIds` in `apply.js`) already represents exactly "everyone this batch
currently says belongs on its gathering, this run." Removal is a pure diff against
that existing set plus the DB's current state — it doesn't need any new information
`diffEngine.js` isn't already computing. All new logic lives in `apply.js`, which
already owns every `gathering_lists` write.

### `apply.js`: tag ownership on insert (always)

In the existing gathering-assignment block
(`server/services/planningCenter/apply.js:210-221`), stamp
`added_by_pco_batch_id = batch.id` on every insert — regardless of whether
`gatheringAutoRemoveEnabled` is on for this batch. This is unconditional and cheap; it
means ownership keeps accumulating for every batch over time, so a batch that gets the
toggle switched on later already has partial ownership data without needing a fresh
backfill for anything synced since this feature shipped.

```js
if (gatheringTypeId) {
  for (const individualId of touchedIndividualIds) {
    try {
      const insertResult = await Database.query(
        `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id, added_by_pco_batch_id)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
        [gatheringTypeId, individualId, userId, churchId, batchId]
      );
      if (insertResult.affectedRows > 0) result.gatheringAssigned++;
    } catch (e) { result.errors.push({ type: 'gatheringAssign', id: individualId, error: e.message }); }
  }
```

Note `ON CONFLICT ... DO NOTHING` means an existing row's `added_by_pco_batch_id` is
never overwritten by a later insert attempt — ownership is first-writer-wins, which is
exactly what keeps two batches targeting the same gathering from stepping on each
other (see Edge Cases).

`applyPlan`'s signature needs the batch's own id, not just its config fields — add
`batchId` to the `batchConfig` object passed in (currently
`{ defaultPeopleType, gatheringTypeId }`), destructured the same way the existing
fields already are: `const batchId = batchConfig.batchId || null;`.

### `apply.js`: removal step (only when enabled)

Immediately after the insert loop, when `batchConfig.gatheringAutoRemoveEnabled` and
`gatheringTypeId` are both set:

```js
if (gatheringTypeId && batchConfig.gatheringAutoRemoveEnabled) {
  const owned = await Database.query(
    `SELECT individual_id FROM gathering_lists
      WHERE gathering_type_id = ? AND added_by_pco_batch_id = ? AND church_id = ?`,
    [gatheringTypeId, batchId, churchId]
  );
  for (const row of owned) {
    if (touchedIndividualIds.has(row.individual_id)) continue;
    try {
      const delResult = await Database.query(
        `DELETE FROM gathering_lists
          WHERE gathering_type_id = ? AND individual_id = ? AND added_by_pco_batch_id = ? AND church_id = ?`,
        [gatheringTypeId, row.individual_id, batchId, churchId]
      );
      if (delResult.affectedRows > 0) result.gatheringRemoved++;
    } catch (e) { result.errors.push({ type: 'gatheringRemove', id: row.individual_id, error: e.message }); }
  }
}
```

`result.gatheringRemoved` starts at `0` alongside the other counters. This runs
identically for scheduled (`runBatchSync`) and manual (`POST
/planning-center/sync-batches/:id/apply`) runs — both call `applyPlan`/`applyForChurch`
with the same `batchConfig` shape, so no branching needed at the call sites beyond
passing the new fields through.

### Threading the new fields through

- `rowToBatch`/`BATCH_SELECT` in `server/services/planningCenterSync.js` (currently
  handles `gatheringTypeId`, `scheduleDay`, etc.) — add
  `gatheringAutoRemoveEnabled: !!row.gatheringAutoRemoveEnabled` and the corresponding
  `gathering_auto_remove_enabled AS gatheringAutoRemoveEnabled` column to the SELECT.
- `POST /planning-center/sync-batches` and `PUT /planning-center/sync-batches/:id`
  (`server/routes/integrations.js:2227`, `:2252`) — accept
  `gatheringAutoRemoveEnabled` in the body, persist it alongside the existing columns.
- `POST /planning-center/sync-batches/:id/apply`
  (`server/routes/integrations.js:2391-2394`) and `runBatchSync`
  (`server/services/planningCenterSync.js:403-406`) — both build the `batchConfig`
  object passed to `applyForChurch`; add `batchId: batch.id, gatheringAutoRemoveEnabled:
  batch.gatheringAutoRemoveEnabled` to both.

### Toggle-enable backfill

In `PUT /planning-center/sync-batches/:id`, before persisting the update, compare the
incoming `gatheringAutoRemoveEnabled` against `existing.gatheringAutoRemoveEnabled`
(already loaded via `pcoSync.getBatch`). On a `false → true` transition, with
`gatheringTypeId` set (either already, or in this same request), run a one-time
backfill after the UPDATE commits:

1. Reuse the already-cached PCO people (`pcoSync.getCachedPcoPeople` — no new PCO
   fetch).
2. `SELECT gl.id, i.planning_center_id AS pcoId FROM gathering_lists gl JOIN
   individuals i ON i.id = gl.individual_id WHERE gl.gathering_type_id = ? AND
   gl.added_by_pco_batch_id IS NULL AND gl.church_id = ? AND i.planning_center_id IS
   NOT NULL AND i.is_active = 1`
3. For each row, look up the PCO person by id; if `status === 'active'` and
   `isEligible(person, batchFilterConfig(batch))` (reusing
   `server/services/planningCenter/eligibility.js` as-is), `UPDATE gathering_lists SET
   added_by_pco_batch_id = ? WHERE id = ?`.
4. Rows that don't qualify (unlinked, inactive, or PCO-linked but not matching this
   batch's filter) are left untouched permanently — same protection as the ownership
   model generally: if this batch didn't add it and doesn't currently claim it, it's
   never a candidate for removal.

This runs synchronously inside the PUT response (admin-initiated save, not an
unattended path — a per-church gathering roster is small, this is a handful of local
DB rows plus in-memory PCO lookups, not a new network fetch).

### UI (`client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`)

Directly under the existing gathering-assignment `<select>`
(`PlanningCenterBatchEditor.tsx:196-210`), a checkbox:

> ☐ Automatically remove people from this gathering when they no longer match this batch

Disabled when `gatheringMode === 'none'`. On save, if this is being switched from
unchecked to checked, show a one-time inline confirmation before submitting (mirroring
the existing source-of-truth-mode confirmation pattern):

> "This will also remove anyone already on the roster who doesn't currently match this
> batch, next time it syncs. Continue?"

## Error handling & edge cases

- **Two batches target the same gathering.** Ownership is first-writer-wins
  (`ON CONFLICT DO NOTHING` never overwrites `added_by_pco_batch_id`). If Batch A owns
  a row and the person stops matching A but still matches Batch B, A's removal step
  deletes the row (A no longer claims them) even though B would still want them there.
  B's own next run re-adds them via its normal `gatheringEligible` → insert path,
  re-stamping ownership to B. This is a bounded, self-healing gap (at most one run
  cycle of B), accepted rather than built out into cross-batch coordination — see
  Goal's Out of Scope note.
- **Batch's assigned gathering is changed.** Rows the batch previously owned on its
  *old* gathering are never revisited (the removal query is scoped to the batch's
  *current* `gatheringTypeId`) — they remain marked with that batch's id, on a
  gathering the batch no longer targets, forever. Accepted as a rare admin action, not
  handled specially.
- **Batch deleted.** `ON DELETE SET NULL` on `added_by_pco_batch_id` leaves the actual
  `gathering_lists` rows (and gathering membership) intact — only ownership is
  forgotten, so nothing auto-removes those people afterward (correct: deleting a batch
  shouldn't retroactively empty a gathering).
- **Toggle switched off after being on.** Tagging on insert continues (it's
  unconditional); the removal step simply stops running because it's gated on
  `gatheringAutoRemoveEnabled`. No data is changed by turning it off.
- **Person removed this run for both archive and gathering-ineligibility
  simultaneously** (e.g. PCO status went inactive AND they'd also fail the filter):
  `archive` fires as it already does today (unrelated to this feature); they're also
  absent from `touchedIndividualIds`, so the gathering-removal step deletes their
  roster row too. No conflict — both fire independently from the same "not in this
  run's eligible set" fact.
- **Visibility.** `gatheringRemoved` is added to the batch's `last_sync_result`
  summary (same tier as `gatheringAssigned`/`archived` today) — not wired into the
  existing PCO review-needed push notification, since removal here is automatic
  (already-applied), not something pending review. Client-side,
  `PlanningCenterIntegrationPanel.tsx:379-382`'s "Last run: N added, N updated..."
  line gets a corresponding ", N removed from gathering" clause, shown only when the
  batch has `gatheringAutoRemoveEnabled` on and the count is nonzero — mirroring
  exactly how `gatheringAssigned` was added to that same line.

## Testing

`apply.test.js`:
- Insert loop stamps `added_by_pco_batch_id` on every new row, regardless of whether
  `gatheringAutoRemoveEnabled` is set for that batch.
- Removal only deletes rows where `added_by_pco_batch_id` matches the batch being run;
  rows owned by a different batch, or with no owner (manual add), are left alone even
  if the individual no longer matches this batch's filter.
- `gatheringAutoRemoveEnabled: false` → zero deletions regardless of eligibility
  changes.
- A person still in `touchedIndividualIds` (still eligible) → their owned row is not
  touched.

End-to-end style (`planningCenterSync.test.js` or equivalent):
- Person eligible and on gathering → PCO field cleared → next batch run → gathering
  row gone; individual remains `is_active = 1` and linked (not archived, not otherwise
  changed).
- Two-batch flicker: Batch A owns the row; person stops matching A but still matches
  Batch B (also targeting the same gathering); A's run removes the row; B's next run
  re-adds it with ownership now stamped to B. Assert this explicitly as expected
  behavior.

Backfill (route-level or a dedicated helper test):
- Toggling `false → true` stamps ownership only onto rows that are linked, active, and
  currently eligible for the batch's filter; unlinked/non-matching/inactive rows stay
  unowned.
- Toggling `true → false → true` again does not re-run the backfill a second time
  unless the transition is genuinely `false → true` in that request (i.e. flipping it
  off and back on in two separate saves re-triggers it, which is correct — anything
  newly stale since the first backfill should get picked up too).
