# Attendance Context

**Date:** 2026-08-17

**Status:** Approved design

**Scope:** Explain aggregate historical attendance alongside manual church context, weather, national public holidays, and a common Western Christian calendar

## Summary

Attendance Context adds explanatory evidence to attendance reports without claiming causation and without attributing an individual's absence to an external event. It combines:

- structured notes entered by admins and coordinators;
- historical weather near the church around a gathering's usual time;
- applicable national public holidays;
- Christmas Day, Palm Sunday, Good Friday, Easter Sunday, and Pentecost; and
- manually entered school-holiday ranges and tradition-specific dates.

Context appears as markers on attendance charts, detail popovers for individual dates, and carefully worded aggregate comparison cards when enough comparable sessions exist. An ordinary note never changes a statistic. A cancelled gathering uses the distinct session state defined by the opportunity-based engagement specification because cancellation changes whether an opportunity existed.

Reports context works without an AI provider or AI API key. Existing provider logic is extracted from `server/routes/ai.js` into a shared, cached service. Reports is a direct consumer; the AI assistant may remain an optional, separately authorised consumer of structured weather and calendar facts.

This is the second deliverable after [Opportunity-Based Engagement Reporting](./2026-08-17-opportunity-based-engagement-reporting-design.md). It depends on that specification's Reports workspaces and explicit attendance-session state, but its provider failures cannot break those workspaces.

## Goals

- Help church leaders interpret unusual or recurring aggregate attendance patterns.
- Let admins and coordinators record context from Attendance or Reports.
- Keep manual context structured enough to filter, compare, and display consistently.
- Use the church's saved location, country, and timezone without exposing attendance or people to external providers.
- Fetch historical context safely with persistent caching and explicit freshness and availability states.
- Keep core reports available when one or every provider is unavailable.
- Show comparison windows, sample sizes, and the difference between an observation and a repeated pattern.
- Reuse one context service across Reports and optional AI features rather than maintaining route-local provider code.

## Non-goals

- Forecasting future attendance or displaying future weather.
- Automatically obtaining school-holiday calendars in version one.
- Automatically handling state, province, council, or other regional public holidays.
- Inferring why a named person or family missed a gathering.
- Sending contextual alerts to caregivers.
- Statistical or causal claims such as “rain caused attendance to fall.”
- Sending manual annotation text to weather, holiday, or AI providers by default.
- Versioning every historical venue, coordinate, or gathering schedule change.
- Replacing the Selected period report or the opportunity-tier calculation.

## Context Sources

### Manual annotations

Admins and coordinators can create one of these structured types:

- Special service
- Combined service
- Venue or time change
- Church event
- School holiday
- Local disruption
- Other

Each annotation contains a required short title, optional details, and exactly one scope:

1. **This gathering and date:** one gathering and one church-calendar date.
2. **All gatherings on this date:** one church-calendar date, no gathering.
3. **All gatherings in this date range:** inclusive start and end dates, no gathering.

Version one deliberately does not support a gathering-specific date range. A recurring or extended circumstance affecting only one gathering can be represented by separate dated annotations rather than adding recurrence rules.

The API and database use these stable enum values:

- types: `special_service`, `combined_service`, `venue_or_time_change`, `church_event`, `school_holiday`, `local_disruption`, `other`;
- scopes: `gathering_date`, `all_gatherings_date`, `all_gatherings_range`.

Titles are trimmed plain text from 1 to 120 characters. Details are optional trimmed plain text up to 2,000 characters. The client displays text without interpreting HTML.

An annotation is descriptive only. Creating, editing, or deleting it never changes `excluded_from_stats`, attendance records, session state, or opportunity counts.

### Cancellation

“Gathering cancelled” is not an annotation type. It is a confirmed attendance-session state because it removes an opportunity and affects statistics. The Attendance action is visually separate from **Add context**, requires confirmation, and follows the validation and permissions in the opportunity-based engagement specification.

A cancelled session automatically produces a read-only Cancelled marker in contextual displays. Restoring the session removes that generated marker. Optional explanatory details belong in a separate manual annotation so the cancellation state remains a precise operational fact.

### Historical weather

Open-Meteo remains the initial weather provider behind an adapter. Reports requests historical observations only; the existing AI forecast behavior is outside this feature.

For a gathering with a valid start time, the adapter requests hourly observations and summarises the interval from `start_time` to `end_time`, or from `start_time` through `duration_minutes` when no end time exists. The normalised observation includes:

- temperature range and apparent temperature where available;
- precipitation and rain or snow amount;
- maximum wind speed; and
- the provider's weather code mapped to a stable internal description.

If the gathering lacks usable time information or hourly history is unavailable, the service uses an available daily summary and labels it `daily weather` rather than implying it describes the gathering interval. If neither hourly nor daily history is available, weather for that session is unavailable.

Historical lookup uses the current saved church coordinates and the gathering's stored schedule. A manual Venue or time change marker warns users when those defaults may not represent a particular historical session. Retrospective venue and schedule versioning is outside version one.

### National public holidays

Nager.Date remains the initial holiday provider behind an adapter. Requests contain only ISO country code and year. Version one includes only holidays the provider marks as nationally or globally applicable. Regional entries are omitted because the church does not store a validated subdivision; admins can represent relevant regional dates manually.

The existing `church_settings.country_code` continues to control phone-number and authentication behavior and is not changed by this feature. Add a separate nullable `location_country_code` for holiday lookup. The server-side location search returns an opaque, signed selection token that expires after 15 minutes and binds the provider result's location name, coordinates, and uppercase ISO alpha-2 country code. Settings and onboarding use the same token contract. The receiving endpoint verifies the token, derives the timezone from its coordinates through the existing timezone service, and atomically saves the bound location values and `location_country_code`. A location change invalidates the effective context cache by changing its location fingerprint. Valid zero-valued latitude or longitude is accepted.

### Christian calendar

A local, deterministic adapter calculates dates under the Western/Gregorian calendar:

- Palm Sunday: seven days before Easter Sunday;
- Good Friday: two days before Easter Sunday;
- Easter Sunday;
- Pentecost: 49 days after Easter Sunday; and
- Christmas Day: 25 December.

No network request is required. When a date is also a public holiday, the UI produces one marker with both source labels rather than duplicate chart icons. Other denominational observances are manual annotations.

### School holidays

Reliable global school-holiday coverage varies by jurisdiction, so version one uses the School holiday manual annotation type and all-gatherings date-range scope. Automatic providers may be considered later without changing the annotation model.

## Language and Evidence Rules

Context is aggregate and associative. Approved phrasing includes:

> Attendance was 11% below this gathering's recent baseline on a very wet Sunday.

> Across 6 sessions with recorded rain, average attendance was 7% lower than across 24 comparable sessions without recorded rain.

Disallowed phrasing includes:

> Rain caused 12 people to stay home.

> Alex missed church because it was a public holiday.

The service returns structured facts and numeric comparisons, not generated causal prose. The client uses fixed copy templates that contain “on,” “associated with,” or “compared with,” and never “caused by.”

### Date markers

A chart marker appears whenever valid context exists. Its popover shows:

- gathering and date;
- attendance or headcount using the existing aggregation rules;
- manual annotations;
- weather coverage and whether it is hourly or daily;
- public and Christian calendar labels; and
- provider freshness and retrieval time where relevant.

Marker presence alone is not presented as a pattern.

### Single-session comparison

When at least four prior included, held sessions exist for the same gathering, a session detail compares attendance with the median of up to the previous eight comparable sessions. It states the baseline size and does not generalise beyond that date. With fewer than four prior sessions, the popover shows attendance and context without a baseline comparison.

### Repeated-pattern cards

A repeated-pattern card requires at least:

- 4 affected sessions with the same context category; and
- 12 unaffected baseline sessions for the same gathering and attendance mode.

Pattern analysis uses available reliable history from no more than the latest 156 completed church weeks so weather patterns can accumulate enough samples. The card labels its exact analysis window even when the visible tier workspace uses 52 weeks. If the minimum is not met, the context remains available as date markers without a pattern claim.

Initial repeatable categories are:

- measurable precipitation greater than 0.1 mm during the gathering interval versus no measurable precipitation;
- national public holiday versus ordinary date;
- each manual annotation type.

Temperature, apparent temperature, wind, and weather code are displayed as observations. Version one does not invent universal “hot,” “cold,” or “windy” thresholds across different climates. A later design may add climate-relative categories.

Comparisons use the same gathering and attendance mode. They omit open, cancelled, excluded, and future sessions. For the category being tested, affected sessions match that category and baseline sessions do not; other overlapping context is permitted in either set and is disclosed in the detail view. One session may therefore contribute to more than one independently labelled analysis. Standard gatherings use unique present people; headcount gatherings use their existing separate, combined, or averaged aggregation behavior. Repeated-pattern cards compare the arithmetic mean for the affected and baseline sets and display both values and sample sizes. When the baseline mean is zero, the card shows the absolute difference and reports percentage difference as unavailable. No significance or confidence claim is made.

## User Experience

### Attendance entry point

The existing session actions near **Exclude from stats** gain **Add context**. It opens a reusable modal prefilled with This gathering and date. The user chooses a type, title, optional details, and may change to an all-gatherings date or range scope.

The same area lists applicable annotations and allows admins or coordinators to edit or delete them. Cancellation remains a separate confirmed action.

### Reports entry point

Long-term attendance charts display compact context markers without obscuring the attendance line. Selecting a chart point opens the session/date popover and offers **Add context** to admins and coordinators. Range-level notes, including school holidays, appear as a subtle shaded band with an accessible text label.

Below the chart, an **Attendance context** section contains only comparison cards that meet the sample requirements. Filters can narrow by gathering and context type. The section states that the relationships are observational.

### Missing configuration and partial coverage

Manual annotations work even when external context is unavailable.

- Missing coordinates: show `Church location is not configured`.
- Missing location country code: weather may work while public holidays show `Not configured`.
- Coordinator view: show the condition without attempting to call admin-only settings APIs.
- Admin view: include a link to Church Location settings.
- Partial provider data: render the available sources and label the missing source.
- Stale cached data: render it with its retrieval time and a stale indicator.

The context endpoint itself returns non-sensitive configuration, coverage, and freshness state so coordinators do not need access to the admin settings endpoint.

## Architecture and Component Boundaries

### Shared context service

A new `attendanceContext` service orchestrates independent units:

- **Annotation repository:** validates and queries manual, church-scoped annotations.
- **Open-Meteo adapter:** fetches and validates historical hourly or daily weather.
- **Nager.Date adapter:** fetches and validates national public holidays.
- **Christian calendar adapter:** calculates local Western/Gregorian dates.
- **Persistent context cache repository:** stores normalised provider results and freshness metadata.
- **Comparison service:** joins context with aggregate attendance and applies sample rules.

Each adapter returns typed data with two independent status fields:

- freshness: `fresh`, `stale`, or `none`;
- availability: `available`, `partial`, `unavailable`, or `not_configured`.

This permits, for example, a result to be both stale and partial without inventing a precedence rule.

An empty successful provider result remains distinguishable from a timeout, malformed response, or unsupported country.

### Routes

A thin, authenticated `reporting-context` router is separate from `/api/reports/dashboard` so external latency or failure cannot fail the core report response.

The intended route surface is:

- `GET /api/reporting-context?startDate=...&endDate=...&gatheringTypeIds=...` — structured date context, coverage, provider status, and qualifying comparisons;
- `POST /api/reporting-context/annotations` — create an annotation;
- `PATCH /api/reporting-context/annotations/:id` — edit an annotation;
- `DELETE /api/reporting-context/annotations/:id` — delete an annotation.

The read endpoint validates date-only values, church-owned gathering IDs, and a maximum 156-week range. It can return partial results. Annotation routes accept no client church ID.

### AI boundary

The existing weather and holiday helpers move out of `server/routes/ai.js`; that route may consume the shared service when appropriate. Reports never calls the AI endpoint and never requires an AI API key.

Structured weather and calendar facts may be supplied to the AI assistant under its existing explicit AI workflow. Manual annotation titles and details are excluded by default because they can contain sensitive internal context. Adding them to an external AI prompt would require a separate, disclosed consent design.

### Client boundaries

Focused client modules own:

- a reusable Context Annotation modal;
- chart markers and date/range overlays;
- a context detail popover;
- comparison cards; and
- provider status and setup messages.

Reports and Attendance share these components and API types. Context-fetch failures are contained within the contextual panel and never replace the attendance UI with a page-level error.

## Data Model

### `church_settings`

- nullable `location_country_code` constrained to an uppercase ISO alpha-2 value when present. It is distinct from the existing phone/authentication `country_code`.

### `attendance_context_annotations`

A new church-scoped table stores:

- `id` and `church_id`;
- constrained annotation type;
- required title and optional details;
- constrained scope;
- nullable gathering type ID;
- inclusive start and end date-only values;
- creator and updater user IDs; and
- created and updated timestamps.

Database checks and server validation enforce valid combinations:

- gathering/date requires a church-owned gathering and equal start/end dates;
- all-gatherings date requires no gathering and equal dates;
- all-gatherings range requires no gathering and `start_date <= end_date`.

Indexes support `(church_id, start_date, end_date)` and `(church_id, gathering_type_id, start_date)`. The gathering foreign key uses `ON DELETE CASCADE`, so deleting a gathering removes its gathering/date annotations. All-gatherings annotations are unaffected.

### `attendance_context_cache`

A persistent church-scoped cache stores canonical units:

- provider and data kind;
- location fingerprint derived from normalised coordinates, country, and timezone as applicable;
- one church-calendar date for weather or one location-country/year for public holidays;
- normalised JSON payload rather than raw provider responses;
- fetched and expiry timestamps; and
- provider-result metadata needed to distinguish valid empty, partial, and failed refreshes.

Weather uniqueness includes church, provider, location fingerprint, and date. Holiday uniqueness includes church, provider, location-country fingerprint, and year. Concurrent cold requests for the same key share one in-process single-flight refresh. Failed-attempt time and a non-sensitive error code are stored separately from the last successful payload, so a failure cannot overwrite usable stale data. Provider payloads never contain people or attendance data.

The complete tables, checks, indexes, and `church_settings.location_country_code` column are added to `server/config/schema.js` for new databases and to the additive existing-database migration path. Updating Church Location saves the token-bound location country and creates a new fingerprint; old cache rows may expire naturally but are never served for the new location. Existing phone/authentication `country_code` values are not copied automatically. An existing church with coordinates but no verified location country sees the public-holiday setup prompt until an admin reselects and saves its location.

## Cache and Provider Behavior

The context service uses persistent stale-while-revalidate behavior:

1. A fresh cache entry is returned immediately.
2. A stale entry is returned immediately, and a single-flight background refresh is started with the church ID passed explicitly. Background cache access uses `Database.setChurchContext` or `queryForChurch` and does not rely on request `AsyncLocalStorage` after the response.
3. With no cache, the context endpoint performs a bounded fetch and returns available sources; a timeout produces `unavailable` for that source rather than a route-wide failure.
4. A malformed or oversized response is rejected and cannot replace a valid stale entry.
5. A successful valid empty result is cached distinctly from a failure.

Provider calls run server-side with a five-second timeout, a two-megabyte response limit, validation of every required array and date, and a Let My People Grow user agent. Weather requests cover at most 31 calendar days per provider call; holiday requests cover exactly one country/year. Independent sources are fetched in parallel with isolated errors. Weather for the latest seven days expires after 24 hours; older historical weather expires after 90 days. Current or future-year holiday data expires after 30 days, and past-year holiday data expires after 365 days. A failed key is not retried for 15 minutes. Every response exposes `fetchedAt`, freshness, and availability. Multi-month weather requests are assembled from canonical daily cache entries rather than caching arbitrary client ranges.

Christian-calendar results are local and deterministic. Manual annotations are queried from SQLite and remain available even if every external request fails.

## Privacy, Security, and Permissions

- Admins and coordinators may read context and create, edit, or delete annotations.
- Attendance takers do not gain church-wide context or annotation permissions in version one.
- All gathering, annotation, cache, and attendance queries include the authenticated `church_id`.
- Referenced gathering and user IDs are ownership-validated before writes.
- Weather requests contain coordinates, timezone, and bounded dates only.
- Holiday requests contain location country code and year only.
- External requests never include church name, gathering name, attendance counts, people, families, caregivers, or annotation text.
- Annotation title and details are treated as potentially sensitive church data.
- Audit records contain annotation ID, type, scope, actor, and timestamps, not the free-text details. The generic request-body audit wrapper is not used for these mutations.
- Provider errors and logs omit free text and do not expose full cached payloads.

## Error Handling

- Invalid type, scope, date, range, title length, or gathering ownership returns a validation error without writing.
- An annotation edit or delete for another church behaves as not found.
- Missing location affects weather and holidays independently of manual and Christian context.
- Zero latitude or longitude is valid; only `NULL`, non-numeric, or out-of-range coordinates are rejected.
- Unsupported countries produce an explicit holiday status rather than silently falling back to another country.
- A provider timeout, HTTP error, malformed response, or cache-write failure is isolated to that source.
- Stale data remains visible with a stale label; it is never described as fresh.
- Context comparison skips sessions whose attendance aggregate is unavailable instead of treating them as zero.
- Context failure never blocks Selected period, Long-term health, Pastoral care, Attendance, or caregiver email.

## Testing Strategy

### Unit tests

- Western/Gregorian Easter calculation and Palm Sunday, Good Friday, Pentecost, and Christmas dates across representative years.
- Church-timezone interval construction around midnight and daylight-saving transitions.
- Hourly weather aggregation across start/end time and duration, plus labelled daily fallback.
- National-only public-holiday filtering, supported/unsupported country handling, and public/Christian marker deduplication.
- Annotation scope validation and inclusive date matching.
- Single-session baselines and repeated-pattern minimum sample rules.
- Fixed non-causal copy templates and exposed numerators/denominators.
- Provider validation, timeout, response-size rejection, valid-empty distinction, and partial results.
- Fresh, stale, missing, failed-refresh, and changed-location cache behavior.

### Database and API integration tests

- Cross-church isolation for annotation CRUD, cache reads, gathering IDs, and range results.
- Admin/coordinator access and attendance-taker rejection.
- Settings and onboarding persisting the token-bound location country, coordinates, and timezone atomically, including zero coordinates; tampered or expired selection tokens are rejected.
- Location updates leave the phone/authentication `country_code` unchanged, with auth and phone-formatting regression coverage.
- New-church schema creation and existing-database additive migration.
- Held/included session filtering for both standard attendance and each headcount aggregation mode.
- Manual context remains available during total provider outage.
- The core report endpoint succeeds independently of context failure.
- Audit metadata excludes annotation details.
- Outbound provider request fixtures contain no church, gathering, attendance, or person data.

### Client tests

- Attendance opens a correctly prefilled annotation modal.
- Reports chart points create date or gathering/date annotations.
- Range annotations render as accessible bands and individual annotations as markers.
- Create, edit, delete, validation, and permission behavior.
- Freshness (`fresh`, `stale`, `none`) and availability (`available`, `partial`, `unavailable`, `not_configured`) combinations.
- Admin location link versus coordinator explanatory state.
- Context-panel failure leaves core report and attendance content usable.
- Comparison cards show sample sizes and never render below their minimums.

Verification includes targeted server and client tests, client type/build validation, provider-adapter tests with no live network dependency, and regression coverage for Reports, Attendance, church location, and AI contextual questions.

## Rollout and Compatibility

The rollout is additive:

1. create annotation and cache storage for new and existing church databases;
2. update location selection to persist a verified `location_country_code` without changing the phone/authentication country;
3. extract provider adapters and serve the separate context API;
4. add manual annotation entry points;
5. add chart markers and date details;
6. enable qualifying comparison cards;
7. point optional AI contextual lookups at the shared service without making Reports depend on AI.

Existing `attendance_sessions.notes` remains untouched for compatibility and is not repurposed. Existing excluded-session behavior remains distinct. Existing AI forecasting may continue separately, but no forecast is returned to Reports under this design.

## Acceptance Criteria

- Admins and coordinators can add the approved structured context from Attendance and Reports.
- Notes support one gathering/date, all gatherings/date, or all gatherings/date-range scope.
- Ordinary annotations never alter attendance or opportunities.
- Cancellation is a separate session state and appears as generated context.
- Historical weather reflects the gathering interval when possible and is clearly labelled when only daily data exists.
- National public holidays and the common Western Christian dates appear without duplicate markers.
- School holidays and tradition-specific dates can be entered manually.
- Reports context works without AI configuration and without exposing personal attendance data to providers.
- Provider results expose independent freshness and availability states without breaking core reports.
- Repeated-pattern cards require 4 affected and 12 baseline sessions and show their sample sizes.
- No UI or service attributes an individual's absence to context or makes a causal claim.
- All annotation, cache, provider, and attendance operations remain church-isolated.
