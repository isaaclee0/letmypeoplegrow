# Planning Center → LMPG People Sync — Design

**Date:** 2026-05-21
**Status:** Approved (design); pending implementation plan

## Problem & Goal

Churches want **Planning Center (PCO) as the single source of truth for people**, and **LMPG for attendance**. Today LMPG's PCO integration only auto-archives already-linked people on PCO `status=inactive`, and the bulk importer pulls in *everyone* (archived, deceased, staff/fake accounts, and — critically — hundreds of "Community Contact" records that aren't attenders).

The target church has already loaded the members they want via CSV upload. So the need is **not** a fresh bulk import; it is:

1. A **one-time linking** step that pairs existing (CSV-imported) LMPG individuals to their PCO person records.
2. An **ongoing full sync** keeping LMPG aligned to PCO: add new eligible people, update names/child-flag, archive on inactive, reactivate on return to active — while archived people remain visible in historical attendance.

### Data findings that shaped this design

From sampling the live PCO dataset (1383 people; see `server/scripts/sample-pco-people.js`):

- **`status` (active/inactive)** is reliable but only flags 116 (8.4%) — the dead/archived set.
- **`membership`** is the church's real categorization (e.g. `Church Members`, `Regular Attenders`, `New People`, `Visitors`, `Community Contact`, `Admin Staff`, `Deceased`). It is **free-text and church-specific**, so it cannot be hardcoded.
- **Check-ins are NOT a usable attendance signal** — only 16% of Church Members had a check-in over 6 weeks because attendance tracking has moved to LMPG. Absence of a check-in does not mean absence of attendance. (Check-in counts are still surfaced in the config UI as a *helper*, never a gate.)
- **LMPG `individuals` stores only names** (`first_name`, `last_name`, `is_child`, `family_id`) — no email, phone, or birthdate. So linking can only use **name + family/household context + child flag**.
- **PCO households ≠ LMPG families**: PCO households are many-to-many and 27% of people have none; LMPG families are one-to-one and always present. Therefore family/household structure is **not** synced on an ongoing basis.

## Locked Decisions

| Area | Decision |
|---|---|
| Eligibility | Configurable **membership allow-list** per church; gates **additions only** |
| Archive | Only on PCO `status=inactive` |
| Reactivate | PCO `status=active` **and** in allow-list → `is_active=1` |
| Membership demotion (still active) | **No-op** in LMPG |
| Field updates | Overwrite `first_name`/`last_name`/`is_child` every sync; **family left alone** after initial link; `badge_*`/`people_type` are LMPG-only and untouched |
| Unmatched LMPG people | Stay active, flagged unlinked (`planning_center_id IS NULL`) |
| Trigger | Daily cron + manual "Sync now" button |
| Initial link | Auto-match confident matches; **review screen** for ambiguous/new/unmatched |
| Architecture | Single **reconcile pipeline** shared by initial link and ongoing sync |

## Architecture

One diff engine, two modes:

```
fetch PCO people (one paginated sweep, includes status+membership+household+child)
        │
        ▼
match unlinked LMPG individuals ↔ PCO people   (name + family + child)
        │
        ▼
compute plan: { link, ambiguous, unmatched, add, update, archive, reactivate }
        │
        ├── initial link / "Sync now": render plan in review screen → user confirms → apply
        └── nightly cron: auto-apply all buckets except `ambiguous` (parked for review)
```

- **Initial link** and **ongoing sync** are two views of the same `computePlan()` output. The review screen is a preview of the diff.
- Re-running is idempotent; the plan is recomputed from current state each time. Ambiguous items the cron can't resolve stay `planning_center_id IS NULL` and reappear in the review screen.

## Data Model & Config

**Reused as-is:**
- `individuals.planning_center_id` — link key; `NULL` = unlinked
- `families.planning_center_id` — PCO household id
- `church_settings.planning_center_last_sync`, `planning_center_sync_indicator`

**New columns on `church_settings`** (add to `server/config/schema.js` + migration for existing church DBs):
- `planning_center_sync_enabled INTEGER DEFAULT 0` — master on/off for full sync (supersedes the narrow `planning_center_auto_archive`, which is migrated forward)
- `planning_center_membership_allowlist TEXT` — JSON array of allowed membership strings, e.g. `["Church Members","Regular Attenders","New People","Visitors"]`
- `planning_center_last_sync_result TEXT` — JSON: `{at, added, updated, archived, reactivated, ambiguous, unmatched, errors}`

**No new tables.** Review lists are recomputed on demand.

## Matching Algorithm

Normalize names (lowercase, trim, strip punctuation, collapse whitespace). For each **unlinked** LMPG individual, find PCO candidates by normalized first+last name, then assign a confidence tier:

1. **Exact-unique → auto-link.** Exactly one unlinked PCO person matches the name. Child flag breaks adult/child name clashes.
2. **Family-corroborated → auto-link.** Multiple same-name PCO people, but one is in a PCO household whose other members also match this individual's LMPG family.
3. **Ambiguous → review.** Multiple candidates, no disambiguation → park; review screen lists candidates to pick from.
4. **No candidate → unmatched.** Stays unlinked/flagged.

**Guards:** each PCO person links to at most one LMPG individual and vice-versa (track used ids). A PCO person who matches an existing unlinked LMPG person becomes a `link`, never a duplicate `add`.

*Out of scope (future):* nickname/alias matching (e.g. Bob↔Robert).

## Diff Engine — Plan Buckets

Inputs: all PCO people (with status/membership/household/child) and all LMPG individuals + families.

- **link** — high-confidence matches (tiers 1–2)
- **ambiguous** — tier 3, needs human pick
- **unmatched** — tier 4, left unlinked
- **add** — PCO person in **allow-list**, `active`, no LMPG match → create new individual
- **update** — linked pair where PCO name/child-flag differs → overwrite LMPG
- **archive** — linked, LMPG `is_active=1` but PCO `inactive` → `is_active=0`
- **reactivate** — linked, LMPG `is_active=0` but PCO `active` **and** in allow-list → `is_active=1`

**Rule distinctions:**
- `archive`/`update`/`reactivate` apply to **all linked people by PCO status**, regardless of allow-list (matches "demotion is a no-op").
- The **allow-list gates only `add`**.

**New-person family creation (`add`):** if the PCO household maps to an existing LMPG family (`families.planning_center_id`), join it; else create the family from the household (reuse the importer's name helper, `"Lastname, Firstname and Firstname"`); no household → 1-person family. Purely additive — does not violate "family left alone."

## API & Service

**Endpoints (extend `server/routes/integrations.js`):**
- `GET /planning-center/sync/plan` — dry-run; returns the diff plan for the review screen. Never writes.
- `POST /planning-center/sync/apply` — apply; accepts optional explicit selections (ambiguous picks, add opt-outs) from the review screen, or runs full-auto for "Sync now" (skips ambiguous).
- `GET|PUT /planning-center/membership-filter` — read/write `planning_center_membership_allowlist` + `planning_center_sync_enabled`.
- Existing connect/status/disconnect endpoints unchanged.

**Service (refactor `server/services/planningCenterSync.js`):**
- Export `computePlan(churchId, accessToken)` and `applyPlan(churchId, plan, selections)`.
- Cron (`runNow` / scheduled) and the endpoints all call these.

## UI (Integrations page)

1. **Allow-list config panel** — fetches live PCO membership values + counts (reusing browse logic), one checkbox per value with the 6-week check-in count beside it as a helper; master sync toggle.
2. **Review & link screen** — renders the dry-run plan: *Auto-link* (collapsed, default-checked), *Ambiguous* (per-person radio pick or skip), *New people to add* (grouped by family, default-checked, deselectable), *Unmatched* (informational), *Archive/Reactivate/Update* (shown when present). Confirm → apply.
3. **Ongoing sync** — "Sync now" button → reconcile, auto-apply non-ambiguous, show summary + last-sync time from `planning_center_last_sync_result`. If ambiguous > 0, a "N need review" link opens the review screen. Nightly cron behaves identically, silently.

## Historical Attendance Preservation

No new work required. Archiving sets `is_active=0` and never deletes `attendance_records`. Reports already include archived people via `(i.is_active = 1 OR ar.present = 1)` (`server/routes/reports.js:182`). Archived people remain visible in history and resume cleanly on reactivation.

## Error Handling & Robustness

- **Efficiency:** one paginated people sweep (status included) replaces the old per-person status calls (was N requests) — far fewer API calls, friendlier to PCO rate limits.
- Reuse existing token-refresh and church-isolation (`Database.setChurchContext`, `church_id` filters on every query).
- `applyPlan` captures per-item failures into `result.errors` without aborting the whole run.
- Dry-run (`/sync/plan`) never writes; apply is idempotent.

## Testing

- **Matcher unit tests:** tiers 1–4, name normalization, family corroboration, child tiebreak, double-link guard.
- **Diff-engine unit tests:** allow-list gates `add` only; archive-on-inactive; reactivate-requires-allow-list; demotion no-op; no duplicate `add` for a name-matched unlinked person.
- **Apply integration test:** create/update/archive/reactivate behave correctly and **attendance history is preserved** for archived people.
- Fixtures modeled on the real (anonymized) PCO sample shape.

## Out of Scope

- Nickname/alias matching.
- Ongoing family/household restructuring sync (set once at link; manual thereafter).
- Pushing LMPG → PCO (one-way only).
- Importing PCO contact fields (email/phone/birthdate) — LMPG intentionally stores only names.
