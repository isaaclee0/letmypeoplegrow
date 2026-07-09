# PCO Integration: How It Should Work vs. What You Might Be Missing

**Date:** 2026-07-08 (addendum added 2026-07-09)
**Status:** Investigation notes (not a design spec)

This document summarizes how the Planning Center Online (PCO) integration is
intended to work, what is implemented, and where behavior or UX diverges from that
intent. It is based on the approved design specs in `docs/superpowers/specs/` and
the current codebase.

**2026-07-09 addendum:** A second, independent review (code + git-history archaeology,
no access to the design specs) cross-checked this document. All of its behavioral/UX
findings were independently corroborated. That pass also surfaced two reliability
risks this document didn't cover — both folded in below and marked `[cross-review]`:
a triplicated OAuth token-refresh implementation (item 2 under High impact) and two
unrelated, unmerged PCO caching layers (item 12 under Medium impact).

---

## Intended Mental Model

The PCO integration is **not** a generic two-way church management bridge. It is a
deliberately split ownership model:

| Domain | Source of truth | Mechanism |
|--------|----------------|-----------|
| Regular/member people (names, child flag, active/inactive) | PCO | Batch sync + reconciliation |
| Visitors | LMPG | Hand-managed; optional promotion to regular via sync review |
| Family groupings | LMPG | Set at link time; optional family-name updates from PCO head-of-household (review only) |
| Gatherings / service schedule | LMPG | Created manually, via batch roster assignment, or from PCO Check-in **events** (not PCO Services) |
| Ongoing attendance | LMPG | Live tracking in-app; PCO check-ins are **historical migration only** |

```
┌─────────────┐     OAuth      ┌──────────────────────────┐
│   Browser   │◄──────────────►│  PCO API (people/check_ins)│
└──────┬──────┘                └────────────▲─────────────┘
       │                                    │
       ▼                                    │ Bearer token (one-way read)
┌──────────────────────────────────────────────────────────┐
│  integrations.js  ──►  planningCenterSync.js (cron 2 AM) │
│       │                      │                            │
│       ▼                      ▼                            │
│  diffEngine ──► apply.js ──► SQLite (individuals,       │
│  checkinsImport.js          families, attendance, batches)│
└──────────────────────────────────────────────────────────┘
       ▲
       │ REST + WebSocket progress
┌──────┴──────┐
│ React client │  PlanningCenterIntegrationPanel, Onboarding, PeoplePage
└─────────────┘
```

**People flow PCO → LMPG only.** LMPG never writes back to PCO.

Core design docs:

- `docs/superpowers/specs/2026-05-21-planning-center-people-sync-design.md`
- `docs/superpowers/specs/2026-05-25-pco-source-of-truth-mode-design.md`
- `docs/superpowers/specs/2026-07-03-pco-sync-batches-design.md`
- `docs/superpowers/specs/2026-06-03-pco-checkins-attendance-import-design.md`

---

## The Three Parallel Workflows (Not One "Sync")

Most confusion comes from treating PCO as a single sync. It is actually **three
independent workflows**:

### 1. People sync (batch-based, repeatable)

Admin defines one or more **sync batches** in Settings → Integrations → Planning
Center. Each batch has:

- Membership allowlist and/or custom field filters
- Default `people_type` for new adds
- Optional gathering roster assignment
- Optional schedule (daily/weekly/monthly) or manual-only

Each batch runs a **plan → review → apply** pipeline (`server/services/planningCenter/diffEngine.js`,
`server/services/planningCenter/apply.js`):

- **Auto-applied:** link, restore, update, archive (PCO inactive), reactivate
- **Review required:** ambiguous matches, visitor promotion, selective adds, family name updates
- **`gatheringEligible`:** already-linked people who match the batch filter get added to the
  batch's gathering on every run (see `2026-07-06-pco-gathering-sync-for-linked-people-design.md`)

Key files:

- `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`
- `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`
- `server/services/planningCenterSync.js`

### 2. Reconciliation ("Check for people who left")

**Separate** from any batch — scans the **full unfiltered PCO export**.

- Finds LMPG actives with no PCO name match (`archiveExtras`)
- Lists unmatched visitors (informational only — visitors are LMPG-owned)
- Supports manual PCO search + link instead of archive
- Can be scheduled; **scheduled runs auto-archive all extras with no review**
  (`server/services/planningCenterSync.js`, `runReconciliationSync`)

Key files:

- `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx`
- `server/services/planningCenter/peopleSearch.js`

### 3. Check-in historical import (one-time migration)

- Maps PCO Check-in **events** → LMPG gatherings
- Writes **present-only** attendance records
- `ON CONFLICT DO NOTHING` — existing LMPG attendance always wins
- Auto-creates unmatched people as **inactive** regulars (not on active rolls)
- Explicitly **not** ongoing live check-in sync

Key files:

- `client/src/components/PCOCheckinImport.tsx`
- `server/services/planningCenter/checkinsImport.js`

---

## Source-of-Truth Mode: The Critical Gate

The design's central idea: once PCO owns your regulars, LMPG must stop letting users
silently diverge.

**Mode is active when `church_settings.planning_center_sync_indicator = 1`**
(`server/services/planningCenter/mode.js`):

- Linked people: first name, last name, and age group (`is_child`) are locked
- Merge, delete, manual archive/restore blocked for linked people
- New regulars blocked (visitors still allowed)
- FAB "Add People" hidden; CSV people import blocked
- Lifecycle (archive/reactivate) driven by sync, not manual edits
- People type, family assignment, badges, and gathering associations remain editable

**This is separate from `planning_center_sync_enabled`** — the master switch that
gates scheduled batch runs and reconciliation cron.

### Two toggles, one poorly labeled

| Setting | DB column | What it actually does | UI label today |
|---------|-----------|----------------------|----------------|
| Source-of-truth lock + badge | `planning_center_sync_indicator` | Enables ALL lockdown behavior | **"Show sync indicator"** — sounds cosmetic (label as of 2026-07-08; superseded, see note below) |
| Scheduled sync | `planning_center_sync_enabled` | Enables cron for batches + reconciliation | **"Enable Planning Center sync"** |

A church could previously easily:

1. Connect PCO and run batches (master sync on)
2. Never turn on "Show sync indicator"
3. Continue hand-editing linked people's names, adding regulars, merging — **defeating the
   entire source-of-truth model**

Onboarding **intentionally does not** enable source-of-truth mode
(`2026-06-04-pco-onboarding-import-design.md`: "remains a later toggle in Settings").
Post-onboarding churches were **not** in PCO mode until an admin flipped that toggle, and
nothing in the UI explained this.

**`[fixed 2026-07-09]`** The toggle is now labeled "PCO is source of truth for members,"
with copy that discloses the lockdown behavior, and enabling it requires confirming a
dialog that lists the consequences. See item 1 in Implementation Gaps below.

### `[fixed 2026-07-09]` Naming collision (developer + behavior hazard)

Was: `server/routes/families.js` returned `planningCenterSyncEnabled` but read
`planning_center_sync_indicator` (the lock flag), **not** `planning_center_sync_enabled`
(the cron flag). `client/src/pages/PeoplePage.tsx` used this for locks and badges. The
Settings API used the same name for the cron flag. Two different concepts shared one label.

Now: `families.js` returns `planningCenterSyncIndicator`, matching the name `settings.js`
already used for the same `planning_center_sync_indicator` column. Renamed the propagated
identifier end-to-end on the client to match: `pcoLock.ts` (`isPcoLocked`/`countPcoLocked`
params), `PeoplePage.tsx` (state + all call sites), and `PersonCard.tsx` (prop). No behavior
change — `planningCenterSyncEnabled` in `settings.js`/`PlanningCenterIntegrationPanel.tsx`
(the cron flag) was untouched and remains correctly named.

---

## What the Design Says You Should NOT Expect

These are intentional out-of-scope items — not missing features:

- **No LMPG → PCO writes** (attendance, people, anything)
- **No ongoing check-in sync** — only historical import
- **No PCO Services API** — gatherings come from Check-in events or manual setup, not PCO
  service plans
- **No ongoing family/household restructuring** — PCO households ≠ LMPG families; only
  initial link + optional family name rename from head-of-household
- **No email/phone/birthdate sync** — LMPG stores names only; matching is name + family
  context + child flag
- **Check-ins are not an attendance signal for people sync** — sample data showed only 16%
  of Church Members had a check-in over 6 weeks; membership categories are the real filter
- **Membership demotion while PCO-active is a no-op** — only `status=inactive` triggers
  archive

---

## Implementation Gaps vs. Design Intent

### High impact (behavioral / UX)

1. **`[fixed 2026-07-09]` Source-of-truth toggle is mislabeled and disconnected from onboarding**
   - Was: users thought they were "fully on PCO" after onboarding + first batch, but locks
     weren't active until they found and enabled a toggle labeled "Show sync indicator"
   - Now: relabeled to "PCO is source of truth for members" with copy that discloses the
     lock, and enabling it asks for confirmation first

2. **`[cross-review]` `[fixed 2026-07-09]` OAuth token refresh is implemented independently three times**
   - Was: `refreshToken()` in `server/services/planningCenterSync.js`,
     `refreshPlanningCenterToken()`, and a separate proactive single-flight guard
     `ensureValidPlanningCenterTokens()` in `server/routes/integrations.js` — three
     independent implementations each persisting rotated tokens to the same
     `user_preferences` row, risking a race that silently breaks the PCO connection
   - Now: consolidated into a single implementation in `planningCenterSync.js`
     (`ensureValidPlanningCenterTokens`, with one in-flight guard), reused by both the
     route handlers and the cron/service layer

3. **`[fixed 2026-07-09]` Marketing copy overpromises check-in sync**
   - Was: `PlanningCenterIntegrationPanel.tsx:294` said *"Sync check-in data for attendance
     tracking"* — implied ongoing sync; reality is one-time historical import
   - Now: reworded to "Import historical check-in data as a one-time attendance backfill"

4. **`[fixed 2026-07-09]` Onboarding skips sync review**
   - Was: `applyPlanningCenterBatch(batch.id, {})` immediately after first batch save
     (`OnboardingPage.tsx`), silently skipping ambiguous matches, visitor promotions,
     and selective adds
   - Now: onboarding has a `pco-review` step showing the same `PlanningCenterSyncReview`
     screen Settings uses, with a "Continue" button that doesn't require applying first —
     see `docs/superpowers/specs/2026-07-09-pco-batch-review-notifications-design.md`

5. **`[fixed 2026-07-09]` "Run now" bypasses review**
   - Was: applied with empty selections; ambiguous items stayed unlinked until someone
     opened "Review & sync" anyway
   - Now: the "Run now" button is removed — batches only run manually through
     "Review & sync"

6. **`[mitigated 2026-07-09]` Scheduled reconciliation auto-archives without human review**
   - Was/still: auto-archives on schedule — explicitly kept as-is (archiving is reversible
     via reactivate, and holding it for approval would make an unattended nightly job do
     nothing most nights)
   - Now: no longer silent — admins/coordinators get an in-app notification summarizing
     what a scheduled run left for review (ambiguous matches, visitor-match suggestions,
     pending family name updates) and how many people reconciliation archived — see
     `docs/superpowers/specs/2026-07-09-pco-batch-review-notifications-design.md`

### Medium impact (polish / dead code)

7. **`planning_center_auto_archive`** — legacy column still in settings API/schema;
   superseded by batch sync + reconciliation; no UI

8. **`[fixed 2026-07-09]` Historical CSV import endpoints**
   - Was: `previewHistoricalCsv`/`importHistoricalCsv` existed in `client/src/services/api.ts`
     with no UI caller (PCO check-in import replaced the primary path)
   - Now: removed, along with the server-side `POST /historical-csv-preview` /
     `POST /historical-csv-execute` routes and their exclusive helpers (`csvUpload`
     multer config, `parseHistoricalCsv`, `matchAndBuildRecords`, `parseDateHeader`),
     and the now-unused `fs`/`multer`/`csv-parser` imports in `integrations.js`

9. **`[fixed 2026-07-09]` Legacy browse/import routes**
   - Was: `GET /planning-center/people`, `POST /import-people`, `POST /link-family`,
     and the dead `GET /planning-center/checkins` browse endpoint (see item 11) still
     on the server with no client caller; UI moved to batches
   - Now: all four removed from `server/routes/integrations.js`, along with the
     now-unused `getPlanningCenterTokens` per-user token alias (its only callers were
     these routes)

10. **Monthly schedule has no day-of-month picker** — `schedule_day` only shown for weekly;
    monthly always runs on the 1st (confirmed: `isDueToday()` in `planningCenterSync.js:312`
    hardcodes `now.getDate() === 1`)

11. **`[fixed 2026-07-09]` OAuth disconnect is per-user**
    - Was: tokens stored in `user_preferences`; disconnect removed only the connecting
      user's tokens; status, check-in browse/events/availability, and check-in import
      were all scoped to the viewing admin instead of the church, so only the original
      connecting admin could see "Connected" or run check-in import
    - Now: `/status`, `/checkins/events`, `/checkins/availability`, `/disconnect`, and
      check-in import all resolve tokens church-wide via `getChurchPlanningCenterTokens`
      / a church-scoped `DELETE`, matching how the batch/cron sync paths already worked.
      (The bare `GET /planning-center/checkins` browse endpoint used per-admin token
      lookup and had no client caller — removed as part of item 9's cleanup.)

12. **`[cross-review]` `[partially fixed 2026-07-09]` Two independent, unmerged PCO caching layers**
    - An in-memory `pcoPeopleCache` (10-minute TTL) inside `planningCenterSync.js`
      holds the full projected PCO people list, shared by plan computation, membership
      summary, and people-search
    - A separately persisted cache (`planning_center_membership_cache` /
      `_field_definitions_cache` in `church_settings`, 1-hour staleness) in
      `metadataCache.js` serves the batch editor's filter picker, with its own
      background-refresh/polling (`usePcoRefreshPoll`)
    - These two layers genuinely serve different needs (short-lived raw list for sync
      computation vs. long-lived persisted aggregate for UI display that must survive
      restarts) and were left as two layers on purpose — merging them into one would
      either drop cross-restart persistence or add DB/JSON overhead to the hot sync
      path. Not attempted.
    - What *was* fixed: `membership-summary` and `field-definitions` each reimplemented
      an identical "cold cache blocks on a live fetch, stale cache returns immediately
      and refreshes in the background" policy inline; `field-summary` skipped the
      persisted cache entirely and called `fetchFieldDefinitions(accessToken)` — a live
      PCO request — on every single call, even though `field-definitions` had usually
      already warmed that exact cache. Consolidated all three into one shared
      `metadataCache.readCacheFirst`/`readMembershipSummary`/`readFieldDefinitionsSummary`,
      so there's now one cache-read policy instead of three divergent ones, and
      `field-summary` no longer re-fetches field definitions from PCO on every request.
      Response shapes are unchanged (no client changes needed); the still-open,
      lower-priority piece is the synchronous full-fetch-on-cold-cache path itself
      (unchanged — cold-start only, mitigated by the existing connect-time warm-up).

13. **PCO feature flag** — integration hidden when `PLANNING_CENTER_ENABLED` is false; no
    in-app explanation

### Low impact (already implemented correctly)

- `gatheringEligible` bucket and `gatheringAssigned` count — implemented per July 2026 spec
- Manual PCO search + `archiveAmbiguousIds` + reconciliation `manualLinks` — implemented
- `idx_individuals_pco_id_unique` partial unique index — in `server/config/schema.js`
- Family name updates skipped on unattended cron — correct per design
- Check-in import `DO NOTHING` conflict handling — correct

---

## Recommended Operator Workflow

For a church migrating from PCO to LMPG:

1. **Connect** PCO (OAuth — `people` + `check_ins` scopes)
2. **Create batches** — e.g. "Members" (Church Members + Regular Attenders), "Youth"
   (custom field), each with appropriate gathering assignment
3. **Review & sync** each batch — resolve ambiguous matches, visitor promotions, family
   name updates
4. **Enable source-of-truth mode** — flip `planning_center_sync_indicator` (labeled "PCO
   is source of truth for members")
5. **Enable master sync** — for scheduled batch runs
6. **Run reconciliation manually first** — before scheduling auto-archive
7. **Import check-in history** (optional, one-time) — map events to gatherings; understand
   LMPG owns attendance going forward
8. **Track attendance in LMPG** — no further PCO check-in pulls

---

## Summary

**Architecturally, the backend engine is largely complete and matches the design docs.**
Sync batches, reconciliation split, gathering eligibility, manual linkage, and check-in
import all landed as specified.

**What is missing is mostly clarity and guardrails at the product layer:**

| Missing piece | Severity |
|---------------|----------|
| Source-of-truth mode not tied to "being on PCO" (mislabeled toggle, not enabled in onboarding) | **Fixed 2026-07-09** — toggle relabeled + confirmation dialog added |
| Token refresh implemented independently in 3 places against the same DB row `[cross-review]` | **Fixed 2026-07-09** — consolidated to one implementation |
| Users told check-ins "sync" when it's historical import only | **Fixed 2026-07-09** — copy reworded to say one-time backfill |
| Onboarding / Run now skip review for ambiguous matches | **Fixed 2026-07-09** — Run now removed, onboarding shows a review step |
| Scheduled reconciliation auto-archives without review | **Mitigated 2026-07-09** — still auto-archives by design, now notifies admins |
| Two different flags named `planningCenterSyncEnabled` in different APIs | **Fixed 2026-07-09** — `families.js` renamed to `planningCenterSyncIndicator`, matching `settings.js` |
| Dead legacy routes/endpoints (`/planning-center/people`, `/import-people`, `/link-family`, dead `/planning-center/checkins` browse, historical CSV import) | **Fixed 2026-07-09** — removed from server and client, including exclusive helpers and now-unused imports |
| Two unrelated, unmerged PCO caching layers `[cross-review]` | **Partially fixed 2026-07-09** — three divergent cache-read policies consolidated into one; the two layers themselves are kept (deliberately, not an oversight) |
| No ongoing attendance bridge from PCO | **By design** — but churches may expect it |

**`[fixed 2026-07-09]`** All of the previously highest/medium-impact items are done: the
source-of-truth toggle is relabeled with a confirmation dialog (item 1), the three
independent token-refresh implementations are consolidated into one (item 2), the check-in
"sync" marketing copy no longer implies ongoing sync (item 3), the `families.js` /
`settings.js` naming collision is resolved, and the dead legacy routes/endpoints (items 8, 9)
are removed.

**`[partially fixed 2026-07-09]`** Item 12's three divergent cache-read code paths
(`membership-summary`, `field-definitions`, and `field-summary` — the last of which
skipped caching for field definitions entirely) are now one shared policy in
`metadataCache.js`, and `field-summary` no longer re-fetches field definitions from PCO
on every call. The two caching *layers* themselves (in-memory people list vs. persisted
aggregate) were kept as-is — they serve genuinely different needs, and merging them
would trade one problem for a worse one.

**Next-highest-impact fix:** none of the remaining items are behavioral bugs — `planning_center_auto_archive`
(item 7, unused column) and the monthly day-of-month picker (item 10, actual feature
work, not a fix) and the PCO feature-flag explanation (item 13) are the only open items,
all Medium/Low and none urgent.

---

## Key File Reference

### Server

| Path | Role |
|------|------|
| `server/routes/integrations.js` | All PCO HTTP endpoints |
| `server/services/planningCenterSync.js` | Fetch, cache, plan, apply, cron scheduler |
| `server/services/planningCenter/diffEngine.js` | Plan computation |
| `server/services/planningCenter/apply.js` | DB writes for plan + reconciliation |
| `server/services/planningCenter/checkinsImport.js` | Check-in normalization & record building |
| `server/services/planningCenter/mode.js` | Source-of-truth mode helpers |
| `server/routes/settings.js` | Integration toggles |
| `server/routes/individuals.js` | PCO mode guards |
| `server/routes/families.js` | PCO mode guards; exposes lock flag to People page |

### Client

| Path | Role |
|------|------|
| `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx` | Main PCO settings UI |
| `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx` | Batch CRUD form |
| `client/src/components/planningCenter/PlanningCenterSyncReview.tsx` | Batch sync plan review/apply |
| `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx` | Departure reconciliation |
| `client/src/components/PCOCheckinImport.tsx` | Attendance history import wizard |
| `client/src/pages/OnboardingPage.tsx` | PCO onboarding path |
| `client/src/pages/PeoplePage.tsx` | PCO badge + lock behavior |
| `client/src/utils/pcoLock.ts` | `isPcoLocked`, `PCO_MODE_LOCKED` |