# Church Timezone Consistency Design

## Goal

Use the timezone implied by the church location for church-local calendar calculations and for production date/time presentation, regardless of the browser, device, or server timezone.

## Current Problems

The application already stores `church_settings.timezone`, but the selected church location is not its source of truth:

- Open-Meteo location search results are reduced to name and coordinates, discarding the provider timezone.
- The location update endpoint saves only name and coordinates.
- Onboarding hard-codes `Australia/Sydney` even when another location is selected.
- Existing churches may therefore have coordinates and a stale or unrelated timezone.

Timestamp presentation also has two independent errors:

- SQLite UTC timestamps such as `2026-08-13 02:15:00` have no offset. Browsers interpret this shape as local time rather than UTC.
- Client components generally call `toLocaleString()` or `toLocaleTimeString()` without a `timeZone`, so the result uses the viewing device timezone rather than the church timezone. Check-in history and its TSV export are direct examples.

Several server and client calculations obtain “today,” weekday, or current wall-clock time from the host environment. These can select the wrong church calendar date around midnight or run a recurring task on the wrong church-local day.

## Time Semantics

Every date/time value is classified into one of four categories:

1. **Instant:** A real moment such as `created_at`, a check-in time, a sync run time, or last login. Store and transmit it in UTC. Display it in the church timezone.
2. **Church calendar date:** A value such as an attendance session date or gathering date (`YYYY-MM-DD`). It has no timezone and must never shift during parsing or display.
3. **Church wall-clock schedule:** A value such as a gathering start time, self-check-in window, notification hour, or scheduled weekday. Interpret it in the church timezone.
4. **Duration or ordering token:** Cache ages, conflict timestamps, expiry windows, elapsed durations, and relative comparisons operate on epoch milliseconds or UTC instants. They do not require timezone conversion.

Technical diagnostics that intentionally describe the current device, connection, or server may remain in that environment's timezone. Production church data must follow the church contract.

## Location and Timezone Source of Truth

`location_lat` and `location_lng` are the source of truth whenever a church has a saved location. The server derives an IANA timezone from those coordinates using an offline coordinate lookup. It does not trust a client-supplied timezone.

When an admin selects a location, the server validates the name and coordinate ranges, derives the timezone, and atomically updates the location fields and `church_settings.timezone`. The response includes the saved timezone so the client can update its authenticated context immediately.

Onboarding sends the selected location but does not supply a hard-coded timezone when coordinates are present. The server derives it through the same helper used by Settings. A church without coordinates retains its valid stored timezone; the existing schema default remains the final fallback.

During church database initialization, an additive, idempotent backfill checks settings rows with valid coordinates. It derives the timezone locally and updates a missing or differing timezone. This corrects existing churches without requiring an administrator to re-save the location and without making startup depend on an external API. Invalid legacy coordinates are left unchanged and logged.

## Authenticated Timezone Contract

The authenticated `User` payload includes `timezone` for every role. Login verification, `/auth/me`, and church switching all return the timezone for the active church. The value is cached with the existing user payload and refreshed through the existing authentication lifecycle.

The client uses this value through a small church-time utility/hook rather than fetching admin-only settings. A missing or invalid timezone falls back safely to `UTC` for formatting and calculations; it must not cause a screen to crash. Once `/auth/me` refreshes the cached user, all consumers receive the authoritative value.

## Shared Date/Time Utilities

### Client

A shared utility provides these operations:

- Parse API instants. Explicit-offset ISO strings are respected; SQLite `YYYY-MM-DD HH:mm:ss` values are treated as UTC.
- Format an instant as a church-local date, time, or date-time using `Intl.DateTimeFormat` and the church timezone.
- Return the current church calendar date as `YYYY-MM-DD`.
- Return church-local calendar parts needed by schedule and check-in-window calculations.
- Parse and format `YYYY-MM-DD` values as date-only data without applying a timezone shift.

The browser locale continues to control language, ordering, and 12/24-hour conventions unless a screen already requests a specific locale or format. The church timezone controls which local date and time the instant represents.

### Server

A shared utility validates IANA timezone identifiers and returns church-local calendar parts/date strings for an injected instant. Calendar arithmetic on date-only values uses UTC-based date helpers so it is independent of the server timezone. Instant comparisons continue using UTC/epoch values.

SQLite timestamps used as instants are normalized at the API boundary to unambiguous UTC ISO strings where practical. Client parsing remains defensive for legacy SQLite-shaped values.

## Audit Scope

The implementation audits production paths, not only Check-in History.

### Client presentation

Replace device-timezone formatting for church-owned instants, including:

- Check-in history detail, visible times, and TSV export.
- User last-login values.
- Planning Center and Elvanto run/check/source timestamps.
- People-sync review timestamps and source freshness tooltips.
- Other production components that display API `created_at`, `updated_at`, run, or check timestamps.

Calendar-date displays for gatherings and attendance remain date-only and are migrated to the date-only helper where current `Date` parsing can shift the displayed day.

Relative elapsed labels remain based on instants. If a legacy SQLite timestamp feeds a relative label, it is normalized as UTC before calculating the duration.

### Client calculations

Use the church calendar rather than the device calendar for:

- Initial and maximum “today” values in attendance, check-ins, reports, and exports.
- Gathering occurrence windows and schedule comparisons that depend on the current date.
- Self-check-in/check-out wall-clock windows.
- Any other production branch whose result changes according to local date, weekday, or wall-clock hour.

### Server calculations

Use the church timezone for:

- “Today” defaults and future/past attendance decisions.
- Recent visitor and report date ranges anchored to today.
- AI/weather context date ranges and the stated current date.
- Weekly review ranges and send scheduling.
- People-sync scheduled weekday/month-day decisions.
- Integration import defaults whose end date means the church's current day.
- WebSocket attendance logic that distinguishes past, present, and future dates.

Pure date-only arithmetic, UTC instant ordering, expiry, cache TTLs, and conflict resolution remain timezone-independent.

## API and Data Compatibility

No timestamp columns are rewritten and no historical instants are shifted. The change affects interpretation, serialization, calculation, and display.

Existing API fields remain available. Adding `timezone` to user and location responses is additive. Normalizing a legacy SQLite timestamp to ISO UTC preserves the represented instant but consumers must also accept the legacy shape during rollout.

Church isolation remains mandatory: timezone queries and updates use the authenticated `church_id`, and background jobs load the timezone inside each church context.

## Error Handling

- Reject location updates when coordinates are invalid or a timezone cannot be derived.
- Validate stored timezone identifiers before passing them to `Intl.DateTimeFormat`.
- Fall back to `UTC` for missing/invalid legacy timezones and log the church-scoped server condition.
- Leave existing settings untouched if an automatic backfill encounters invalid coordinates.
- Never fall back silently to the browser or server local timezone for church-owned production data.

## Testing Strategy

Tests set the process/browser timezone to one that differs from the church timezone so accidental local defaults are observable.

Coverage includes:

- Coordinate lookup for representative locations and automatic correction of an existing settings row.
- Location update and onboarding persisting the derived timezone atomically and rejecting invalid coordinates.
- Auth login, `/auth/me`, and church switching returning the active church timezone without cross-church leakage.
- Parsing SQLite UTC timestamps and formatting check-in times in the church timezone, including TSV output.
- Date-only values retaining the same calendar date in positive and negative UTC offsets.
- Church “today,” weekday, and wall-clock helpers around UTC midnight.
- A daylight-saving transition in a timezone that observes DST.
- Scheduled server work choosing the church-local day rather than the server day.
- Targeted component tests for migrated production displays and calculation branches.

Verification consists of the affected server and client tests followed by client type/build validation and the relevant server test groups.

## Non-Goals

- Allowing a separate per-user timezone preference. The active church timezone is authoritative.
- Changing the user's locale or forcing a global 12/24-hour preference.
- Rewriting historical timestamps or attendance session dates.
- Converting cache timestamps, token expiry, request timing, or other duration calculations to wall-clock time.
- Redesigning date/time UI beyond correcting its timezone semantics.
