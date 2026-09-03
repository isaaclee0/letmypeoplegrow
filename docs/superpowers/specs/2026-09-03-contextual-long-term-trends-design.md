# Contextual Long-Term Trends Design

**Date:** 3 September 2026
**Status:** Approved

## Purpose

Make long-term attendance information a natural extension of the existing Reports page. Remove the separate Long-term health and Pastoral care workspaces, eliminate the internal Primary and Other participation model from the user experience, and calculate long-term information from the gatherings the user has already selected.

The redesigned report should answer three practical questions:

1. Is attendance moving up, down, or remaining steady?
2. How regularly are the people assigned to these gatherings attending?
3. Who appears to be attending less often than usual?

## Information Architecture

Remove the report tab bar. The existing Selected period report becomes the Reports page itself and retains its gathering selector, date controls, metrics, absence information, visitor information, and exports.

Add a visually separate **Long-term trends** section below the existing period-specific results. It uses the current gathering selection but does not use the selected start and end dates.

The section begins with this explanation:

> Based on the latest 52 completed weeks, or all available attendance history when less than 52 weeks exists. The date range above does not affect these trends.

When more than one standard gathering is selected, also explain:

> Attendance at any selected gathering counts once per week.

The section contains three components, in this order:

1. Attendance direction
2. Regularity
3. People attending less often

## Gathering Selection Semantics

The existing gathering selection controls both the period report and the subject of Long-term trends.

- Selecting one gathering measures that gathering alone.
- Selecting multiple gatherings treats them as alternatives for long-term person-level calculations.
- Attendance at any selected gathering satisfies the person's attendance for that completed week.
- Multiple attendances during the same week still count once.
- Users can therefore inspect regularity for gatherings other than Sunday services by selecting those gatherings.
- The interface does not ask users to classify gatherings as Primary, Other participation, Community, or Excluded.

The gathering selector should include supporting copy that communicates the behaviour without introducing calculation terminology:

> Choose the gathering you want to report on. If you choose more than one, attendance at any selected gathering counts as attendance for that week.

## Long-Term Window

Long-term calculations use the latest 52 fully completed weeks. The current, incomplete week is excluded.

When fewer than 52 completed weeks of valid data are available, use all available completed weeks and show the actual date range and number of weeks. For example:

> Based on 31 weeks of available attendance history.

Weeks in which none of the selected gatherings was held are not opportunities and do not count against anyone.

## Population

Person-level regularity and decline calculations include active regulars who are currently assigned to at least one selected standard gathering.

Current gathering assignment is the deliberate population boundary: it establishes that the person is expected to attend one of the selected gatherings. Historical attendees who are not currently assigned are not included in tier distribution or declining-person results.

The former Primary Not assigned and Establishing population categories are not shown. A person either belongs to the selected population or does not.

## Attendance Direction

Attendance direction presents a compact rolling chart across the long-term window for the selected gatherings.

- Show gathering series separately where this helps the user distinguish their direction.
- Support standard and headcount gatherings because both provide aggregate attendance totals.
- Accompany the chart with a plain-language comparison, such as: “Average attendance is down 7% compared with the previous 12 weeks.”
- Prefer an immediately understandable comparison over exposing four-week bucket mechanics.
- Keep detailed session data available through an intentional drill-down, but do not render a long list of every plotted bucket below the chart.

When multiple gatherings are selected, the aggregate direction must not double-count the same attendance session. Person-level weekly deduplication applies to regularity and decline calculations; aggregate chart series may remain separate because they describe gathering attendance rather than unique people.

## Regularity

Regularity shows a tier distribution for the selected population. The initial tier names remain Core, Casual, and Irregular.

For each person:

- An opportunity is a completed week in which at least one selected standard gathering was held.
- The week is attended when the person attended any selected standard gathering.
- The person's rate is attended weeks divided by opportunity weeks.
- The exact rate is classified using the configured thresholds.

The distribution shows a compact chart and labelled counts. Each tier count opens a sortable list of people and their plain attendance evidence.

Administrators retain a **Regularity settings** action within this component. It permits changes to:

- Core and Casual minimum percentages
- Tier labels
- Tier colours

It does not contain gathering roles or assignment previews. Settings remain church-scoped and apply consistently whenever contextual regularity is calculated.

## People Attending Less Often

This component is a compact exception list, not a case-management workflow.

- Show the first 5–10 people with the strongest meaningful recent decline.
- Order results by the strength and pastoral relevance of the change, using a deterministic server-side ordering.
- Describe evidence in ordinary language, such as: “Usually attends 3 weeks in 4; attended 1 of the last 6 weeks.”
- Clicking a person opens their attendance history for the selected gatherings.
- Show **View all** when additional results exist.
- Do not expose established/candidate states, movement axes, confirmation weeks, evidence counters, or progress terminology.

The decline calculation must compare a recent completed period with a sufficiently established earlier baseline inside the available long-term window. The implementation plan must retain or adapt the existing safeguards against reacting to one incomplete or anomalous week, while presenting only the factual comparison to users.

## Headcount and Mixed Selections

Headcount gatherings can contribute to Attendance direction but cannot contribute to person-level Regularity or People attending less often because they do not identify attendees.

- With only headcount gatherings selected, show Attendance direction and explain that person-level trends require a standard attendance gathering.
- With a mixed selection, Attendance direction may include all selected gatherings. Regularity and declining-person calculations use only the selected standard gatherings and their assigned population.
- Supporting copy must identify this distinction without presenting it as an error.

## Removed Experience

Remove these elements from the Reports interface:

- Selected period, Long-term health, and Pastoral care tabs
- The separate Long-term health page composition
- The separate Pastoral care queue
- Primary and Other participation terminology
- Permanent gathering-role configuration
- Primary by Other participation matrix
- Coverage card and legacy-roster diagnostics
- Long-term visitor journey
- Permanent Not assigned and Establishing groups
- Tier movement axis and confirmation-stage interfaces

The pastoral follow-up workflow is outside the scope of this redesign. If case assignment, snoozing, dismissal, and resolution remain desirable, they should later be reconsidered as a dedicated Follow-up product area rather than a report.

## Data and API Shape

The Reports page owns the selected gathering IDs and passes them to the Long-term trends component. Long-term requests include those IDs explicitly. The server must validate that every requested gathering belongs to the authenticated church and run all queries inside that church's database context.

The long-term response should be scoped to:

- church ID
- sorted selected gathering IDs
- completed-window start and end
- active regular population
- attendance direction series
- regularity distribution and drill-down tokens
- compact decline results and pagination metadata
- tier settings
- data-availability metadata

Client caching must include the church ID and canonical sorted gathering selection in its cache key. Changing churches or selected gatherings must never display another selection's long-term result as current data.

Existing engagement database fields may remain unused initially. Avoid a destructive schema migration in this change. Obsolete APIs, tables, and columns may be removed later after all runtime references have been eliminated and the data-retention impact has been reviewed.

## Loading, Errors, and Data Confidence

- Show cached data immediately when it matches both the church and gathering selection, then refresh it in the background.
- When refresh fails and matching cached data exists, label it as saved data.
- When no matching cached data exists, show a local error with a retry action without breaking the selected-period report above it.
- Abort or ignore stale responses after the church or gathering selection changes.
- Exclude weeks whose person-level roster history is not reliable rather than treating unknown attendance as absence.
- Do not show a dedicated diagnostics card. Show a quiet methodology note only when exclusions materially reduce confidence in the result.
- Empty results should explain the cause: no selected gatherings, no selected standard gatherings, no assigned active regulars, or insufficient completed attendance history.

## Accessibility and Interaction

- Preserve semantic headings and labelled regions for each component.
- Do not make text look clickable unless it opens a visible result.
- Tier and decline drill-downs must move focus to their heading and return focus to the triggering control when closed.
- Charts require adjacent textual summaries; colour cannot be the only tier or trend signal.
- Loading and refresh errors use appropriate status and alert semantics.

## Testing

Backend and frontend tests must cover:

- A single selected standard gathering
- Multiple selected standard gatherings treated as weekly alternatives
- Weekly deduplication when a person attends more than one selected gathering
- Exclusion of weeks with no held selected gathering
- Current-assignment population filtering
- Church isolation and rejection of foreign gathering IDs
- The full 52-week window and shorter available histories
- Exclusion of the incomplete current week
- Headcount-only and mixed standard/headcount selections
- Configurable tier labels, colours, and thresholds
- Plain-language decline evidence and deterministic ordering
- Drill-down and View all behaviour
- Cache keys and stale-response handling across selection and church changes
- Removal of the old report tabs and Primary/Other participation terminology
- Continued operation of the existing date-scoped report and export flows

## Success Criteria

The redesign is successful when an administrator can select one or more gatherings and understand long-term direction, regularity, and potential attendance decline without configuring gathering roles or learning internal engagement terminology. The page should foreground information that supports interpretation or follow-up and keep methodology subordinate to those decisions.
