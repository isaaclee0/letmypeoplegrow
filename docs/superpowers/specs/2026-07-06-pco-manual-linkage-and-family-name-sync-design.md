# PCO Manual Linkage, Manual Archive, and Family Name Sync

## Problem

Today, when a PCO sync finds a name it can't confidently match:

- **Ambiguous** (multiple PCO candidates for one LMPG individual, `matcher.js` /
  `diffEngine.js`'s `ambiguous` bucket) — the reviewer can only pick one of the
  *auto-detected* candidates, or skip. If the right PCO person isn't one of the
  auto-detected candidates (e.g. they didn't share a household or the child flag
  didn't line up), there's no way to link them at all.
- **Unmatched extras** (`archiveExtras` bucket, surfaced only in Reconciliation
  Review) — an active LMPG individual whose name matched *nobody* in PCO. Today the
  only options are archive or skip. If this is actually a name-change/nickname case
  (the right PCO person exists but the matcher's exact-name-after-normalization rule
  missed them), there's no way to link them — the reviewer is stuck re-archiving them
  every reconciliation run, or leaving them unlinked forever.

Separately, LMPG family names are only set once, at creation time
(`buildFamilyName` in `server/services/planningCenter/apply.js:4`), from whichever
adults happen to be in the household-add group. There's no concept of PCO's actual
head-of-household, and no mechanism to fix a family name later if PCO has better
information (e.g. the wrong adult got listed first, or a family name never matched
LMPG's own naming convention in the first place).

## Goal

1. Let a reviewer manually search and link *any* PCO person to an unmatched or
   ambiguous LMPG individual — not just auto-detected candidates — with archiving as
   an explicit alternative when no match exists.
2. Keep LMPG family names in sync with PCO's designated head-of-household, as a
   reviewable (not automatic) step in the same Sync Review flow.

## Part A: Manual linkage + archive

### New search endpoint

`GET /api/integrations/planning-center/people-search?q=<text>`

Reuses the existing `getCachedPcoPeople(churchId, accessToken)` cache (no new PCO
API calls per keystroke — same cache `computePlanForBatch`/`computeReconciliationForChurch`
already read). Normalizes `q` with `matcher.js`'s existing `normalizeName()` and
substring-matches against each cached person's normalized `firstName|lastName`.
Excludes any PCO person whose id already appears as some individual's
`planning_center_id` in this church's DB (`SELECT planning_center_id FROM individuals
WHERE church_id = ? AND planning_center_id IS NOT NULL`) — already-linked people
can't be picked again. Returns up to 20 matches:
`{ pcoId, firstName, lastName, householdId, status }`.

### Ambiguous list (Sync Review, per batch)

**Client** (`PlanningCenterSyncReview.tsx`): each ambiguous row keeps its existing
auto-detected candidate radios, and gains:
- A "Search for someone else" text input (debounced call to the new endpoint)
  whose results become additional selectable radio options for that row (still
  stored in the same `ambiguousChoices[individualId] = pcoId` state — the picked
  pcoId no longer has to be one of `candidateDetails`).
- A new "Archive this person" radio, stored in a new `archiveAmbiguousIds: Set<number>`
  state (mutually exclusive with picking a pcoId or skipping, since it's the same
  radio group per row).

**`syncSelections.ts`**: `SyncSelections` gains `archiveAmbiguousIds: number[]`.

**Server validation** (`routes/integrations.js`, `/sync-batches/:id/apply`): today's
`candidatesByIndividual` check restricts `ambiguous` picks to `plan.ambiguous[].candidates`.
Replace it with a broader check: build a `claimedPcoIds` Set seeded from
`plan.link`, `plan.restore`, `plan.visitorMatches[].candidate.pcoId`, and non-skipped
`plan.add[].pcoId`. Then, for each `[individualId, pcoId]` in `rawSel.ambiguous`
(processed in a stable order, e.g. object key order): accept it only if
`individualId` is one of `plan.ambiguous[].individualId`, `pcoId` exists in this
run's `getCachedPcoPeople` snapshot, and `pcoId` is not already in `claimedPcoIds` —
then add it to `claimedPcoIds` so a later entry in the same payload can't reuse it.
For `archiveAmbiguousIds`, filter to ids that are actually in `plan.ambiguous`.

**`apply.js`**: `applyPlan` already builds `links` from `plan.link` +
`ambiguousChoices` (line 52-55) — no change needed there once the route passes a
validated, now-unrestricted pcoId. Add a new loop for `selections.archiveAmbiguousIds`,
parallel to the existing `plan.archive` loop, incrementing `result.archived`.

### Unmatched extras (Reconciliation Review)

**Client** (`PlanningCenterReconciliationReview.tsx`): each `archiveExtras` row keeps
its existing checkbox (checked = "will archive") and gains a "Link instead" text
input (same debounced search). Picking a result stores
`manualLinks[individualId] = pcoId` and implicitly overrides the archive checkbox for
that row (link takes precedence over archive — a row can't be both).

**`syncSelections.ts`**: `ReconciliationSelections` gains `manualLinks: Record<string, string>`.

**Server** (`routes/integrations.js`, `/reconciliation/apply`): validate `manualLinks`
the same way as ambiguous picks above — pcoId must exist in the fresh
`getCachedPcoPeople` snapshot and must not repeat within the same payload. Any
`individualId` present in a validated `manualLinks` entry is excluded from the
archive set even if it wasn't in `skipArchiveExtraIds` (link wins over archive).

**`apply.js`**: `applyArchiveExtras(churchId, archiveExtras, { skipArchiveExtraIds, manualLinks })`
— for ids in `manualLinks`, run `UPDATE individuals SET planning_center_id = ?,
updated_at = datetime('now') WHERE id = ? AND church_id = ?` instead of archiving,
and count in a new `result.linked` field (`applyArchiveExtras`'s result becomes
`{ archived, linked, errors }`).

### Not in scope

- Manual link does **not** move the individual to a different LMPG family, even if
  the picked PCO person belongs to a different household. Family membership stays a
  separate, manual concern.
- No fuzzy/typo-tolerant search — substring match on normalized name is enough for a
  reviewer typing a name they already know.

## Part B: Family name sync from PCO's head-of-household

### Capturing head-of-household from PCO

PCO's `Household` resource (already returned in the `included` array whenever
`include=households` is requested — currently discarded) has a `primary_contact_id`
attribute naming the PCO person who heads that household.

`fetchAllPcoPeople` (`server/services/planningCenterSync.js:157`) additionally
collects `Household`-type `included` entries per page into a
`Map<householdId, primaryContactPcoId>` and returns
`{ people, householdPrimaryContacts }`. `getCachedPcoPeople`'s cache entry becomes
`{ people, householdPrimaryContacts, fetchedAt }`.

### Extracting `buildFamilyName` into a shared pure module

`buildFamilyName` currently lives in `apply.js` (a DB-writing module). Since
`diffEngine.js` (pure computation, no DB/HTTP) now needs it too, move it to a new
`server/services/planningCenter/familyName.js` and have both `apply.js` and
`diffEngine.js` import from there. No behavior change to the existing function.

### Computing proposed renames

`loadChurchState` (`planningCenterSync.js:183`) adds `family_name AS familyName` to
its `families` query. `computePlanForChurch` passes `householdPrimaryContacts`
through to `computePlan`.

In `diffEngine.js`, after the existing per-family-membership grouping already built
for corroboration (`familyMembers`, line 32-37 — reused as-is), add:

```js
const familyNameUpdates = [];
if (householdPrimaryContacts) {
  const membersByFamily = new Map();
  for (const i of individuals) {
    if (i.familyId == null) continue;
    if (!membersByFamily.has(i.familyId)) membersByFamily.set(i.familyId, []);
    membersByFamily.get(i.familyId).push(i);
  }
  for (const f of families) {
    if (!f.planningCenterId) continue;
    const primaryContactPcoId = householdPrimaryContacts.get(f.planningCenterId);
    if (!primaryContactPcoId) continue;
    const members = membersByFamily.get(f.id) || [];
    const head = members.find((m) => m.planningCenterId === primaryContactPcoId);
    if (!head) continue; // head-of-household not yet linked in LMPG -> no guess
    const newName = buildFamilyName([head, ...members.filter((m) => m !== head)]);
    if (newName !== f.familyName) {
      familyNameUpdates.push({ familyId: f.id, oldName: f.familyName, newName });
    }
  }
}
```

`familyNameUpdates` is added to `computePlan`'s return value alongside the existing
buckets.

This is naturally idempotent: once a family's name is updated (from any batch's
Sync Review), later recomputations (from any batch) see `newName === f.familyName`
and stop proposing it. It's normal for the same outstanding proposal to appear in
more than one batch's Sync Review until someone applies it from either screen.

### Review + apply

**Client** (`PlanningCenterSyncReview.tsx`): new "Family name updates" section,
listing `oldName → newName` per family, checkbox per row **checked by default**.
State: `skipFamilyNameUpdateIds: Set<number>` (familyId), inverted like the existing
`skipAdd` pattern (checked = will apply).

**`syncSelections.ts`**: `SyncSelections` gains `skipFamilyNameUpdateIds: number[]`.

**Server** (`routes/integrations.js`, `/sync-batches/:id/apply`): filter
`rawSel.skipFamilyNameUpdateIds` to ids present in `plan.familyNameUpdates`, same
pattern as `skipAddPcoIds`.

**`apply.js`**: new loop over `plan.familyNameUpdates`, skipping ids in
`selections.skipFamilyNameUpdateIds`:

```js
for (const u of (plan.familyNameUpdates || [])) {
  if (skipFamilyName.has(u.familyId)) continue;
  try {
    await Database.query(
      `UPDATE families SET family_name = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [u.newName, u.familyId, churchId]
    );
    result.familyNamesUpdated++;
  } catch (e) { result.errors.push({ type: 'familyName', id: u.familyId, error: e.message }); }
}
```

`result.familyNamesUpdated` starts at `0` alongside the other counters.

### Not in scope

- Does not change the name given to brand-new families created via the `add` flow
  (still `buildFamilyName(g.members)` in insertion order — untouched).
- Does not touch families with no `planning_center_id` (never linked to a PCO
  household) or where the head-of-household isn't yet linked to an LMPG individual —
  no guess is made in either case.

## Error handling & edge cases

- **No existing uniqueness constraint on `individuals.planning_center_id`**
  (confirmed: `server/config/schema.js` has no unique index on it today — only
  `idx_individuals_name`, `idx_individuals_family`, `idx_individuals_active`,
  `idx_individuals_church`). This is a pre-existing gap, but broadening manual
  search to "any PCO person" makes it much easier for a reviewer to accidentally
  pick the same pcoId for two different individuals in one payload (or for two
  concurrent requests/tabs to race). Add a partial unique index as part of this
  work:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_individuals_pco_id_unique
    ON individuals(church_id, planning_center_id) WHERE planning_center_id IS NOT NULL;
  ```
  in `server/config/schema.js`. This turns a same-payload duplicate (already
  rejected by the `claimedPcoIds` check) and a cross-request race (not otherwise
  catchable) into a caught DB error pushed to `result.errors`, instead of silently
  producing two individuals with the same `planning_center_id`.
- A manually-picked pcoId that's also present in the current run's `plan.add` list
  (not yet created in LMPG): once linked manually to an existing individual, that
  pcoId is now present in `individuals.planning_center_id`, so the *next* plan
  computation (this run already computed its `add` list before this apply) will
  naturally exclude it from `add` — no special-case handling needed, but note the
  currently-running apply's `add` loop still processes it this one time if the
  reviewer didn't separately skip it in `skipAddPcoIds`. Document this as an
  acceptable, self-correcting edge case (next run cleans it up) rather than adding
  cross-bucket exclusion logic to a single apply pass.
- `familyNameUpdates` head-of-household resolution depends only on `family_id` /
  `planning_center_id` already loaded by `loadChurchState`; no extra queries.
- If PCO's `primary_contact_id` points to someone who isn't a member of that
  household in PCO's own data (shouldn't happen, but PCO data can be inconsistent),
  `head` won't be found among `membersByFamily.get(f.id)` (since that's LMPG's
  membership, not PCO's) — falls through to "skip, no guess" the same as the
  not-yet-linked case.

## Testing

`matcher.test.js` / new `peopleSearch.test.js` (or inline in `matcher.js` test file):
- Search excludes PCO people already linked to an individual.
- Search matches on normalized substring (accents/punctuation stripped, same as
  existing `normalizeName`).

`diffEngine.test.js`:
- Ambiguous individual manually linked to a pcoId outside `candidates` — accepted at
  the route/validation layer (covered by an `integrations` route-level or
  `apply.test.js`-level test, not `diffEngine` itself, since `diffEngine` doesn't do
  this validation).
- `familyNameUpdates`: family linked to a PCO household, head-of-household linked in
  LMPG, name differs → proposed. Head-of-household not linked in LMPG → skipped, no
  proposal. Family already matching → not proposed. Family with no
  `planning_center_id` → not proposed.

`apply.test.js`:
- `archiveAmbiguousIds` archives the given individuals, increments `result.archived`.
- `applyArchiveExtras` with `manualLinks` links instead of archiving, increments the
  new `result.linked`, and does NOT touch `is_active`.
- `familyNameUpdates` applied except for skipped familyIds; `result.familyNamesUpdated`
  reflects only the applied ones.

There's no existing route-level test file for `integrations.js` (checked — none
exists today), and this design doesn't introduce one. The `claimedPcoIds`
dedup/validation logic added to the two route handlers should instead be extracted
into a small pure function (e.g. `resolveClaimedSelections(plan, rawSelections,
cachedPcoIds)` in `diffEngine.js` or a new `selectionValidation.js`) so it's
unit-testable the same way the rest of the sync engine is, covering:
- Duplicate/claimed pcoId across `ambiguous` + `manualLinks` in the same payload —
  second claimant rejected.
- pcoId not present in the current `getCachedPcoPeople` snapshot — rejected.
- Otherwise-valid pick — accepted.
