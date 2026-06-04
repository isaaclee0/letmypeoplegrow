# PCO Onboarding Import — Design

**Date:** 2026-06-04
**Status:** Approved for planning

## Overview & Motivation

A church that already uses Planning Center should be able to set up Let My
People Grow *from* their PCO data — members, gatherings, and historical
attendance — rather than starting with a blank slate and re-entering everything
by hand.

This adds a **Planning Center setup branch** to onboarding. After the existing
church-creation steps, the user chooses between setting up from Planning Center
or starting fresh. The PCO path connects Planning Center, imports people
(filtered by membership status), creates gatherings from PCO check-in events,
imports historical check-ins as attendance, and auto-assigns current regulars to
their gatherings — leaving the church fully populated.

This feature is mostly an **orchestration + UX layer** over capabilities that
already exist (PCO people source-of-truth import, the check-in → attendance
importer) plus one small OAuth change and one new auto-assignment behavior.

## Scope (this spec)

In scope: connect PCO during onboarding; import people with an allowlist filter;
create gatherings from PCO check-in events and import historical check-ins;
auto-assign active recent attendees to gathering rolls.

Out of scope: enabling ongoing source-of-truth people sync during onboarding
(remains a later toggle in Settings); the standalone Settings check-in importer
(already shipped); changing the "start fresh" flow.

## Flow

```
form → code → choose-path → ┬─ "Start fresh" → (existing flow) → /app/gatherings
                            └─ "Set up from Planning Center"
                                 → pco-connect      (OAuth round-trip)
                                 → pco-people        (allowlist import)
                                 → pco-gatherings    (events→gatherings + check-ins + auto-assign; SKIPPABLE)
                                 → done → /app/gatherings (populated)
```

People are imported **before** check-ins, because check-in person resolution
relies on `individuals.planning_center_id` already being present.

## Component 1 — OAuth return-to (backend)

`/planning-center/authorize` currently builds an OAuth `state` (base64 JSON with
`userId`, `churchId`, `timestamp`) and the callback always redirects to
`/app/settings?tab=integrations&pco_success=true`.

Change:
- `authorize` accepts an optional `returnTo` query param and includes it in the
  `state` JSON.
- `callback` redirects to `returnTo` when present and safe, else the existing
  settings URL. For onboarding, `returnTo = /app/onboarding?pco=connected`.
- **Safety:** only honor `returnTo` values that are app-relative paths beginning
  with `/app/` (reject absolute URLs / off-site redirects to prevent open
  redirect). If invalid, fall back to the settings URL.

Onboarding reads `?pco=connected` on load and resumes at the `pco-people` step.
The user is already authenticated (JWT cookie) and the church already exists, so
no re-login is needed across the round-trip.

## Component 2 — Import people step

Reuses the existing PCO source-of-truth pieces (no new import logic):

1. Fetch the **membership summary** (existing endpoint) to show PCO membership
   status counts (e.g. Members: 240, Regular Attenders: 85, Prospects: 30,
   Archived: 400).
2. Render the existing `MembershipAllowlistEditor` with sensible active-status
   defaults selected.
3. **Set the allowlist** (existing endpoint) from the user's selection.
4. **Run sync apply** (existing endpoint) to import matching people and their
   households as families. For a blank church the sync plan is purely additive
   (no updates/archives).

Ongoing source-of-truth sync is **not** enabled here; this is a one-time initial
import. Imported people have `planning_center_id` set and `is_active = 1`.

## Component 3 — Gatherings & history step (skippable)

Reuses the check-in importer (`GET .../checkins/events`,
`POST .../import-checkins/preview`, `POST .../import-checkins/execute`) with one
new onboarding-only behavior.

UI:
- On entry, auto-detect events (all-history range). If **no events / no
  check-ins**, show "No Planning Center check-ins found." and auto-advance to
  Done.
- Otherwise show the mapping table: every event defaults to **create new
  gathering**; the user can deselect events they don't want or map to an existing
  gathering.
- Show a recency-window input (default **8 weeks**, adjustable) governing
  auto-assignment.
- Preview → Confirm runs execute with the onboarding options.
- The entire step is **skippable** via a "Skip" action that advances to Done.

New behavior — **auto-assign to gatherings**:
- The execute endpoint gains optional params `assignToGatherings` (boolean) and
  `recencyWeeks` (integer, default 8). The standalone Settings importer calls
  execute without these (unchanged behavior — it never touches
  `gathering_lists`).
- When `assignToGatherings` is true, after writing present records, populate
  `gathering_lists`: add a person to a gathering's roll iff
  (a) the individual is **active** (`is_active = 1`, i.e. imported via the
  allowlist) **and**
  (b) they have ≥1 check-in to that gathering's event within the last
  `recencyWeeks` of the import (relative to today).
- Insert into `gathering_lists` with `ON CONFLICT DO NOTHING` (idempotent).
- Historical/archived/visitor attendees still receive present attendance records
  but are **not** added to any roll.

Nice-to-have (flagged, NOT committed in this spec): infer `day_of_week` /
`start_time` for created gatherings from the events' check-in times.

## Architecture & Isolation

**Backend:**
- Small `returnTo` change in `authorize` / `callback` (in
  `server/routes/integrations.js`).
- Extend the check-in `execute` handler (`runCheckinImport`) to accept
  `assignToGatherings` + `recencyWeeks` and perform the `gathering_lists`
  population inside the existing transaction.
- New **pure** helper in `server/services/planningCenter/checkinsImport.js`:
  `buildGatheringListAdds(normalized, activeIndividualIds, personToIndividual,
  eventToGathering, recencyWeeks, today)` → deduped `[{ gatheringTypeId,
  individualId }]` for people active + recent. Unit-tested. The route maps PCO
  people → individual ids and supplies the set of active individual ids.

**Frontend:**
- Onboarding becomes a small step machine:
  `form → code → choose-path → (pco-connect → pco-people → pco-gatherings) →
  done`. `OnboardingPage.tsx` manages the step state and the `?pco=connected`
  resume.
- The PCO sub-steps are thin wrappers composing existing components:
  - people step composes `MembershipAllowlistEditor` + membership summary;
  - gatherings step reuses `PCOCheckinImport`, lightly parameterized to accept an
    onboarding mode (`assignToGatherings` + `recencyWeeks`), a Skip action, and
    an `onComplete` callback. In Settings it renders as today (no assignment, no
    onboarding chrome).
- People imported before check-ins.

## Error Handling

- OAuth failure or user cancel: return to the choose-path step with a message;
  "Start fresh" remains available.
- People import failure: show the error, allow retry; do not advance.
- Check-in detection/import failure: show the error in the step; Skip remains
  available so a failure here never blocks completing onboarding.
- `returnTo` validation rejects non-`/app/` paths (open-redirect guard).

## Testing

- **Unit:** `buildGatheringListAdds` — recency boundary (inside vs outside
  window), active-only filter (inactive excluded), dedup, unmapped-event skip,
  empty inputs. Existing `checkinsImport` tests remain green.
- **Manual E2E (test church):**
  - Full PCO branch: connect → people imported per allowlist → gatherings created
    from events → present records written → rolls populated only with active +
    recent attendees.
  - Skip path: skipping the gatherings step completes onboarding cleanly.
  - No-data path: a church with no check-ins auto-advances with the note.
  - "Start fresh" path: unchanged from today.
  - Settings importer regression: still imports present-only and does NOT touch
    `gathering_lists`.
