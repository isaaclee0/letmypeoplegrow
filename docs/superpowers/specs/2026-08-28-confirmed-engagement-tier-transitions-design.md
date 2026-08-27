# Confirmed Engagement Tier Transitions

**Date:** 2026-08-28
**Status:** Approved design
**Scope:** Replace threshold-only movement in Long-term health with evidence-confirmed tier transitions for Primary and Other participation

## Summary

An attendance percentage crossing a tier boundary does not, by itself, demonstrate a changed habit. A single attendance can move a person from 59% to 61% and immediately change their label even though their underlying pattern is essentially unchanged.

The report will therefore distinguish between:

- the person's rolling 52-week percentage and the tier it currently suggests;
- their durable **established tier**; and
- a **candidate tier** being tested against new attendance opportunities after the boundary crossing.

A candidate becomes established only when at least eight reliable opportunities occur within a 13-completed-week confirmation attempt and those new results support the candidate tier. The same rule applies upward and downward, independently, to Primary and Other participation.

The existing four-week-shifted, overlapping 52-week Higher/Lower comparison will be removed from Long-term health. Immediate absence detection remains separate. A confirmed downward Primary transition continues into the existing pastoral decline workflow.

## Goals

- Treat tiers as statements about demonstrated participation habits rather than fragile threshold results.
- Prevent one attendance or absence from immediately recategorising a person.
- Preserve the 52-week rate as the long-term measurement.
- Confirm changes using only new evidence collected after a boundary crossing.
- Apply identical confirmation rules to upward and downward movement and to both person-level axes.
- Keep immediate absence handling independent from long-term tier confirmation.
- Give users a compact view of active confirmations without filling the report with stable people.
- Preserve church isolation, reliable-roster rules, threshold customisation, and weekly idempotency.

## Non-goals

- Replacing immediate or consecutive-absence detection.
- Predicting why attendance changed.
- Using historical periods older than the existing engagement source window.
- Creating tiers for headcount gatherings.
- Allowing different confirmation lengths or evidence minimums per church in this version.
- Reconstructing confirmation attempts that occurred before this model was enabled.
- Renaming internal database role keys as part of the terminology change.

## User-facing Terminology

The report and settings UI use these labels:

- **Primary:** the church's main gathering commitment.
- **Other participation:** separately measured participation outside Primary, such as youth, a small group, a ministry team, or another gathering pattern.
- **Excluded:** attendance retained in ordinary reporting but omitted from engagement tiers.

Existing internal role keys remain `primary`, `community`, and `other`. In user-facing copy, `community` is rendered as **Other participation**, and the existing excluded `other` role is rendered as **Excluded**. Keeping the internal keys avoids a risky data migration and does not expose the old terminology through the API UI contract.

## Tier Concepts

### Calculated profile

The opportunity engine continues to calculate a rolling 52-completed-week rate using the church's configured thresholds. This produces a **calculated tier** when there are at least eight reliable opportunities.

The calculated profile remains evidence, not necessarily the person's displayed tier.

### Established tier

The established tier is the durable classification shown in distributions, matrices, people lists, and ordinary tier badges. It changes only after a confirmation succeeds.

`Establishing` and `Not assigned` remain states rather than tiers. They cannot be established tiers and cannot start confirmation attempts.

### Candidate tier

When the calculated 52-week tier differs from the established tier, it becomes a candidate. The candidate records the direction and target of a possible transition while the established tier remains unchanged.

The report may describe this as **Confirming higher** or **Confirming lower**. It must not describe an unconfirmed candidate as a completed tier change.

## Confirmation Rules

Confirmation is evaluated once for each fully completed church week.

1. A candidate starts when the calculated 52-week tier first differs from the established tier.
2. The candidate's confirmation evidence begins after that completed-week boundary. Evidence already responsible for crossing the threshold cannot confirm the change.
3. Only reliable opportunities on the candidate's axis count.
4. A confirmation attempt covers at most 13 completed church weeks.
5. Confirmation may succeed as soon as at least eight reliable opportunities have occurred during the attempt.
6. The church's existing Core and Casual thresholds classify the attempt evidence.
7. The attempt confirms when its evidence supports the candidate tier or a tier further in the same direction from the established tier.
8. On confirmation, the candidate becomes the new established tier and a factual transition is recorded.

Evidence further in the same direction confirms the candidate target; it does not silently establish a tier that the 52-week profile has not reached. If the calculated 52-week target itself changes before confirmation, the restart rule below applies.

For example, an established Casual person whose 52-week rate reaches Core begins a Casual-to-Core candidate. If eight subsequent reliable opportunities contain five attendances under the default 60% Core threshold, the transition confirms. The attendance that originally pushed the 52-week rate across 60% is not part of those eight opportunities.

### Candidate cancellation and restart

- If the calculated tier returns to the established tier, the candidate is cancelled.
- If the calculated tier reaches a different target tier, the old candidate is cancelled and a fresh attempt starts for the new target. Its evidence begins again from zero.
- If 13 completed weeks expire without at least eight opportunities or without supporting evidence, the attempt ends without changing the established tier.
- If the calculated tier still differs after an unsuccessful attempt, the following weekly evaluation may start a new 13-week attempt. This allows a later genuine habit to be recognised without treating the earlier unsupported crossing as confirmed.
- Losing the current active assignment, becoming inactive, returning to `Establishing`, or becoming `Not assigned` cancels the candidate.

Direct Core-to-Irregular and Irregular-to-Core transitions are allowed. Their confirmation evidence must support the further target tier; evidence that supports only the intermediate tier does not confirm the direct transition.

## Baselines and Configuration Changes

The first evaluation after activation establishes each currently classified calculated tier as the person's established baseline on that axis. It creates no candidate, transition, pastoral event, or notification.

Changing a threshold or gathering role increments the existing calculation-rules version. The next evaluation is baseline-only for that new version:

- existing candidates are cancelled;
- calculated classified tiers become fresh established tiers;
- no changes are inferred across rules versions; and
- no pastoral events or notifications are created from administrative recalculation.

The settings save flow requests this baseline evaluation immediately. If it cannot complete, reports may show calculated tiers as a clearly marked baseline-pending fallback, and the weekly evaluator retries. Merely opening a report never creates or advances a confirmation attempt.

Reassignment after `Not assigned` or `Establishing` also creates a baseline when sufficient reliable evidence exists; it is not presented as a tier transition.

## Opportunity Semantics

The existing reliability and opportunity rules remain authoritative:

- Primary creates at most one opportunity per person per church week, even when alternative Primary services are available.
- Other participation uses its existing individually tracked opportunity semantics.
- Open, cancelled, excluded-from-statistics, headcount-only, unknown-provenance, or otherwise unreliable sessions do not contribute.
- The evidence stores numerator, denominator, and rate; percentage alone is never shown without its opportunity count.

The existing 56-completed-week source query is sufficient. Confirmation is forward-looking and lasts at most 13 weeks, so it does not require Kingston or another church to possess older history.

## State and History

### Tier state

A new church-scoped tier-state table holds one row per active person and axis. It records:

- church ID and individual ID;
- axis (`primary` or internal `community`);
- calculation-rules version;
- established tier;
- candidate tier, direction, start week, and final eligible week when active;
- last evaluated completed-week end; and
- created and updated timestamps.

The primary key is church, individual, and axis. Foreign keys and all reads and writes retain explicit church scoping.

Confirmation counts are derived from reliable dated opportunities within the active attempt rather than treated as an independently editable total. This keeps corrected attendance and cancelled sessions reflected in the next evaluation.

### Transition history

A factual transition-history table records every confirmed move on either axis. Each row includes:

- church, person, and axis;
- from and to internal tiers;
- candidate start and confirmation week;
- calculation-rules version;
- 52-week attended, opportunity, and rate evidence at confirmation;
- confirmation-period attended, opportunity, and rate evidence; and
- downstream pastoral-processing state and an optional linked decline-event ID for Primary transitions; and
- creation timestamp.

The uniqueness key is church, person, axis, from tier, to tier, confirmation week, and rules version. It prevents duplicate transitions when a weekly run retries. Transition history supplies the **Confirmed recently** list for the latest 13 completed weeks and provides an audit trail independent of pastoral workflow state. Downstream processing selects durable unprocessed transitions, so a failure between tier confirmation and pastoral work cannot lose an event or create a duplicate on retry.

The existing `engagement_evaluation_state` remains in place for compatibility during migration but no longer decides whether a raw threshold crossing is a confirmed tier transition. Destructive removal is outside this change.

## Weekly Evaluation Flow

For each church, the weekly engagement job:

1. loads settings, people, assignments, reliable sessions, and dated opportunities in bulk;
2. calculates the current 52-week profiles;
3. loads tier state for all current people and both axes;
4. baselines, starts, advances, cancels, expires, or confirms candidates deterministically;
5. writes tier states and confirmed transition history transactionally; and
6. passes newly confirmed downward Primary transitions to the existing decline-event workflow.

The evaluator performs bounded queries rather than one query per person or gathering. Re-running the same completed week produces no duplicate attempt progress, transition, decline event, or caregiver delivery.

If a run fails before its transaction commits, no partial tier progression is visible. A later retry recomputes from factual attendance. If tier confirmation commits but downstream pastoral processing fails, the unprocessed confirmed Primary transition remains available for idempotent retry.

## Pastoral Integration

Only confirmed downward Primary transitions create factual engagement decline events. Other participation changes never create caregiver deliveries.

For a confirmed downward Primary transition:

- the decline event's from/to tiers come from the established transition;
- its effective week is the confirmation week;
- its evidence includes both the 52-week profile and the confirmation-period facts; and
- existing caregiver recipient selection, delivery retry, snooze, dismissal, recovery, and church-isolation behaviour remains unchanged.

A confirmed upward Primary transition resolves applicable unrecovered decline episodes using the existing recovery rules. Raw 52-week movement and active candidates do not create or resolve pastoral events.

Immediate and consecutive-absence signals continue independently, so pastoral users may still see a recent absence concern while the person's long-term tier remains under confirmation.

## Long-term Health UI

The approved layout keeps the report compact.

### Established distributions

Primary distribution, matrix cells, and ordinary people drilldowns use established tiers. Where a baseline has not yet been persisted, the UI labels calculated fallback data rather than implying confirmation state exists.

### Recent tier movement

The existing overlapping 52-week Higher, Unchanged, Lower, and Not comparable cards are removed. The replacement section contains:

- a compact Primary / Other participation switch;
- **Confirming higher** count;
- **Confirming lower** count; and
- **Confirmed recently** count, covering the latest 13 completed weeks.

Clicking a count expands a compact sortable table beneath the section rather than opening a modal. Pending rows contain:

- person;
- established tier and candidate tier;
- observed reliable opportunities toward the minimum of eight;
- attended count and current confirmation rate; and
- current week within the 13-week attempt.

Example:

```text
Hetty Albion | Casual -> Core | 6/8 opportunities observed | 4 attended (67%) | week 7 of 13
```

Confirmed rows show the from/to tiers, axis, confirmation week, and both evidence summaries. Stable people do not occupy this movement section.

All terminology, legends, table headings, tier badges, empty states, and settings descriptions use **Other participation** and **Excluded**. Colour remains supplementary to text, and dark-mode contrast must match the rest of the revised report.

## API Shape

The engagement overview adds established distributions and movement-confirmation counts for each axis. Token-based drilldowns continue to prevent large overview payloads.

People drilldown rows distinguish:

- established profiles;
- active confirmation attempts; and
- confirmed transition history.

Each confirmation response includes explicit axis, tier, opportunity, attendance, rate, start-week, current-week, and final-week fields. The client does not infer confirmation status from formatted text or recalculate thresholds.

Old four-week movement tokens are retired rather than silently changing meaning. Cached overview schema versioning invalidates responses produced under the prior movement model.

## Failure and Empty States

- No persisted state yet: show a baseline-pending explanation and calculated 52-week fallback; show no movement claim.
- Fewer than eight total reliable opportunities: retain `Establishing`; no candidate.
- Fewer than eight confirmation opportunities: show progress and retain the established tier.
- Confirmation attempt expired: omit it from active confirmation after the evaluator closes it; a later attempt may begin.
- No active confirmations: state that no tier changes are currently gathering evidence.
- Evaluation refresh failure with valid cached data: retain the existing saved-data warning and never merge state from another church.
- Rules-version mismatch: fail closed to baseline-pending rather than combining established state and thresholds from different versions.

## Testing and Verification

### Calculation and state-machine tests

- one attendance crosses a 52-week boundary but does not confirm itself;
- eight later opportunities confirm upward and downward movement at exact threshold boundaries;
- evidence below the candidate threshold does not confirm;
- evidence further in the same direction confirms;
- direct two-tier movement requires the further tier;
- candidate cancellation when the calculated tier returns;
- candidate restart when its target changes;
- expiry for insufficient opportunities and unsupported evidence;
- a new attempt after unsuccessful expiry;
- both Primary and Other participation axes;
- `Establishing`, `Not assigned`, inactive, and reassigned people;
- corrected attendance, cancelled sessions, alternative Primary services, and unreliable provenance;
- rules-version baseline behaviour; and
- idempotent repeated and concurrent weekly evaluation.

### Persistence and isolation tests

- church-scoped state, transitions, and drilldowns;
- schema upgrades on existing church databases;
- foreign-key behaviour for archive, merge, and deletion workflows;
- bounded query counts on representative large data; and
- no partial state after transaction failure.

### Pastoral tests

- no event from a raw or pending downward crossing;
- one event and fixed detection-time recipients after confirmed Primary decline;
- no event from Other participation movement;
- confirmed Primary recovery resolves the correct episode;
- deeper confirmed decline creates the correct next transition; and
- failed downstream processing retries from durable transition history without duplication.

### Client tests

- established distributions and matrix use established tiers;
- Primary / Other participation switching;
- confirmation counts and compact inline tables;
- sortable names and evidence;
- baseline-pending, insufficient-evidence, empty, cached, and error states;
- terminology contains no user-facing Community role or ambiguous excluded Other role;
- accessible labels do not rely on colour; and
- light and dark mode contrast.

Focused server and client suites, production client build, schema integration tests, query-count verification, and the existing engagement/pastoral regression matrix must pass before deployment.

## Rollout

1. Apply additive schema changes.
2. Enable baseline-only evaluation for each church under its current rules version.
3. Serve the new overview schema and invalidate old cached movement responses.
4. Replace the Long-term health movement section and terminology.
5. Route only newly confirmed Primary declines into pastoral processing.
6. Monitor baseline completion, confirmation counts, evaluation failures, query counts, and duplicate-prevention metrics.

No historical transition is invented during rollout, and no package or lock-file changes are required by this design.
