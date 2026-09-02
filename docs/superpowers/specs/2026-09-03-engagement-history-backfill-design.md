# Engagement History Backfill Design

## Purpose

When engagement reporting is released, churches with reliable historical attendance should see useful tier movement immediately. The current evaluator uses historical attendance to calculate a person's present tier, but its first run creates a present-day baseline and records no earlier candidates or transitions. This makes an established dataset appear new.

The system will automatically replay reliable historical attendance once for each church and engagement rules version. The replay will use today's engagement settings, gathering roles, active-person eligibility, and gathering assignments retroactively, as explicitly accepted for launch.

## User-visible behaviour

- A church with sufficient reliable historical attendance can see reconstructed confirming and confirmed tier movement immediately after the deployment startup backfill finishes.
- Reconstructed movement uses the same thresholds, evidence rules, exclusions, 13-week confirmation period, and completed-week boundaries as prospective movement.
- The Tier movement explanation identifies that historical movement may have been reconstructed using current settings and assignments.
- Churches without enough history still receive a valid current baseline and begin prospective tracking normally.
- Backfill is automatic. There is no administrator button or setup step.

## Replay range and semantics

For each church, the replay starts at the first completed church-local week containing a reliable, held, person-level attendance session. It ends at the latest fully completed church-local week available at startup.

Each completed week is evaluated chronologically. The replay calls the existing engagement profile calculation for that historical `asOf` date, then passes each axis through the existing tier-confirmation state machine. The first eligible result establishes a baseline. Later weekly results may start, cancel, restart, expire, or confirm candidates exactly as live weekly evaluation does.

The replay intentionally applies current configuration retroactively:

- current tier thresholds and labels;
- current engagement rules version;
- current gathering engagement roles;
- current individual-to-gathering assignments;
- current active-regular eligibility.

Attendance sessions marked excluded, cancelled, unreliable, or otherwise ineligible under the existing opportunity calculator remain excluded. Headcount-only sessions cannot create person-level tier movement.

## Architecture

### Pure chronological evaluator

Refactor the existing confirmation evaluator so a shared internal operation can evaluate one calculated weekly profile against an explicit in-memory state map and return:

- the next state map;
- candidate outcome counts;
- confirmed transitions.

The normal weekly evaluator continues to load persisted state, evaluate one week, and persist the result. The history backfill starts from an empty state map and evaluates every historical completed week without writing intermediate results.

Using one state machine and one opportunity calculator prevents the historical and prospective definitions from diverging.

### Backfill coordinator

Add an engagement history backfill service responsible for:

1. listing approved registered churches sequentially;
2. loading each church's current engagement rules version;
3. checking its completion marker;
4. finding its replay range;
5. calculating and replaying its completed weeks;
6. atomically persisting the final states, reconstructed transitions, and completion marker.

The coordinator runs after database initialization and before `server.listen()`. With the currently small number of churches, this provides useful information as soon as the live server accepts requests. A failure for one church is logged, leaves that church unmarked, and does not prevent other churches or the server from starting.

The existing weekly scheduler also invokes the pending-backfill coordinator so transient failures retry without requiring another deployment. Concurrent calls for the same church are serialized with the same per-church process-local coordination pattern used by the engagement evaluator. Database uniqueness remains the final duplicate defence.

## Completion marker

Add an additive per-church table:

`engagement_history_backfills`

- `church_id TEXT NOT NULL`
- `rules_version INTEGER NOT NULL`
- `first_week_end TEXT`
- `last_week_end TEXT NOT NULL`
- `weeks_evaluated INTEGER NOT NULL`
- `transitions_reconstructed INTEGER NOT NULL`
- `completed_at TEXT NOT NULL`
- primary key: `(church_id, rules_version)`

A marker means the historical replay for that rules version completed successfully. A settings change that increments the calculation rules version naturally creates a new missing marker and triggers a fresh replay. Label- or colour-only changes that do not increment the version do not repeat it.

The marker is written in the same church-database transaction as the final state and transitions. There is no `in_progress` marker: interruption or failure simply leaves the replay eligible for retry.

Add a nullable `reconstructed_at TEXT` column to `engagement_tier_transitions`. Historical replay sets this timestamp; prospective transitions leave it null. This provenance prevents reconstructed history from being mistaken for a new live pastoral event.

## Persistence and safety

The backfill performs all expensive historical calculation before opening its final write transaction. Within that transaction it:

1. rechecks that the rules version still matches and the marker is still absent;
2. upserts the replay's final tier states;
3. inserts reconstructed transitions with `reconstructed_at` set, through the existing unique transition key and `DO NOTHING` conflict behaviour;
4. writes the completion marker.

Existing matching transitions are preserved, including pastoral-processing metadata. Transitions from other rules versions are never removed. If configuration changes during calculation, the transaction aborts without a marker and the new version is retried later.

Pastoral decline processing explicitly ignores rows with `reconstructed_at` set. This prevents deployment from generating retrospective alerts or caregiver work from months-old reconstructed changes.

An empty replay is valid: it records a zero-week marker only when the church has no eligible historical person-level session. This avoids scanning the same empty history on every startup while allowing a later rules-version change to evaluate again. Normal prospective evaluation still operates after the marker.

## Startup and retry behaviour

- Database schema initialization completes first.
- The startup coordinator processes churches sequentially before the HTTP listener opens.
- Each church has an independent error boundary.
- Logs include church ID, rules version, replay range, weeks evaluated, transitions reconstructed, elapsed time, and failure reason. They contain no person names or attendance details.
- The weekly scheduler retries churches whose current rules version has no completion marker before its normal confirmation and review work.
- Completed markers make subsequent startup and weekly checks inexpensive and idempotent.

## Report copy

The Tier movement section will use quiet explanatory text rather than a warning banner. When reconstructed history exists, it will state that historical movement was reconstructed using current engagement settings and assignments. The API will expose enough metadata from the current-version completion marker for the client to make this statement accurately; absence of a marker will not be presented as an error.

## Testing

### State-machine and replay tests

- Weekly historical profiles are evaluated in chronological order.
- A first eligible tier creates a baseline rather than a transition.
- A sustained threshold crossing reconstructs a transition after the existing confirmation period.
- A reverted or changed candidate is cancelled or restarted under existing rules.
- Excluded and unreliable sessions do not affect reconstructed evidence.
- Short and empty histories produce valid state without invented movement.

### Persistence tests

- Final state, transitions, and marker commit atomically.
- A thrown calculation or transaction error leaves no marker and is retryable.
- A repeated run for the same rules version performs no replay and creates no duplicate transitions.
- A new rules version receives an independent replay and marker.
- Existing matching transition rows retain pastoral-processing metadata.
- Reconstructed transitions are excluded from pastoral decline processing.
- A rules-version change during replay aborts the stale write.

### Coordinator and UI tests

- Startup processes multiple churches sequentially and continues after one failure.
- The weekly path retries only unmarked current versions.
- The report displays reconstructed-history copy only when marker metadata indicates a completed reconstruction.
- Existing prospective evaluation and report tests remain green.

## Non-goals

- Reconstructing historical gathering roles, assignments, membership status, or prior threshold settings.
- Replaying headcount gatherings as person-level evidence.
- Providing a manual rebuild control.
- Sending retrospective pastoral alerts or caregiver notifications for reconstructed transitions. Reconstructed transition rows are report history only; downstream pastoral processing begins from live prospective transitions after backfill.
