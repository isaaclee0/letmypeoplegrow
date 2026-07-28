# Caregiver Email Absence Periods Design

## Goal

Make weekly caregiver digest absence streaks mean the same thing as the Reports page: consecutive reporting periods in which a regular attended none of the relevant standard gatherings.

For Kingston CRC, missing both the AM and PM gathering on each of three Sundays must produce a streak of 3, not 6. Attending either gathering in the latest Sunday period must end the absence streak.

## Current Problem

The Reports page groups selected gathering sessions into frequency-sized periods. Within each period, a person is present if they attended any selected gathering, and absent only if they attended none.

The caregiver digest instead loads the last 12 standard sessions across the church and walks them one by one. A church with AM and PM gatherings therefore records two absences per Sunday. The email presents this session count as an "in a row" absence streak, so three missed Sundays can appear as `6+`.

Family grouping is not adding different family members' streaks together. Each member is independently over-counted because the email counts sessions rather than periods; the family headline uses the minimum of those independently calculated streaks.

## Chosen Design

### Shared server-side period calculation

Add a focused server utility for period-based absence calculation. It will use the same rules as the Reports page:

- Convert each gathering frequency to a period size: weekly = 7 days, biweekly = 14 days, monthly = 30 days.
- Use the shortest frequency among the relevant gatherings.
- Sort session dates newest first.
- Anchor the newest period at the newest date, grouping older dates into it until their distance from the anchor reaches the period size.
- Within a period, a person is present if any attendance record for any relevant session has `present = 1`.
- Count consecutive absent periods from newest to oldest and stop at the first present period.
- An explicit absence and a missing attendance record both mean not present, matching the existing Reports and caregiver-email behavior.

The utility will be independent of database access and email rendering. It will accept sessions, attendance rows, and individual IDs, then return one streak per individual. This keeps the behavior directly testable and gives future server-side consumers one implementation to reuse.

### Caregiver digest integration

The caregiver digest will:

1. Load the most recent relevant standard sessions together with each gathering's frequency.
2. Preserve the existing church scope and `excluded_from_stats = 0` filter.
3. Calculate period-based streaks through the shared utility.
4. Apply the existing caregiver threshold to the resulting period counts.
5. Preserve current caregiver assignment, family grouping, last-present history, sorting, and email delivery behavior.

All active standard gatherings are the email's relevant gathering set. This is equivalent to selecting all standard gatherings on the Reports page. Attendance at either an AM or PM gathering within the same weekly period counts as attendance for that period.

The database query must load enough sessions to represent the latest 12 periods, rather than limiting the combined session stream to 12 rows. The implementation may load the latest 12 sessions per active standard gathering, then let the utility form at most 12 periods. This preserves the current maximum lookback while avoiding a shorter lookback at churches with multiple gatherings.

### Email presentation

The existing number and "in a row" treatment will remain, but the number will now represent consecutive absent periods. Individual detail will continue to say "consecutive absences." Family headlines will continue to use the minimum member streak and append `+`, meaning every listed absent family member has missed at least that many consecutive periods.

No email will be sent while testing this change.

## Edge Cases

- Multiple gatherings on the same date belong to the same period.
- Gatherings on different days within the same shortest-frequency window belong to the same period.
- Attending any relevant gathering in a period marks that period present.
- A person with no attendance row in a relevant session is treated as not present for that session.
- Excluded sessions and headcount gatherings do not participate.
- If there are no standard sessions, no caregiver digest entries are generated.
- Weekly-only churches retain one period per weekly session and therefore keep their current counts.
- Mixed frequencies use the shortest selected frequency, exactly as Reports does.

## Testing

Add focused unit tests for the pure period calculator before implementation:

1. Two weekly gatherings across three Sundays, absent from every session, produce a streak of 3 rather than 6.
2. Attendance at either gathering in the newest weekly period produces a streak of 0.
3. Attendance at either gathering in the preceding period stops a newer absence streak at 1.
4. A single weekly gathering retains ordinary consecutive-session behavior.
5. Missing attendance rows count as not present.

Add a caregiver-digest database integration test that creates two weekly standard gatherings and verifies that the generated digest exposes the period-based streak. The test must generate data only; it must not call an email sender.

Run the focused tests, the existing weekly-review tests, and the complete server test suite before completion.

## Non-Goals

- Changing the Reports page UI or its client-side period behavior.
- Changing caregiver assignments or absence thresholds.
- Changing which family members are grouped in one digest card.
- Changing attendance records or restored church data.
- Sending test emails or SMS messages.
