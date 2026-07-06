# PCO Gathering Assignment for Already-Linked People

## Problem

A PCO sync batch can assign everyone it touches to a gathering (`gathering_type_id`
on `planning_center_sync_batches`). Gathering assignment currently only fires for
individuals a batch run actually links, restores, promotes, or newly creates this run
(`touchedIndividualIds` in `server/services/planningCenter/apply.js`).

`computePlan()` (`server/services/planningCenter/diffEngine.js`) never re-checks
eligibility for someone who is *already linked and already active* — eligibility is
only consulted for brand-new PCO people (`add`) and for archived individuals coming
back (`reactivate`). So once a person is linked (via any batch, at any point in the
past), they become permanently invisible to every other batch's plan, even if they
later start matching that batch's filter in PCO.

Concretely: someone already synced in as a regular member (e.g. via a "Main Sync"
membership-category batch) who later gets tagged into a PCO custom-tab field (e.g.
"Youth Ministries") that a different batch filters on and assigns to a "Youth"
gathering — running that batch will never add them to the Youth gathering. They don't
appear anywhere in that batch's plan at all.

## Goal

Any batch with a `gathering_type_id` set should, on every run (manual or scheduled),
ensure every currently-eligible, currently-active person — whether freshly
linked/added this run or already linked from a previous run/batch — ends up in that
gathering's roster. This applies uniformly regardless of which eligibility source
(membership category or custom-tab field) makes them eligible.

Also in scope: reactivated individuals (archived, PCO shows active again, still
eligible) have the same gap today — `reactivate` never contributes to
`touchedIndividualIds` either. Fixed in the same pass since it's the same root cause.

## Design

### `diffEngine.js`: new `gatheringEligible` bucket

In the existing `for (const i of linked)` loop (already computing `update`/`archive`/
`reactivate`), add a person to a new `gatheringEligible` array whenever they end this
run **active** and **eligible** for `filterConfig` — regardless of whether that's
because they were already active, or because they're being reactivated this run.
Excluded: anyone being archived this run (even if they were eligible up to now), and
anyone not eligible.

```js
const gatheringEligible = [];
for (const i of linked) {
  const p = pcoById.get(i.planningCenterId);
  if (!p) continue;
  if (i.isActive && p.status === 'inactive') {
    archive.push({ individualId: i.id, pcoId: p.id });
  } else if (!i.isActive && p.status === 'active' && isEligible(p, filterConfig)) {
    reactivate.push({ individualId: i.id, pcoId: p.id });
    gatheringEligible.push({ individualId: i.id, pcoId: p.id });
  } else if (i.isActive && isEligible(p, filterConfig)) {
    gatheringEligible.push({ individualId: i.id, pcoId: p.id });
  }
  if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
    update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
  }
}
```

`gatheringEligible` is added to `computePlan`'s return value alongside the existing
buckets. It does not affect `link`, `add`, `update`, `archive`, or `reactivate` — it's
purely an additional input to gathering-roster assignment in `apply.js`. It has no
"skip" concept and isn't reviewable (see below) — nothing about the plan's other
buckets or result counts changes.

### `apply.js`: broaden gathering assignment, count only new rows

`touchedIndividualIds` (currently populated only by fresh link/restore/visitor-promote/
add) also absorbs every `individualId` in `plan.gatheringEligible`:

```js
for (const g of (plan.gatheringEligible || [])) touchedIndividualIds.add(g.individualId);
```

This is added right before the existing gathering-assignment block, so no other logic
needs to change — the block already only runs `if (gatheringTypeId)`, and the
`INSERT ... ON CONFLICT(gathering_type_id, individual_id) DO NOTHING` is already
idempotent for people already on the roster.

To report a real count (not "everyone currently eligible," which would show the same
number every week regardless of whether they're already on the roster), use the
insert's `affectedRows` — already returned by `Database.queryForChurch`/`query` for
non-SELECT statements (`server/config/database.js:404-436`, `{ insertId, affectedRows }`
from `better-sqlite3`'s `stmt.run()`). Add a new `result.gatheringAssigned` counter,
incremented only when `affectedRows === 1` (a genuinely new roster row), for every
individual in the (now-broadened) `touchedIndividualIds` set — covering both the
already-existing freshly-touched people and the new `gatheringEligible` people
uniformly, since both go through the same insert.

```js
if (gatheringTypeId) {
  for (const individualId of touchedIndividualIds) {
    try {
      const insertResult = await Database.query(
        `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
         VALUES (?, ?, ?, ?) ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
        [gatheringTypeId, individualId, userId, churchId]
      );
      if (insertResult.affectedRows > 0) result.gatheringAssigned++;
    } catch (e) { result.errors.push({ type: 'gatheringAssign', id: individualId, error: e.message }); }
  }
}
```

`result.gatheringAssigned` starts at `0` alongside the other result counters.

### Surfacing the count

The `/planning-center/sync-batches/:id/apply` route (`server/routes/integrations.js`,
around line 2811) already builds a `summary` object stored as the batch's
`last_sync_result` — add `gatheringAssigned: result.gatheringAssigned` to it. The
scheduled cron path (`server/services/planningCenterSync.js`, the `syncChurch`
function) builds an equivalent summary for its own `last_sync_result` write — same
addition there.

Client-side, `PlanningCenterIntegrationPanel.tsx:379-382` already renders "Last run
{date}: {added} added, {updated} updated, {linked} linked{, N need review}." — add
", {gatheringAssigned} added to gathering" to that line, shown only when the batch has
a `gatheringTypeId` set and the count is nonzero (a batch with no gathering assigned
has `gatheringAssigned` always `0` and shouldn't clutter the line).

## Error handling & edge cases

- A person who is `gatheringEligible` for batch A this run, but batch A has no
  `gatheringTypeId` set: no-op, matches existing behavior (the whole block is gated on
  `gatheringTypeId`).
- A person eligible for two different batches, both with different gatherings
  assigned: each batch's own apply run inserts into its own gathering independently —
  no interaction between batches, no double-counting (the `ON CONFLICT` key is
  `(gathering_type_id, individual_id)`, so the same person can be a genuinely-new
  insert once per distinct gathering).
- A person already on a gathering's roster (added manually, or by an earlier run of
  the same batch): `affectedRows` is `0`, correctly excluded from
  `result.gatheringAssigned`, no error.
- Errors inserting a specific individual's gathering-roster row are collected in
  `result.errors` exactly as today — this doesn't change the plan/apply's
  fail-soft-per-item behavior.

## Testing

`diffEngine.test.js`:
- Already-linked, active, eligible → appears in `gatheringEligible`.
- Already-linked, active, NOT eligible → excluded from `gatheringEligible`.
- Being archived this run (was active, PCO now inactive) → excluded from
  `gatheringEligible` even if they were eligible before this run.
- Reactivate-and-eligible (archived, PCO active again, eligible) → appears in both
  `reactivate` and `gatheringEligible`.
- Reactivate candidate that is NOT eligible → excluded from both (matches existing
  `reactivate` behavior, confirmed unchanged).

`apply.test.js`:
- A `gatheringEligible` individual with no prior gathering-roster row → gets inserted,
  `result.gatheringAssigned` increments.
- A `gatheringEligible` individual already on the roster → insert no-ops
  (`ON CONFLICT DO NOTHING`), `result.gatheringAssigned` does NOT increment.
- `gatheringTypeId` not set on the batch → no gathering-roster inserts attempted at
  all, `result.gatheringAssigned` stays `0`.
- A freshly-added (brand new) individual with a `gatheringTypeId` batch → still counts
  toward `result.gatheringAssigned` on first insert (existing behavior preserved,
  now counted where it wasn't before).
