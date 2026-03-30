# Weekly Review Email: Follow-Up & Visitor Sections

## Goal

Add two new sections to the weekly review email: a "People to Follow Up With" list showing regulars who recently disengaged, and a "This Week's Visitors" list categorizing local visitors as first-time or returning, with a prompt to reach out before Wednesday.

## Context

The weekly review email already contains gathering cards, a weekly total, and an optional AI insight. These two new sections add actionable people-level data between the totals and the AI insight.

Pipeline: `weeklyReview.js` (data) -> `weeklyReviewInsight.js` (AI) -> `email.js` (send) -> `weeklyReviewScheduler.js` (cron)

## Section 1: People to Follow Up With

### Data Query

- Look at the last 6 weeks of attendance data (relative to the review week's end date).
- Find individuals where `people_type = 'regular'` who:
  - Were **absent for the most recent 3 weeks** (no attendance records marked present).
  - Were **present at least once in the 3 weeks before that** (weeks 4-6).
- This identifies people who **newly** entered the "missed 3 weeks" category — not long-absent members.
- Include which gathering(s) they used to attend (based on their attendance in weeks 4-6).
- Cap at **5 people**. If more than 5 qualify, show 5 and note "and X more".
- If nobody qualifies, **omit the section entirely**.
- Only applies to gatherings with `attendance_type = 'standard'` (headcount-only churches have no individual data).

### Display

- Heading: "🔔 People to Follow Up With"
- Each person shown as: `First Last — used to attend [Gathering Name(s)]`
- Footer link: "View all in Reports →" pointing to `/app/reports`

### Visual Style

- White card with purple left border (matching gathering card style).
- Heading uses Montserrat, body uses Lato.
- Purple text accents consistent with brand (#7c3aed).

## Section 2: This Week's Visitors

### Data Query

- Pull all individuals with `people_type = 'local_visitor'` who have an attendance record marked present this week.
- Categorize each visitor:
  - **First-time**: No attendance records marked present before this week.
  - **Returning**: At least one attendance record marked present before this week.
- Include which gathering they attended this week.
- If no local visitors this week, **omit the section entirely**.

### Display

- Heading: "👋 This Week's Visitors"
- Two sub-groups:
  - "First-time" with list of names and gathering attended
  - "Returning" with list of names and gathering attended
- If either sub-group is empty, omit that sub-group (not the whole section).
- Motivational prompt at bottom: "Research shows that visitors are more likely to return when someone other than the pastor reaches out before Wednesday."
- No cap on visitor list (visitor counts per week are typically small).

### Visual Style

- White card with purple left border (matching gathering card style).
- Same typography as Section 1.
- Motivational prompt in italic, slightly lighter text.

## Email Layout Order

1. Purple header with church name
2. Gathering cards (per-gathering stats)
3. Weekly total box (purple bg)
4. 🔔 People to Follow Up With (if any)
5. 👋 This Week's Visitors (if any)
6. ✨ AI Insight (if enabled)
7. Footer

## Implementation Scope

### Files to Modify

- `server/services/weeklyReview.js` — Add two new data functions (`getNewlyDisengaged`, `getWeeklyVisitorBreakdown`) and include their results in `generateWeeklyReviewData` return object.
- `server/utils/email.js` — Add HTML rendering for both new sections in `sendWeeklyReviewEmail`.

### Files NOT Modified

- `weeklyReviewInsight.js` — AI insight context already has engagement and visitor data; no changes needed.
- `weeklyReviewScheduler.js` — No changes; it already passes the full `reviewData` to `sendWeeklyReviewEmail`.
- Client code — No frontend changes; these are email-only sections.

## Data Shape

```js
// Added to generateWeeklyReviewData return object:

followUpPeople: [
  {
    firstName: 'Jane',
    lastName: 'Smith',
    gatherings: ['Sunday Service', 'Wednesday Bible Study']
  },
  // ... up to 5
],
followUpTotal: 7,  // total count (if more than 5)

weeklyVisitors: {
  firstTime: [
    { firstName: 'Tom', lastName: 'Jones', gatherings: ['Sunday Service'] }
  ],
  returning: [
    { firstName: 'Sarah', lastName: 'Lee', gatherings: ['Sunday Service', 'Wednesday Bible Study'] }
  ]
}
```

## Section 3: Getting Started Encouragement (New Churches)

When a church has fewer than 3 weeks of attendance data (same threshold used by `meetsMinimumThresholds` in the insight system), the follow-up and visitor sections won't have meaningful data. Instead of showing nothing, display a warm encouragement section.

### Logic

- Show this section **only when** `weeklyTotals.length < 3`.
- When this section is shown, **omit** the follow-up and visitor sections (they need more data).
- Pull simple stats from the review data to praise progress: number of gatherings set up, number of people added, weeks of attendance tracked so far.

### Display

- Heading: "🌱 Your Church is Growing"
- Body: A warm, encouraging message that acknowledges what they've done so far (e.g., "You've set up X gatherings and added Y people — great start!") and lets them know that more insights will unlock as they track attendance over the coming weeks.
- Tone: Celebratory and forward-looking, not patronizing.

### Visual Style

- Same white card with purple left border as other sections.
- Same typography (Montserrat heading, Lato body).

### Data Shape

```js
// Added to generateWeeklyReviewData return object:

gettingStarted: {
  gatheringCount: 3,      // number of gathering types set up
  peopleCount: 45,         // number of active individuals
  weeksTracked: 2          // length of weeklyTotals
} // null if weeklyTotals.length >= 3
```

## Email Layout Order (Updated)

1. Purple header with church name
2. Gathering cards (per-gathering stats)
3. Weekly total box (purple bg)
4. 🌱 Getting Started (if new church, < 3 weeks) — **OR** sections 5-6 below
5. 🔔 People to Follow Up With (if any, and church has 3+ weeks)
6. 👋 This Week's Visitors (if any)
7. ✨ AI Insight (if enabled, and church has 3+ weeks)
8. Footer

## Edge Cases

- **Headcount-only churches**: No individual attendance data. Follow-up and visitor sections omitted (no data to query). Getting started section still shows if < 3 weeks.
- **New churches with < 3 weeks of data**: Show getting started encouragement. Follow-up, visitor, and AI insight sections omitted.
- **Person attends multiple gatherings**: List all gatherings they used to attend in the follow-up section; for visitors, list all gatherings they attended this week.
- **Deactivated individuals**: Exclude deactivated people (`is_active = 0` or equivalent) from both queries.
