# PCO Medical-Note Indicators

**Date:** 2026-08-05

**Status:** Approved design

**Scope:** Planning Center medical-note presence refresh, configurable indicator appearance, role and gathering visibility, Take Attendance, and People

## Summary

Let My People Grow (LMPG) will show a configurable indicator when a Planning Center Online (PCO) person has a nonblank `medical_notes` value. LMPG will not display, return, or persist the note text. Users who need details will open Planning Center separately.

The feature is disabled by default. An administrator enables it, chooses the minimum LMPG role allowed to see the indicator, selects the standard gatherings for which medical information is relevant, and chooses an icon and colour.

The appearance can be created specifically for this feature or adopted from an icon-only badge already used by people in the church. Adopting an existing appearance is an explicit, warned, one-time conversion: matching manual badges are cleared from active and archived people, and the appearance thereafter renders as a separate computed medical indicator driven by the PCO-derived boolean.

## Goals

- Show whether a relevant PCO-linked individual has any medical note.
- Store only a boolean presence flag, never medical text or content-derived metadata.
- Let each church choose the minimum viewer role and relevant gatherings.
- Let admins choose an icon and colour using the existing badge vocabulary.
- Safely convert an existing icon-only badge appearance into the computed medical indicator.
- Keep ordinary person badges independent after conversion.
- Work naturally with the attendance page's existing offline boolean roster cache.

## Non-goals

- Displaying, fetching on demand, proxying, editing, or linking directly to medical-note text.
- Providing a medical-note modal, drawer, retry flow, or live PCO detail endpoint.
- Auditing each time a user sees an indicator.
- Mirroring a user's personal PCO permissions.
- Supporting custom visible text for the medical indicator.
- Converting badges that contain visible badge text.
- Creating a general multi-badge data model.
- Showing the indicator in self check-in/kiosk, leader check-in, reports, exports, notifications, or WebSocket payloads.
- Handling PCO profile Note resources or note categories. This feature concerns only `Person.attributes.medical_notes`.

## Privacy Invariant

LMPG may persist:

- `pco_has_medical_notes` as `0` or `1`;
- feature configuration;
- the chosen icon and colour;
- relevant gathering IDs;
- content-free refresh timestamps, result codes, and counts;
- content-free settings/adoption audit metadata.

LMPG must never persist, return to the client, or intentionally retain:

- the medical-note string or an excerpt;
- note length, a hash, keywords, classification, or summary;
- a raw PCO Person payload containing `medical_notes`;
- a serialized provider error that may contain provider response data;
- medical text in SQLite, local storage, session storage, IndexedDB, Cache Storage, logs, traces, analytics, audit rows, notifications, exports, sync plans, reviews, offline queues, global state, or WebSocket messages.

PCO does not expose a documented `has_medical_notes` boolean. The server therefore briefly receives `medical_notes` during the background refresh, converts it immediately to a boolean, and discards the text-bearing provider page. No LMPG user-facing endpoint returns the text.

## Data Model

### Individuals

Add to the base schema and additive migration path:

```sql
pco_has_medical_notes INTEGER NOT NULL DEFAULT 0
```

This supplementary status update must not change `individuals.updated_at`.

### Church settings

Add:

- `planning_center_medical_notes_enabled INTEGER NOT NULL DEFAULT 0`
- `planning_center_medical_notes_minimum_role TEXT NOT NULL DEFAULT 'admin'`
- `planning_center_medical_notes_badge_icon TEXT`
- `planning_center_medical_notes_badge_color TEXT`
- `planning_center_medical_notes_last_refreshed_at TEXT`
- `planning_center_medical_notes_last_refresh_result TEXT`

Allowed minimum-role values are exactly `admin`, `coordinator`, and `attendance_taker`. Icon values must be accepted by the existing `BadgeIcon` vocabulary. Colours use the same valid format and normalization as ordinary badge colours.

The last result contains only a bounded status code and safe counts.

### Relevant gatherings

Create:

```sql
CREATE TABLE IF NOT EXISTS planning_center_medical_note_gatherings (
  church_id TEXT NOT NULL,
  gathering_type_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (church_id, gathering_type_id),
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE
);
```

All reads and writes include `church_id`. Only active standard-attendance gatherings may be selected.

## Role Policy

| Configured minimum | Authorized roles |
|---|---|
| `admin` | admin |
| `coordinator` | admin, coordinator |
| `attendance_taker` | admin, coordinator, attendance_taker |

The server owns this mapping. Users below the threshold receive no medical field, rather than `false`, because the existence of medical information is sensitive.

## Gathering Eligibility

### Take Attendance

The server may include `hasMedicalNotes` only when:

- the feature is enabled;
- the viewer meets the configured role threshold;
- the selected gathering is configured as medically relevant;
- the viewer has existing access to that gathering;
- the individual is active, belongs to the church, has a nonblank `planning_center_id`, and is currently assigned to that gathering through `gathering_lists`.

Historical attendance does not preserve eligibility after removal from the current gathering roster. The **All People** section does not receive the field for people who are not currently assigned to the selected gathering.

### People

The People page remains limited to admin and coordinator roles. An otherwise-authorized individual is eligible when currently assigned to at least one medically relevant gathering. This is union semantics across selected gatherings.

### Excluded surfaces

Self check-in/kiosk, leader check-in, reports, exports, notifications, audit exports, and WebSocket messages receive neither the boolean nor medical appearance configuration.

## Medical Presence Refresh

### Fetch and projection

Use a dedicated service separate from the generic people-sync projection and review plan. Request a complete, paginated account-wide PCO People snapshot using sparse Person fields limited to `medical_notes` where supported.

Project each resource immediately:

```js
{
  id: String(resource.id),
  hasMedicalNotes:
    typeof resource.attributes?.medical_notes === 'string' &&
    resource.attributes.medical_notes.trim().length > 0
}
```

Discard each raw provider page after projection. The normalized snapshot contains only IDs and booleans.

### Application

Only a complete snapshot may mutate local flags. In one `transactionForChurch` operation:

1. Clear stale flags on inactive or unlinked people in the church.
2. Load every active individual with a nonblank `planning_center_id`.
3. Set each linked individual's flag from the complete provider map.
4. Set linked people absent from the complete snapshot to false.
5. Store the successful refresh timestamp and safe counts.

An incomplete page sequence, malformed resource, authentication failure, timeout, rate-limit exhaustion, or provider error leaves all flags and the last-success timestamp unchanged.

The refresh is account-wide and independent of configured people-sync batches. People linked through another workflow remain accurate.

### Triggers and coordination

Refresh when:

- an admin enables the feature;
- an admin selects **Refresh indicators now**;
- a manual or unattended PCO people-sync apply completes successfully;
- the daily scheduler runs while both this feature and the PCO scheduling master switch are enabled.

Use church-scoped in-flight coalescing, a short successful boolean-snapshot TTL, and the existing PCO credential-epoch coordinator. A snapshot fetched against a replaced or disconnected credential must not apply.

Manual refresh remains available when the scheduling master switch is off.

## Indicator Appearance

### Create a new appearance

Admins may choose an icon from the existing badge icon picker and a colour from the existing badge colour picker. This saves only the church-level medical appearance and does not change any person's manual badge.

The visible indicator has no custom text. Its fixed tooltip and accessible label are:

> Medical note recorded

### Discover existing appearances

The settings API lists unique icon-only manual badge appearances currently used by active or archived people in the church. An eligible appearance has:

- a nonblank `badge_icon`;
- a valid `badge_color`;
- `badge_text IS NULL OR TRIM(badge_text) = ''`.

Group by icon plus case-normalized colour and return:

- icon;
- normalized colour;
- total affected-person count, including active and archived people.

Text-bearing badges are never offered for adoption.

### Adopt an existing appearance

Selecting an existing style does not mutate people. Saving requires a destructive confirmation containing the previewed count:

> This appearance is currently used as a manual badge by 14 people, including archived people. Continuing will remove that manual badge from all 14 people and use the appearance for PCO medical-note indicators instead. This cannot be automatically undone.

The confirmed request identifies the exact icon and normalized colour and carries an explicit `adoptExistingAppearance: true`. The server must not trust the preview count.

In one church-scoped transaction:

1. Recount exact icon-only matches across active and archived people using icon equality and case-insensitive colour equality.
2. Clear `badge_icon` and `badge_color` on every exact match. The predicate also requires blank/null `badge_text`.
3. Save the icon and colour as the medical appearance.
4. Save the remaining medical settings and relevant gathering rows.
5. Insert a content-free audit row recording the icon identifier, normalized colour, affected count, requesting admin, church, and timestamp.

If any step fails, all badge and settings changes roll back. The response reports the authoritative affected count.

Adoption cleanup happens only when an admin actively submits `adoptExistingAppearance: true`. Later role, gathering, enable/disable, or appearance edits do not repeat it. A newly created appearance never clears person badges.

Previously cleared manual badges are not restored if the feature is disabled or its appearance changes.

## Settings Experience

Add a **Medical-note indicators** section to the Planning Center integration panel with:

- enable switch, default off;
- minimum-access dropdown;
- active standard-gathering multi-select;
- **Use existing appearance** choices with icon, colour, and affected count;
- **Create new appearance** using existing icon and colour controls;
- fixed-label preview;
- last successful refresh time and safe status;
- **Refresh indicators now**;
- privacy copy explaining that only presence is stored and details remain in Planning Center.

Enabling requires an active PCO connection, at least one gathering, a valid icon, a valid colour, and a minimum role.

Saving an existing-style adoption opens the destructive confirmation. The client sends no adoption flag until the user confirms.

If initial refresh fails, settings remain enabled and the panel shows a safe failure plus manual refresh action. No incomplete provider result clears existing flags.

Disabling or disconnecting PCO atomically turns the feature off and clears all medical booleans. It retains icon, colour, minimum role, and relevant gatherings for later re-enablement. A PCO disconnect must participate in the existing credential-mutation transaction.

## API and DTO Contracts

No live medical-note endpoint exists.

Admin integration settings expose:

```json
{
  "planningCenterMedicalNotes": {
    "enabled": false,
    "minimumRole": "admin",
    "gatheringTypeIds": [],
    "badgeIcon": null,
    "badgeColor": null,
    "lastRefreshedAt": null,
    "lastRefreshResult": null
  }
}
```

The appearance-discovery endpoint returns icon, colour, and count only. It returns no person names because the confirmation needs scope, not an additional people-data surface.

Authorized, eligible person rows in People and Take Attendance may include:

```ts
hasMedicalNotes?: boolean
```

Return the authorized appearance once at the response root rather than repeating it on every person:

```ts
medicalNotesIndicator?: { icon: string; color: string }
```

Keep only `hasMedicalNotes` on individual rows. Unauthorized or globally ineligible responses omit both the row field and request-level appearance.

The client never infers authorization or gathering eligibility from cached assignments.

## Rendering

Render the configured `BadgeIcon` and colour beside the person's name only when `hasMedicalNotes === true` and the response includes the authorized request-level appearance.

The indicator is separate from the ordinary personal badge and does not mutate `badge_text`, `badge_icon`, or `badge_color`. A person may display both their unrelated ordinary badge and the medical indicator.

The indicator is non-interactive. It has the fixed tooltip/accessibility label **Medical note recorded** and does not toggle attendance, select a card, add a person, or open a modal.

The attendance page may persist the boolean and authorized appearance in its existing offline roster cache. No medical text is present, so offline rendering needs no special network action.

## Audit and Logging

Audit settings changes using allowlisted, content-free metadata. Existing-style adoption receives its own action, for example `ADOPT_PCO_MEDICAL_BADGE`, with icon identifier, normalized colour, affected count, admin, church, and timestamp.

Do not place request bodies into the audit row. Do not audit each indicator render.

Operational logs may include church ID, refresh outcome code, duration, and safe counts. They must not include provider Person payloads, medical text, content-derived metadata, tokens, headers, or serialized provider errors.

## Testing Strategy

### Schema and policy

- New and migrated databases receive all columns/table/defaults.
- Feature defaults off and minimum role defaults to admin.
- Invalid role, icon, colour, headcount/inactive/cross-church gathering, and enabled-with-incomplete-settings inputs are rejected.
- Role hierarchy and gathering eligibility are church-scoped.

### Refresh privacy and completeness

- Null, missing, non-string, blank, and whitespace-only notes map to false; populated strings map to true.
- Raw projected objects contain no medical text.
- All pages complete before any database mutation.
- Partial/malformed/error snapshots leave flags/timestamp unchanged.
- Complete snapshots update all active linked people, reset missing people, and clear inactive/unlinked stale flags.
- Credential replacement/disconnect prevents stale snapshot apply.
- A unique sentinel note appears in neither SQLite, logs, settings, audit, sync plans/reviews/runs, API responses, nor client state.

### Appearance discovery and adoption

- Discovery includes active and archived people.
- Only icon-only badges are returned.
- Colours group and match case-insensitively.
- Cross-church badges are excluded.
- Preview count is informational; the transaction recount is authoritative.
- No mutation occurs before explicit confirmation.
- Confirmed adoption clears every exact icon-only match and no text-bearing or different-style badge.
- Settings, cleanup, and audit commit or roll back together.
- Ordinary settings edits do not repeat cleanup.
- Creating a new appearance changes no person badge.
- Disable and disconnect do not restore cleared badges.

### DTOs and UI

- All three role-threshold matrices are covered.
- People uses the union of relevant gatherings.
- Take Attendance requires the exact relevant gathering and current assignment.
- Unauthorized/ineligible DTOs omit the boolean and appearance.
- **All People**, kiosk, leader check-in, reports, exports, notifications, and WebSockets omit medical fields.
- The computed indicator can coexist with an unrelated ordinary badge.
- Indicator interaction cannot trigger parent row/card behavior.
- Attendance offline cache contains only the allowed boolean/appearance, never text.

## Manual Verification

1. Create active and archived people with the same icon-only heart/yellow badge, plus text-bearing and different-colour controls.
2. Open settings and confirm the heart/yellow option shows the exact active + archived count while text badges are excluded.
3. Select it, verify the warning, cancel, and confirm no data changes.
4. Confirm adoption and verify exact icon-only badges clear, controls remain, settings save, and audit records the authoritative count.
5. Refresh against a PCO test person with a unique sentinel medical note.
6. Confirm only the boolean exists locally and the sentinel is absent from database, logs, audit, network responses, sync artifacts, and browser storage/state.
7. Verify People and Take Attendance visibility for all role thresholds and gathering combinations.
8. Verify an unrelated ordinary badge and the computed medical indicator render together.
9. Verify kiosk, leader check-in, reports, exports, and offline queues contain no medical fields.
10. Disable and disconnect; confirm booleans clear, settings remain, and cleared manual badges are not restored.

## Acceptance Criteria

- The feature is default off and admin-configured.
- LMPG stores and exposes only whether a PCO medical note exists, never its text.
- Account-wide complete refreshes maintain booleans for every active linked individual.
- Admins choose a minimum role and relevant standard gatherings.
- Admins create a new icon/colour appearance or explicitly adopt an existing icon-only style.
- Adoption warns with an active + archived preview count, recounts transactionally, clears exact matches, and audits the authoritative count.
- Adoption never clears text-bearing, different-icon, different-colour, or cross-church badges.
- The medical indicator remains computed and separate from ordinary person badges.
- Only eligible People and Take Attendance responses/rendering receive the indicator.
- No live-note endpoint, modal, or per-view audit exists.
- Disable/disconnect clears booleans but does not restore adopted manual badges.
- Automated and manual sentinel checks find no medical text in LMPG-controlled persistence, responses, logs, or client state.

## Implementation Boundaries

Likely changes include:

- `server/config/schema.js` and `server/config/database.js`;
- dedicated policy/status modules under `server/services/planningCenter/`;
- Planning Center settings routes and disconnect transaction;
- people-sync completion and daily scheduler trigger points;
- People and full-attendance DTO queries;
- `client/src/services/api.ts`;
- Planning Center integration settings UI;
- a small computed indicator component used by `PersonCard` and `AttendancePage`;
- focused unit, database-integration, route, and component tests.

Do not add medical content to the generic people-sync projection, review/plan objects, normal person badge fields, family notes, live API routes, modal state, offline change queues, reports, exports, or WebSockets.

## External API Basis

Planning Center's People API documents `medical_notes` as a Person string attribute but does not document a separate presence boolean. The background service must therefore read that sparse field to derive the local boolean.

- [Planning Center People API: Person](https://api.planningcenteronline.com/docs/apps/people/versions/2025-11-10/vertices/person)
