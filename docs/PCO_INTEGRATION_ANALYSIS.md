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
| Source-of-truth lock + badge | `planning_center_sync_indicator` | Enables ALL lockdown behavior | **"Show sync indicator"** — sounds cosmetic |
| Scheduled sync | `planning_center_sync_enabled` | Enables cron for batches + reconciliation | **"Enable Planning Center sync"** |

A church can easily:

1. Connect PCO and run batches (master sync on)
2. Never turn on "Show sync indicator"
3. Continue hand-editing linked people's names, adding regulars, merging — **defeating the
   entire source-of-truth model**

Onboarding **intentionally does not** enable source-of-truth mode
(`2026-06-04-pco-onboarding-import-design.md`: "remains a later toggle in Settings").
Post-onboarding churches are **not** in PCO mode until an admin flips that toggle — but
nothing in the UI explains this.

### Naming collision (developer + behavior hazard)

`server/routes/families.js` returns `planningCenterSyncEnabled` but reads
`planning_center_sync_indicator` (the lock flag), **not** `planning_center_sync_enabled`
(the cron flag). `client/src/pages/PeoplePage.tsx` uses this for locks and badges. The
Settings API uses the same name for the cron flag. Two different concepts share one label.

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

1. **Source-of-truth toggle is mislabeled and disconnected from onboarding**
   - Users think they're "fully on PCO" after onboarding + first batch, but locks aren't
     active until they find and enable a toggle labeled "Show sync indicator"
   - Consider renaming to "PCO is source of truth for members" and/or auto-enabling when
     master sync is turned on (with a confirmation dialog explaining lockdown)

2. **`[cross-review]` OAuth token refresh is implemented independently three times**
   - `refreshToken()` in `server/services/planningCenterSync.js:125`,
     `refreshPlanningCenterToken()` in `server/routes/integrations.js:1663`, and a
     separate proactive single-flight guard `ensureValidPlanningCenterTokens()` in
     `server/routes/integrations.js:1696` (used only by the check-in fetch path to avoid
     a rotation race across concurrent paginated requests)
   - All three independently persist rotated tokens to the same
     `user_preferences` row (`preference_key = 'planning_center_tokens'`). PCO rotates
     the refresh token on every use, so a race between two of these paths (e.g. a
     scheduled batch sync and a concurrent check-in import) can overwrite a freshly
     rotated token with a now-invalid one, silently breaking the PCO connection until
     someone reconnects
   - Consolidate to a single refresh path/lock, reused by both the route handlers and
     the cron/service layer

3. **Marketing copy overpromises check-in sync**
   - `PlanningCenterIntegrationPanel.tsx:294` says *"Sync check-in data for attendance
     tracking"* — implies ongoing sync; reality is one-time historical import

4. **Onboarding skips sync review**
   - Design: batch editor + review flow
   - Implementation: `applyPlanningCenterBatch(batch.id, {})` immediately after first
     batch save (`OnboardingPage.tsx`)
   - Ambiguous matches, visitor promotions, and selective adds are silently skipped on
     first import

5. **"Run now" bypasses review**
   - Same as onboarding — applies with empty selections; ambiguous items stay unlinked
     until someone opens "Review & sync"
   - Not wrong per cron design, but easy to miss that `ambiguous > 0` means incomplete
     linking

6. **Scheduled reconciliation auto-archives without human review**
   - Confirmed in code: `runReconciliationSync()` (`planningCenterSync.js:352`) calls
     `applyReconciliation(churchId, plan, {})` with empty options — no selections, no
     review
   - By design, but consequential — active regulars with no PCO name match get archived
     silently at 2 AM
   - Manual reconciliation has search-and-link; scheduled path does not

### Medium impact (polish / dead code)

7. **`planning_center_auto_archive`** — legacy column still in settings API/schema;
   superseded by batch sync + reconciliation; no UI

8. **Historical CSV import endpoints** — exist in `client/src/services/api.ts` but no
   UI (PCO check-in import replaced the primary path)

9. **Legacy browse/import routes** — `GET /planning-center/people`,
   `POST /import-people`, `POST /link-family` still on server; UI moved to batches

10. **Monthly schedule has no day-of-month picker** — `schedule_day` only shown for weekly;
    monthly always runs on the 1st (confirmed: `isDueToday()` in `planningCenterSync.js:312`
    hardcodes `now.getDate() === 1`)

11. **OAuth disconnect is per-user** — tokens stored in `user_preferences`; disconnect
    removes only the connecting user's tokens; cron uses `LIMIT 1` any user with tokens

12. **`[cross-review]` Two independent, unmerged PCO caching layers**
    - An in-memory `pcoPeopleCache` (10-minute TTL) inside `planningCenterSync.js`
      holds the full projected PCO people list, shared by plan computation, membership
      summary, and people-search
    - A separately persisted cache (`planning_center_membership_cache` /
      `_field_definitions_cache` in `church_settings`, 1-hour staleness) in
      `metadataCache.js` serves the batch editor's filter picker, with its own
      background-refresh/polling (`usePcoRefreshPoll`)
    - They're related (the persisted cache's refresh internally calls into the
      in-memory cache's fetch function) but not unified — a cold persisted cache still
      pays for a full paginated PCO fetch synchronously on first read. Not incorrect,
      just an avoidable extra layer of state to reason about

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
3. **Review & sync** each batch (not just "Run now") — resolve ambiguous matches,
   visitor promotions, family name updates
4. **Enable source-of-truth mode** — flip `planning_center_sync_indicator (currently
   "Show sync indicator")
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
| Source-of-truth mode not tied to "being on PCO" (mislabeled toggle, not enabled in onboarding) | **Critical** — defeats the core value prop |
| Token refresh implemented independently in 3 places against the same DB row `[cross-review]` | **High** — can silently break the PCO connection (PCO rotates the refresh token on every use) |
| Users told check-ins "sync" when it's historical import only | **High** — wrong expectations |
| Onboarding / Run now skip review for ambiguous matches | **High** — incomplete initial linking |
| Scheduled reconciliation auto-archives without review | **Medium** — can surprise admins |
| Two different flags named `planningCenterSyncEnabled` in different APIs | **Medium** — maintenance hazard |
| Two unrelated, unmerged PCO caching layers `[cross-review]` | **Low** — works, but an avoidable extra layer of state |
| No ongoing attendance bridge from PCO | **By design** — but churches may expect it |

**Highest-impact fix:** relabel and/or couple the source-of-truth toggle with the master
sync switch, and add a post-onboarding prompt explaining that PCO lockdown is a separate
step.

**Highest-impact reliability fix (separate axis — silent failure, not UX):** consolidate
the three independent token-refresh implementations into one, so a rotation race can't
silently break the PCO connection.

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