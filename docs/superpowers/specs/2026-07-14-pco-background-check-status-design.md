# PCO Background Check Status ("Green Shield") — Design

## Purpose

Planning Center tracks whether a person has a current, cleared background
check, and shows this as a green shield indicator in its own Check-Ins UI.
Churches use this to gate who's approved to serve with children.

We want to surface the same signal inside Let My People Grow, specifically
so that whoever is taking attendance at a children's/youth gathering can see,
in the moment, whether an adult being checked in currently lacks a cleared
background check — without anyone having to cross-reference Planning Center
by hand.

This is an optional, opt-in feature. Churches that don't use PCO's
background check tooling, or don't want this surfaced, leave it off.

## Confirmed PCO API facts

Verified directly against Planning Center's live API reference
(`api.planningcenteronline.com/docs/apps/people`):

- The `Person` resource (returned by the existing
  `GET /people/v2/people` sync call) includes a plain boolean attribute,
  `passed_background_check`. It requires no extra `include` and no extra
  API call — it's already present in every person payload our sync fetches.
- This reflects **current** status (confirmed by the requesting user against
  a live PCO account), not just "ever passed." A separate, richer
  `BackgroundCheck` resource also exists
  (`GET /people/v2/people/{id}/background_checks`, with `status`,
  `current`, `expires_on`, etc.) but is **not needed** for this feature —
  the simple boolean is sufficient and accurate.
- PCO's own help docs confirm the "green shield" in Check-Ins UI means
  exactly this: a cleared, non-expired background check, and that visibility
  of background-check details in PCO itself is restricted to users with
  background-check access in People.

## Settings

Two independent toggles gate everything; both must be on for any UI to
appear.

1. **Church-level, PCO integration tab**: "Track background check status."
   New column `church_settings.planning_center_track_background_checks`
   (`INTEGER DEFAULT 0`). Off by default. Same toggle pattern as the
   existing "Show sync indicator" switch in
   `PlanningCenterIntegrationPanel.tsx`.
2. **Per-gathering-type**: "Requires background check." New column
   `gathering_types.requires_background_check` (`INTEGER DEFAULT 0`). Set
   on the gathering type edit form, alongside `kiosk_enabled` /
   `leader_checkin_enabled`. Only offered for `attendance_type: 'standard'`
   gatherings (headcount mode doesn't track individuals).

A gathering with `requires_background_check` set is meaningless if the
church toggle is off — the church toggle controls whether we even sync/show
the data at all.

## Data model

New column on `individuals`:

```sql
pco_background_check_cleared INTEGER DEFAULT NULL
```

Tri-state, matching what we actually know:

- `NULL` — never synced from PCO (no `planning_center_id`, or church has
  never had tracking enabled during a sync)
- `0` — synced, `passed_background_check` was `false`
- `1` — synced, `passed_background_check` was `true`

"Adult" reuses the existing `individuals.is_child` flag. No new age/date
logic — children never show the indicator regardless of this field.

## Sync behavior

- `passed_background_check` is written to `pco_background_check_cleared`
  on every regular PCO person sync (`planningCenterSync.js` →
  `projection.js` → `apply.js`), unconditionally — it's free data already in
  the payload, so there's no reason to gate the write behind the church
  toggle. Gating happens at display time, not sync time.
- Freshness is bounded by the church's existing sync schedule
  (`planning_center_sync_frequency`: daily/weekly). A background check that
  expires mid-cycle won't flip from cleared to not-cleared until the next
  sync. The PCO integration tab should show a "data as of [last sync]" note
  near the toggle so admins understand this isn't real-time.
- No new API calls, no new PCO scopes, no separate `BackgroundCheck`
  resource fetch, no history/expiry-date storage.

## UI surfacing

One shared visual: `ShieldCheckIcon` (solid, green, `#16a34a`) when cleared;
`ShieldExclamationIcon` (outline, amber, `#d97706`) when not cleared or
never synced. Amber rather than red because a `false`/`NULL` value could
mean several different underlying PCO states (no check on file, expired,
pending, etc.) and we don't want to assert a hard failure we can't
distinguish from "unknown."

This is a **new, dedicated, read-only indicator** — intentionally separate
from the existing per-person custom badge system
(`individuals.badge_text/badge_color/badge_icon`, edited via
`BadgeEditor.tsx`). That system is a single free-text/color/icon slot an
admin sets manually for arbitrary purposes (allergies, notes, etc.); this
indicator is derived, PCO-sourced, and not user-editable, so it needs its
own visual slot rather than competing for the one existing badge slot.

Never shown for children (`is_child = 1`), regardless of context.

### Where it appears

| Surface | Condition to show | Who sees it |
|---|---|---|
| People page (`PersonCard.tsx` / `PeoplePage.tsx`) | Church toggle on, person is an adult | Admin/coordinator roles only |
| Standard attendance-taking (`AttendancePage.tsx`) | Church toggle on, **and** that gathering has `requires_background_check` | Whoever is taking attendance there (including `attendance_taker` role) |
| Leader check-in mode (`LeaderCheckInMode.tsx`) | Same as above | Same as above |
| Self check-in kiosk (`SelfCheckInMode.tsx`) | Out of scope for now | — |

Per your confirmation: **a gathering's `requires_background_check` flag is
the only thing that makes the indicator appear in attendance/check-in at
all.** An unflagged gathering shows nothing extra for anyone, including
admins — the People page is the only place status is visible outside of a
flagged gathering's check-in screen.

The split between "admin/coordinator only" (People page) and "whoever's
checking people in" (flagged-gathering attendance screens) is deliberate:
the person actually running check-in needs to see the warning live to act
on it, but general background-check status isn't otherwise browsable by
every attendance taker.

## Explicitly out of scope

- Self check-in kiosk mode — already disabled by default pending the
  roster-privacy redesign described in
  `docs/superpowers/specs/2026-07-13-kiosk-mode-env-gate-design.md`. This
  feature is ready to extend there once that redesign lands, but isn't part
  of this build.
- Any "volunteer" designation distinct from "adult." Any adult marked
  present at a flagged gathering gets evaluated — no separate role/tag
  needed.
- Full `BackgroundCheck` resource sync (status detail, expiry date, report
  URL, history). The boolean is sufficient per the confirmed API behavior.
- Per-batch scoping. This is a single church-wide toggle, not part of the
  `planning_center_sync_batches` system.
- Reports/analytics surfaces. Only People and the two check-in screens
  listed above.

## Known limitations

- Sync-cycle staleness (see above) — mitigated with a visible "as of"
  timestamp, not solved outright.
- Relies on PCO's `passed_background_check` boolean's semantics remaining
  stable; if PCO ever changes what this attribute means, our indicator
  would silently follow. No independent verification against the fuller
  `BackgroundCheck` resource is planned, per the decision above.
