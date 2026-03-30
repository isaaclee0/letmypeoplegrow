# Weekly Review AI Insight — Enriched Design

## Problem

The current weekly review AI insight narrates aggregate numbers ("attendance was up 12%"). This is the same thing the algorithmic fallback does. The AI adds no value beyond what a simple comparison can produce.

## Goal

Generate a single, sharp, pastoral insight (2-3 sentences) that surfaces a pattern a human would miss or wouldn't bother to calculate. The AI picks the most noteworthy observation from multiple categories each week.

## Scope: Standard Gatherings Only

Categories 1, 3 (individual movement), and 4 rely on individual-level `attendance_records`. Headcount-mode gatherings have no individual records — only aggregate counts. These categories only process standard-mode gatherings. Headcount gatherings still appear in the per-gathering trend lines and weekly totals.

If a church runs only headcount gatherings, the enriched categories will be empty and the system falls back to the algorithmic insight (see Minimum Data Thresholds below).

## Insight Categories

The AI receives data from four categories and chooses the single most actionable one:

### 1. Regulars with changed engagement patterns

Query attendance over the last 8 weeks for individuals where `people_type = 'regular'` AND `is_active = 1` AND has at least one attendance record in the last 12 weeks (to filter out long-inactive members). Flag:

- **Disengaging**: attended consistently but missed the last 2+ weeks (unusual for them)
- **Re-engaging**: was sporadic but attended the last 3+ weeks consistently
- **Family-level drift**: entire family absent together (more significant than one member missing)

Group by family where `family_id` is not null. Individuals without a family appear as standalone entries (e.g. "Person 3" rather than "Family X").

### 2. Local visitor retention

- Count new local visitors in the last 4 weeks (first appearance in `attendance_records` falls within window)
- Count how many returned for a 2nd+ visit
- Calculate return rate, compare to prior 4-week window
- Flag local visitors with 3+ visits as strong integration candidates

**Traveller visitors are excluded entirely.** They are passing through and not expected to return. Their non-return is not a retention problem.

### 3. Cross-gathering trends

- Per-gathering trend direction over 8 weeks (growing/shrinking/stable) — applies to both standard and headcount gatherings
- For standard gatherings only: individuals or families appearing in one gathering but absent from another they previously attended in the last 8 weeks (minimum 2 prior attendances to count as "previously attended")

### 4. Family-level attendance

- Aggregate attendance by family (families with `family_id` set)
- Spot families where only some members attend (partial attendance) vs whole-family absence
- Identify newly consistent families
- Individuals without families are excluded from this category (they appear in Category 1 instead)

## Obfuscation and Rehydration

The AI never sees real names.

### Before API call

Build a mapping from query results:

```
{
  "Family A": "Mackie",
  "Family B": "Adler",
  "Person 1": "Sol Mackie",
  "Person 2": "Oliver Woodward",
  ...
}
```

Only people/families mentioned in the context data get mapped. The mapping is built fresh each week.

Use delimited identifiers: `[Family-A]`, `[Person-1]` etc. The delimiters prevent partial-match collisions (e.g. `[Family-A]` won't match inside `[Family-A1]`) and are unlikely to appear in natural AI output.

Replace all names in the context with their delimited identifiers before sending to the API.

### After API response

Replace all delimited identifiers in the response with real names in a **single pass** (e.g. build a regex matching all known identifiers and replace via callback) to avoid rehydrated text being matched by subsequent replacements.

**Post-rehydration validation:** After replacement, scan the output for any remaining `[Family-` or `[Person-` tokens. If found, strip them (replace with "a family" / "someone") rather than showing broken identifiers in the email.

## Prompt Design

### System prompt

```
You are an attendance analyst for a church. Given this week's data, provide ONE brief, actionable insight (2-3 sentences). Pick the single most noteworthy pattern from: engagement changes among regulars, local visitor retention, cross-gathering trends, or family attendance shifts. Be warm and pastoral in tone. Do not use markdown formatting. Local visitors are people the church hopes will return and integrate. Traveller visitors are passing through and not expected to return — do not flag their non-return as a problem.
```

### User message (context)

Structured plain text with anonymised identifiers:

```
Church: [anonymised or omitted]
Week: 2026-03-17 to 2026-03-23

This week's gatherings:
Sunday Service: 45 attendees (up 5% vs 3-week avg of 43), 2 local visitors
Youth Group: 18 attendees (up 12% vs avg 16), 0 visitors

Regulars with changed patterns (last 8 weeks):
- Family A (3 members): attended 7/8 weeks, missed last 2 weeks
- Person 1 (Family B): dropped from 6/8 to 1/4 in recent weeks
- Person 2: newly consistent — 5 straight weeks after sporadic prior attendance

Local visitor retention (last 4 weeks):
- 4 new local visitors, 1 returned for 2nd+ visit (25% return rate)
- Prior 4-week return rate was 40%
- Person 3: visited 3 times in last month (strong integration candidate)

Cross-gathering patterns:
- Sunday Service: stable (avg 44 over 8 weeks)
- Youth Group: growing (avg 14 → 18 over 8 weeks)

Weekly totals (last 8 weeks):
Week of Feb 3: 55, Week of Feb 10: 58, Week of Feb 17: 52, Week of Feb 24: 60,
Week of Mar 3: 58, Week of Mar 10: 61, Week of Mar 17: 63, Week of Mar 24: 63
```

### Model

`claude-haiku-4-5-20251001` — fast, cheap, sufficient for 2-3 sentence generation with structured input.

`max_tokens: 150` — comfortable room for 2-3 sentences with anonymised identifiers.

## Context Size Limits

To keep token cost bounded and avoid overwhelming the model:

- **Category 1 (engagement changes):** Top 5 most significant changes, sorted by severity (longest streak broken first, then largest attendance rate drop)
- **Category 2 (visitor retention):** Aggregate stats + top 3 integration candidates
- **Category 3 (cross-gathering):** All active gatherings (trend line per gathering) + top 3 individual cross-gathering shifts
- **Category 4 (family attendance):** Top 5 most noteworthy family patterns

This caps the context at roughly 400-600 tokens input for a typical church. At Haiku pricing, that's well under $0.01 per church per week.

## Minimum Data Thresholds

Fall back to the algorithmic insight (no API call) when:

- Fewer than 3 weeks of attendance data exist (not enough for trend detection)
- No standard-mode gatherings exist (all headcount — no individual-level data)
- All four enriched categories return empty results
- The total enriched context would be fewer than 3 data points across all categories

## Files Changed

### `server/services/weeklyReview.js`

Add four new query functions called from `generateWeeklyReviewData()`:

- `getRegularEngagementChanges(churchId, startDate)` — 8-week per-person attendance, grouped by family, flagging disengaging/re-engaging
- `getLocalVisitorRetention(churchId)` — 4-week new local visitor count, return count, rate, comparison to prior window
- `getCrossGatheringTrends(churchId, startDate)` — per-gathering 8-week trend with direction
- `getFamilyAttendancePatterns(churchId, startDate)` — family-level aggregation

Also update the existing per-gathering visitor count query to split `local_visitor` and `traveller_visitor` counts separately. Only `local_visitor` counts appear in the AI context.

Return these as additional fields on the review data object.

### `server/services/weeklyReviewInsight.js`

- New `buildObfuscationMap(reviewData)` — creates anonymised identifier mapping
- Updated `buildContext(reviewData)` — includes all four data categories, uses anonymised identifiers
- New `rehydrateNames(text, nameMap)` — replaces identifiers with real names post-response
- Updated system prompt
- Updated `generateInsight()` to run obfuscation → API call → rehydration

## Algorithmic fallback

The existing `generateAlgorithmicInsight()` remains unchanged. It activates when:

- `PLATFORM_ANTHROPIC_API_KEY` is not set
- The API call fails (network error, rate limit, model error, timeout)
- Minimum data thresholds are not met (see above)

It only has access to aggregate weekly totals and produces a simple up/down/steady message.

## What this does NOT change

- Email template layout
- Email sending logic
- Scheduler/cron logic
- Church settings for weekly review
- The aggregate stats section of the email (gathering counts, deltas)
