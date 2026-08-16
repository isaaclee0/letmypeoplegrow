# Opportunity-Based Engagement Reporting

**Date:** 2026-08-17

**Status:** Approved design

**Scope:** Add long-term engagement and pastoral-care workspaces to Reports, based on configurable attendance opportunities, with Primary-tier decline included in the existing weekly caregiver digest

## Summary

Reports will become a three-workspace page:

1. **Selected period** preserves the existing date-filtered dashboard.
2. **Long-term health** shows a fixed, rolling view of attendance consistency and movement.
3. **Pastoral care** turns significant changes into an actionable queue for admins and coordinators.

Person-level engagement is calculated from opportunities rather than raw monthly attendance counts. Each active regular receives independent **Primary** and **Community** profiles. A person who attends a small group consistently but attends a Sunday gathering every second month can therefore be `Primary: Irregular` and `Community: Core`; Community involvement never conceals weak Primary involvement.

The default tiers are Core at 60% or more of eligible opportunities, Casual at 20–59%, and Irregular below 20%. Churches can change the two boundaries and customise tier labels and colours. People with insufficient reliable history are `Establishing`, and active regulars without a current Primary assignment are `Not assigned`; neither group is folded into Irregular.

This specification is the first of two related deliverables. [Attendance Context](./2026-08-17-attendance-context-design.md) adds manual annotations, weather, public holidays, and Christian-calendar context after this reporting foundation exists.

## Goals

- Describe long-term engagement independently of the Selected period date filter.
- Distinguish corporate Primary attendance from Community or Ministry participation.
- Make tier definitions configurable while keeping calculations comparable and understandable.
- Base every person-level rate on opportunities for which that person was historically eligible.
- Surface useful pastoral signals without treating every Irregular person as a problem.
- Reuse the existing family caregiver assignments and weekly caregiver email.
- Create one caregiver-digest entry for each meaningful Primary-tier transition and recipient, with durable event deduplication, delivery state, and recovery handling.
- Keep all calculations and state explicitly church-scoped.
- Give users visible coverage and setup states rather than presenting unreliable classifications.

## Non-goals

- Forecasting future attendance.
- Claiming why an individual did or did not attend.
- Combining Primary and Community engagement into one weighted score.
- Person-level tiers for headcount gatherings.
- Classifying local or traveller visitors as Core, Casual, or Irregular.
- Arbitrary numbers of tiers or user-defined tier formulas in the first version.
- Replacing immediate attendance notification rules or the existing consecutive-absence workflow.
- Reconstructing historical roster membership from the current `gathering_lists` table.
- Automatically contacting people or recording pastoral conversations.
- Adding external weather or calendar data; that belongs to the attendance-context specification.

## Terminology

- **Church week:** Monday 00:00 through Sunday 23:59:59 in the church timezone.
- **Current window:** the latest 52 fully completed church weeks. The current partial week is excluded.
- **Comparison window:** the 52 completed weeks whose final Sunday is exactly four weeks before the current window's final Sunday. The two overlapping windows require one 56-completed-week source query.
- **Opportunity:** a reliable, held, individually tracked session for which a regular was on the roster at the time.
- **Primary:** a corporate gathering such as Sunday worship. Alternative Primary services in one church week represent one commitment.
- **Community:** a small group, youth group, ministry, or similar gathering. Separately assigned Community gatherings represent separate commitments.
- **Other:** a gathering retained in ordinary attendance reporting but omitted from engagement tiers.
- **Classified:** an active regular with at least eight eligible opportunities on the relevant axis.
- **Establishing:** an active regular with a current assignment but fewer than eight reliable opportunities on that axis.
- **Not assigned:** an active regular with no current assignment to an active, standard gathering on that axis.

Internal tier keys remain `core`, `casual`, and `irregular` even when a church changes their display labels. Logic, persisted events, and tests use the internal keys.

## Reporting Configuration

### Gathering roles

Each gathering may be assigned one engagement role:

- `primary`
- `community`
- `other`
- unclassified (`NULL`), which is the migration default

Only admins may change reporting roles. Existing gatherings remain unclassified until an admin reviews them; the system must not guess from names or days of the week. A headcount gathering's role affects only aggregate trend grouping. It remains visibly ineligible for person-level opportunities and tiers.

Inactive gatherings keep their role for historical interpretation. They do not satisfy a person's current assignment requirement, but reliable opportunities already recorded for them remain part of historical windows.

The settings UI lists all gatherings, explains each role, and previews how many active regulars would be Primary assigned, Community assigned, or Primary Not assigned. Threshold and role changes are saved atomically.

### Tier settings

The church has exactly three ordered tiers in version one. The default boundaries are:

- Core: rate `>= 60%`
- Casual: rate `>= 20%` and `< 60%`
- Irregular: rate `< 20%`

Admins may edit the Core minimum, Casual minimum, display labels, and colours. Validation requires integer percentages satisfying:

```text
0 <= casual minimum < core minimum <= 100
```

The UI shows a plain-language preview for weekly, fortnightly, and monthly gatherings, while making clear that the engine uses the exact opportunity percentage rather than rounded monthly counts. Colour is never the only way a tier is communicated.

Changing labels or colours does not change calculations. Changing a threshold or gathering role increments the church's calculation-rules version. Reports recalculate immediately under the new rules, but the next weekly decline evaluation establishes a fresh notification baseline so an administrative change cannot generate a mass pastoral alert.

## Session Reliability and Roster Provenance

### Why current rosters are insufficient

`gathering_lists` contains current membership and an `added_at` value, but removing someone deletes the row and re-adding them can reset the date. It cannot answer who was eligible for a past session. Historical tier denominators must therefore come from the roster captured for each attendance session, never from today's roster.

### Explicit session state

Attendance sessions gain a `session_status TEXT NOT NULL DEFAULT 'open'` column constrained to:

- `open`: created or viewed, but not yet demonstrated to have occurred;
- `held`: attendance or headcount was recorded, or an authorised user explicitly confirmed that the gathering occurred;
- `cancelled`: an authorised user confirmed that the gathering did not occur.

Existing sessions with roster snapshots, attendance activity, or any headcount record, including an explicitly recorded zero, are migrated to `held`; other legacy sessions remain `open`. Future sessions begin `open`. The first ordinary attendance mutation finalises a standard session as `held` and captures its roster through one shared server service. Every headcount save, including zero, finalises a headcount session as `held`. All live mutation paths, including WebSocket and check-in paths, use the shared finalisation service.

PCO-imported historical attendance remains valid for aggregate attendance trends but is present-only data and cannot safely supply person-level denominators. It therefore does not become a tier opportunity unless it has reliable roster provenance.

Admins and coordinators may cancel by gathering/date even when no session row exists; the server validates the church-owned gathering and upserts a `cancelled` session. Allowed transitions are `open -> held`, `open -> cancelled`, `held -> cancelled`, and `cancelled -> open`. A held-to-cancelled transition is rejected while the session contains a present attendance record, any submitted headcount record, or check-in action; those records must be corrected first. Cancelling sets `cancelled_at` and `cancelled_by`. Restoring clears both fields, preserves any existing roster snapshot, and returns the session to `open`; if no snapshot exists, the next attendance mutation captures one. Cancellation does not delete records. `cancelled` and `excluded_from_stats` remain distinct states and both remove the session from engagement calculations.

### Person-level roster provenance

Each attendance session gains `roster_provenance_version INTEGER NOT NULL DEFAULT 0`, and each attendance record gains `eligible_at_snapshot INTEGER NOT NULL DEFAULT 0`:

- `1`: the person was on the gathering roster when the session roster was captured;
- `0`: the person was added as an ad-hoc attendee and was not on that captured roster;
- session provenance version `0`: legacy provenance is unknown and the per-record flag is not interpreted.

The shared roster-capture service sets `eligible_at_snapshot = 1` for every roster member, including a member whose present record already exists, then sets the session's provenance version to `1` in the same transaction. Later ad-hoc attendees remain `0`.

For pre-migration provenance-version-`0` sessions, `roster_snapshotted = 1` is accepted as best-available legacy history and its attendance records may contribute as historically eligible. The UI reports how much of the current window uses this legacy fallback. A provenance-version-`0` session without a snapshot is excluded from person-level opportunity calculations entirely. This deliberately favours an honest coverage warning over a falsely precise absence rate. As the 52-week window advances, version-`1` provenance naturally replaces legacy history.

## Population and Eligibility

The reported population is the church's current active regulars: `individuals.is_active = 1` and `people_type = 'regular'`.

Historical opportunity rows with `people_type_at_time = 'regular'` contribute. Rows explicitly marked as either visitor type do not. For accepted legacy snapshot rows where `people_type_at_time IS NULL`, the row contributes only when the person is a current active regular, and it is included in the disclosed legacy-coverage count. This is the only fallback for missing historical people type.

An active regular must also have a current `gathering_lists` assignment to at least one active, standard gathering on the relevant axis:

- Without a current Primary assignment, the person's Primary status is `Not assigned`.
- Without a current Community assignment, the person's Community status is also `Not assigned`, but this is a normal participation state and not a data-quality warning.
- A Primary Not assigned count is shown prominently because it prevents the church-wide Primary distribution from being complete.

An inactive or archived person is omitted from the current profile and cannot generate a new decline event. Historical attendance remains available to aggregate trends.

## Opportunity Calculation

The server loads the current and comparison data in bulk. It does not issue one query per person or per gathering.

Let `E` be the most recent fully completed Sunday in the church timezone. The inclusive current window is `E - 363 days` through `E`; the inclusive comparison window is `E - 391 days` through `E - 28 days`. The service therefore loads exactly 56 completed weeks once and derives both 52-week profiles from that source.

A session may contribute only when all of the following are true:

- it belongs to the authenticated church;
- it uses standard individual attendance;
- its state is `held`;
- it is not excluded from statistics;
- its date falls within the requested complete-week window;
- it has a reliable current or accepted best-available legacy roster snapshot.

### Primary axis

For each person and church week:

- One or more version-`1` records with `eligible_at_snapshot = 1`, or records accepted through the version-`0` legacy fallback, in Primary sessions create exactly one opportunity.
- Once that denominator exists, presence at any included Primary service in that week fulfils the opportunity, including an alternative service where the person was an ad-hoc attendee.
- Being eligible for two alternative Sunday services cannot produce two absences.
- Presence in a week with no Primary eligibility does not create a denominator or a tier opportunity by itself.

The Primary rate is:

```text
Primary weeks attended / eligible Primary weeks
```

### Community axis

Each Community session with version-`1` `eligible_at_snapshot = 1`, or accepted version-`0` legacy provenance, is a separate opportunity. A person assigned to both a youth group and a small group has two commitments when both meet. Attendance at one does not fulfil the other.

The Community rate is:

```text
Eligible Community sessions attended / eligible Community sessions
```

An ad-hoc Community attendance record with `eligible_at_snapshot = 0` may appear in aggregate reach but does not invent an expected Community opportunity.

### Classification

A rate is classified only after at least eight eligible opportunities in that window:

- `rate >= core minimum` -> Core
- `rate >= casual minimum` and below Core -> Casual
- below Casual minimum -> Irregular
- fewer than eight opportunities -> Establishing

Boundary comparisons use the unrounded fraction. The UI displays both the tier and evidence, for example `31 of 46 opportunities (67%)`.

The eight-opportunity rule adapts to cadence: roughly two months for weekly, four months for fortnightly, and eight months for monthly participation.

## Long-Term Health Workspace

The Reports page becomes a lightweight shell with three lazy report workspaces. Existing date and gathering controls remain attached to Selected period. Long-term health always states its fixed 52-completed-week window and does not respond to the Selected period dates.

The workspace is people-health first:

1. **Primary tier distribution:** a donut chart containing Core, Casual, and Irregular among classified active regulars. Establishing and Primary Not assigned are adjacent labelled counts, not hidden inside the denominator.
2. **Recent tier movement:** counts of people whose established Primary tier is higher, unchanged, or lower than it was four completed weeks earlier. People who were not established in both windows appear as a separate non-comparable count. Administrative rule changes never appear as movement alerts.
3. **Primary x Community matrix:** a 3-by-3 matrix for people classified on both axes. Establishing and Not assigned totals appear outside the matrix. This makes combinations such as `Primary Irregular / Community Core` directly visible.
4. **Attendance trend:** 13 consecutive four-week buckets. Each role shows average attendance per held session; standard gatherings also show unique people attending at least once in the bucket. Headcount gatherings may contribute only to clearly labelled average-attendance series and never to unique reach, person matrices, or tiers.
5. **Local visitor journey:** people whose first recorded attendance was as a local visitor during the current window, those with another attendance within eight completed weeks, and those whose current people type is regular. Traveller visitors remain separate. The UI states that current conversion status is known but the exact historical conversion date is not.
6. **Coverage:** eligible held sessions, excluded unsnapshotted sessions, legacy-provenance share, Establishing count, and Primary Not assigned count.

Every chart can open the underlying people or sessions that produced it. Percentage cards show both numerator and denominator.

## Pastoral Care Workspace

Pastoral care is an action queue, not a ranking of people's worth or an opaque risk score. Initial queue types are:

- **Recent Primary tier decline:** an unrecovered persisted event in which an established person crossed from Core to Casual, Casual to Irregular, or Core to Irregular. Recovery resolves the item.
- **Community-connected, Primary-irregular:** both axes are established and the current profile is Community Core with Primary Irregular. The episode begins when that condition becomes true and resolves when either tier changes, assignment is removed, or the person becomes inactive.
- **Visitor next step:** a current local visitor whose first reliable Primary attendance occurred within the latest eight completed weeks and who has no later Primary attendance. The item resolves on a return, conversion to regular, or deactivation and expires after eight completed weeks.
- **Re-engagement:** recovery raises an established Primary tier above the lowest tier in a persisted decline episode. The positive item expires after four completed weeks and never enters the caregiver digest.

Every generated insight has a deterministic source episode. Dismissal lasts for that episode. If a resolved Community mismatch later becomes true again, or a recovered person later experiences a new decline and recovery, a new episode may appear. Expiry and resolution are server decisions derived from the factual condition, while snooze and dismissal are user workflow state.

Cards show the person and family, the factual evidence, last attendance, Primary and Community profiles, assigned family caregivers, and whether the signal is new or snoozed. Actions are:

- view the person or family;
- assign or change caregivers through the existing family caregiver picker;
- snooze until a chosen date;
- dismiss the current episode.

Snoozing or dismissing an insight suppresses that episode in both the workspace and unsent caregiver-digest content. A snooze defers an unsent item until the chosen date and makes it eligible again only if the underlying condition still exists. Dismissal cancels unsent delivery for that episode. Neither action retracts an email already sent, and dismissal does not suppress a later distinct episode after recovery. Existing `absence_dismissals` remains dedicated to consecutive-absence behavior and is not reused.

Caregiver assignment remains family-level. An active regular without a family can appear in the queue as Unassigned but cannot receive a family caregiver until normal family data is created; the reporting feature does not create synthetic one-person families.

## Tier Decline State Machine

Each weekly evaluation uses the current 52-week profile and the profile as of four completed weeks earlier. Both sides must be established under the same calculation-rules version.

The first evaluation after feature activation or a calculation-rules version change is a baseline-only run. It persists the evaluated week, current tier, and any already-existing lower-than-four-weeks-ago condition as a suppressed active episode; it emits no decline event. Subsequent runs can emit only a newly reached lower tier. This prevents an old decline or administrative recalculation from surfacing one week after the baseline.

A decline event is created only for the Primary axis when the current internal tier is lower than the comparison tier:

- Core -> Casual
- Casual -> Irregular
- Core -> Irregular

`Establishing`, Not assigned, visitors, inactive people, and configuration-version changes cannot create decline events.

Per-person Primary evaluation state is durable and church-scoped. It records rules version, last evaluated completed week, current tier, and active or baseline-suppressed decline tier. Repeated weekly comparisons do not reproduce the same event. Reaching a further lower tier creates one new event. Recovery closes the relevant factual decline episode and re-arms a later decline to that tier. Historical event rows are retained rather than deleted.

The event stores stable IDs, internal from/to tiers, effective completed-week end, rules version, and detection and recovery timestamps. Dedupe uses IDs and evaluation state, never names or formatted labels. Recovery belongs to this factual event; snooze and dismissal belong to its linked pastoral insight state.

## Existing Caregiver Integration

The feature reuses `family_caregivers`, including both app users and external contacts. Admins and coordinators keep their existing ability to assign or remove caregivers.

Tier declines are added to the existing weekly caregiver digest, not to immediate notification rules. Weekly tier evaluation runs on the church's configured Weekly Review day even when `weekly_review_email_enabled = 0`, keeping Pastoral care and recovery state current. That setting is the sole church-level gate for sending the existing weekly emails. At event detection, delivery rows are created for currently assigned caregivers who are eligible for email: an active app user with an email address and `email_notifications = 1`, or an active contact with an email address and `primary_contact_method = 'email'`. SMS-only delivery is outside scope.

Digest generation uses the opportunity engine's Primary decline events. It does not reuse the current all-gathering absence calculation. If consecutive absence and tier decline concern the same person, the caregiver receives one person card containing both factual reasons.

Digest eligibility requires an unrecovered event, a pending recipient delivery, and a linked insight that is open or whose snooze has expired. Dismissal cancels pending delivery. Reopening a dismissed item restores it only in the workspace and does not recreate cancelled deliveries or send a retroactive email.

Each recipient delivery is marked delivered only after that caregiver's email succeeds. A failed send leaves only the failed recipient rows available for retry. The person's current family, caregiver assignment, and recipient eligibility are revalidated immediately before sending; a family change, removed assignment, or inactive recipient marks the pending row cancelled. An event detected for a person without a family creates no delivery rows. Assignment after an event does not create a historical delivery row, although the open item is visible in Pastoral care. Multiple caregivers may receive the same family item, while recipients sharing an email address receive one combined email assembled using stable recipient, family, person, and event IDs.

The application creates one digest entry per transition and prevents known duplicate generation. Email delivery is at-least-once: if the process crashes after a provider accepts a message but before SQLite records success, a retry can produce a duplicate unless the provider supports an idempotency key. A stable message key is supplied whenever the provider supports one.

The existing admin test-send endpoint renders current data as a labelled test but does not consume or mark real events delivered.

## Architecture and Component Boundaries

### Server

New reporting calculations do not grow the existing large `server/routes/reports.js` handler. Thin authenticated routers under the Reports namespace call focused services:

- **Session finalisation and roster service:** owns held/cancelled state and reliable roster provenance for every live attendance path.
- **Opportunity engine:** loads church-scoped sessions, roster provenance, and attendance once and produces per-person Primary and Community opportunity facts for an injected as-of date.
- **Engagement engine:** applies current settings, Establishing rules, movement comparisons, matrices, and aggregate summaries.
- **Pastoral insight service:** derives queue items and applies snooze, dismiss, resolution, and recurrence state.
- **Tier decline service:** evaluates the weekly state machine and persists idempotent events.
- **Caregiver digest integration:** combines undelivered tier events with existing qualifying absence content and marks delivery after send.

Routes orchestrate authentication, validation, and response shaping. Calculation logic remains in services that can be tested with an injected church timezone and clock.

### Client

`ReportsPage.tsx` becomes the tab shell rather than absorbing more report logic. Focused components own:

- `SelectedPeriodReport`, wrapping the existing dashboard;
- `LongTermHealthReport`;
- `PastoralCareReport`;
- `EngagementSettings`, available to admins;
- shared tier badges, evidence displays, matrix, and caregiver picker integration.

The client follows the existing cache-first pattern: show a church-scoped cached response immediately when available, refresh in the background, and never reuse results across churches.

## Data Model

Additive schema changes include:

### `gathering_types`

- nullable `engagement_role` constrained to `primary`, `community`, or `other`.

### `attendance_sessions`

- `session_status TEXT NOT NULL DEFAULT 'open'` constrained to `open`, `held`, or `cancelled`;
- `roster_provenance_version INTEGER NOT NULL DEFAULT 0`;
- `cancelled_at` and `cancelled_by` audit fields.

### `attendance_records`

- `eligible_at_snapshot INTEGER NOT NULL DEFAULT 0`, interpreted only when the session provenance version is `1`.

### `engagement_settings`

One row per church containing:

- `church_id` primary key;
- Core and Casual minimum integer percentages;
- three display labels and colours;
- calculation-rules version;
- created and updated timestamps.

### `engagement_decline_events`

Durable factual Primary decline episodes, including:

- church, individual, and family-at-detection IDs;
- internal from/to tiers;
- effective week and rules version;
- detected and recovered timestamps;
- lifecycle state needed for idempotency.

### `engagement_evaluation_state`

One retained Primary row per church and evaluated individual containing:

- rules version and last evaluated completed-week end;
- current established tier, when available;
- active decline tier and whether it was baseline-suppressed;
- created and updated timestamps.

This row is the source of truth for baseline completion, repeat suppression, and recovery/re-decline re-arming.

### `engagement_decline_deliveries`

One row per event and caregiver recipient selected at detection, including:

- church, event, recipient type, and stable user/contact ID;
- nullable family-caregiver assignment foreign key using `ON DELETE SET NULL`;
- delivery state, last attempt, delivered timestamp, and retry metadata;
- a uniqueness constraint preventing duplicate delivery for the same event and recipient.

Before send, the service confirms that the individual still belongs to the event's family and that the same user/contact remains actively assigned and eligible for email. A changed family or missing assignment cancels the row without deleting delivery history.

### `pastoral_insight_states`

Workflow state for generated insights, including:

- church, insight type, subject ID, and deterministic episode/source key;
- open, snoozed, dismissed, or resolved state;
- snooze-until, actor, and timestamps.

Factual recovery is never stored here. This table controls workspace and unsent-delivery workflow only; the linked decline event remains the recovery source of truth.

Every table and index includes `church_id` even though church databases are physically separate. Foreign IDs are validated against the authenticated church before mutation. The complete schema supports new church databases, and explicit additive upgrade migrations create the same columns, tables, constraints, and indexes for existing databases.

## API Contract

The intended route surface is:

- `GET /api/reports/engagement/overview` — Long-term health data; no client date-range parameter.
- `GET /api/reports/engagement/people?segment=...` — cursor-paginated people behind a server-issued overview segment, with a maximum page size of 100.
- `GET /api/reports/engagement/sessions?series=...` — cursor-paginated sessions behind a server-issued trend or coverage series.
- `GET /api/reports/pastoral` — generated queue items, workflow state, and caregiver summaries.
- `PATCH /api/reports/pastoral/:insightId` — snooze, dismiss, or reopen an insight.
- `GET /api/settings/engagement` — readable by admins and coordinators so both workspaces can explain the active rules.
- `PUT /api/settings/engagement` — admin-only atomic threshold, label, colour, and gathering-role update.
- `PUT /api/attendance/sessions/state` — admin/coordinator upsert or transition by church-owned gathering, date, and requested `open`, `held`, or `cancelled` state; an explicit `open -> held` captures the standard roster even when nobody is marked present.

Overview responses use internal tier keys plus current labels, rates, attended counts, opportunity counts, window dates, population denominators, coverage metadata, and opaque drilldown segment tokens. Drilldown endpoints accept only tokens created for the authenticated church and a bounded cursor/limit; they do not expose arbitrary query filters. The client does not recalculate tiers or pastoral eligibility.

## Permissions and Church Isolation

- Admins and coordinators may view all three reporting workspaces.
- Only admins may edit tier settings or gathering engagement roles.
- Admins and coordinators may assign caregivers and manage pastoral workflow state.
- Existing narrower attendance access does not grant access to church-wide engagement reports.
- Every route derives `church_id` from the authenticated token, ignores client-supplied church identity, and scopes all reads and writes.
- Scheduled decline evaluation runs inside `Database.setChurchContext` or uses `queryForChurch` for the target church.
- Cached client and server results include the church identity in their key and are cleared on church switching.

## Error Handling and Data Quality

- No configured Primary gathering produces a setup state, never an empty tier chart.
- No active Primary assignments produces a roster setup warning.
- Missing or invalid settings fall back to the validated defaults for reading; invalid writes are rejected atomically without changing the existing configuration.
- Unsnapshotted sessions never create person-level absences.
- Legacy best-available provenance is disclosed with counts and percentages.
- Cancelled, open, excluded, future, and headcount sessions cannot enter person tiers.
- A caregiver email failure does not mark an event delivered and does not block other churches' scheduled work.
- A report calculation failure returns an error for that new workspace without breaking Selected period.
- No UI calls an individual detail endpoint once per person; bulk endpoints return the evidence needed for the page.

## Testing Strategy

### Opportunity and tier unit tests

- Monday-Sunday boundaries in a church timezone different from the server timezone.
- The current partial week is excluded.
- Two Primary services in one week produce one denominator and either service fulfils it.
- Two Community commitments remain two opportunities.
- Roster additions, removals, ad-hoc attendance, visitor-to-regular changes, and inactive people.
- Explicit provenance, accepted legacy provenance, and unsnapshotted exclusion.
- Open, held, cancelled, excluded, future, and PCO-imported sessions, including a recorded zero headcount and cancel-before-session upsert.
- Exact 20% and 60% boundaries, custom thresholds, and eight-opportunity Establishing behavior.
- Core/Casual/Irregular percentages use classified people only.
- Headcount never enters person tiers.

### Decline and caregiver tests

- Core-to-Casual, Casual-to-Irregular, and Core-to-Irregular transitions.
- Initial and rules-version baselines, repeated-week deduplication, a deeper decline, recovery, and later re-decline.
- Establishing, Not assigned, Community-only, inactive, visitor, and rules-version suppression.
- Threshold or gathering-role edits establish a baseline without sending alerts.
- Snooze, dismissal, expiry, resolution, and recurrence.
- Multiple caregivers, deleted assignments, inactive or opted-out recipients, same-email aggregation, and stable-ID dedupe.
- Combining absence and tier reasons into one person card.
- Partial-recipient send success, failure and retry, assignment after transition, the crash-after-provider-acceptance boundary, and non-consuming test sends.

### API, database, and client tests

- Admin-only configuration writes and admin/coordinator report access.
- Cross-church isolation for configuration, sessions, insights, caregivers, and scheduled work.
- Fresh-schema creation and upgrade migration of an existing church database.
- Long-term tabs ignoring Selected period dates.
- Empty/setup, Establishing, Not assigned, loading, stale-cache, and error states.
- Accessible tier presentation that does not rely only on colour.
- Bulk-query behavior on a representative large roster, with no per-person query loop.

Verification includes the affected server unit and database-integration tests, targeted client component tests, client type/build validation, and the existing caregiver and Reports regression tests.

## Rollout and Compatibility

The Selected period workspace remains behaviorally compatible throughout rollout. Existing gathering and attendance APIs retain their fields; new state, role, provenance, and report fields are additive.

After migration:

1. existing reliable snapshots appear as labelled best-available history;
2. all live attendance paths begin recording explicit provenance;
3. admins see a one-time Primary/Community setup prompt;
4. reports can calculate immediately where sufficient history exists;
5. decline notification establishes a baseline under the initial rules version before emitting events.

No historical attendance row is deleted or rewritten as present/absent. A church can leave every gathering unclassified and continue using Selected period exactly as before.

## Acceptance Criteria

- The Reports page exposes Selected period, Long-term health, and Pastoral care without applying Selected period dates to the latter two.
- An admin can configure gathering roles and valid tier thresholds atomically.
- The default tier model yields Core at 60%+, Casual at 20–59%, and Irregular below 20%, after eight eligible opportunities.
- Primary and Community profiles remain independent and explain their exact numerator and denominator.
- Multiple Primary services in a week cannot multiply a person's expected attendance.
- Unreliable sessions are excluded and coverage is visible.
- The Pastoral care queue uses factual, actionable signals and reuses family caregivers.
- A Primary tier decline creates one digest entry per recipient and transition, retries undelivered rows, and may create a new entry only after recovery and a later decline; transport follows the documented at-least-once boundary.
- Configuration changes cannot generate decline alerts.
- Headcount gatherings never produce person tiers.
- All APIs, migrations, caches, and scheduled jobs preserve church isolation.
