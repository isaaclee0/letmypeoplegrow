# PCO Background-Check Account Refresh Design

## Purpose

Repair Planning Center background-check tracking after the provider-neutral
people-sync rewrite, and make the association rule match the rest of the PCO
integration: any LMPG individual with a non-empty `planning_center_id` is
eligible for a background-check status update, regardless of how that ID was
created.

The current writer still exists, but no current production path calls it. The
new List-owned people-sync pipeline also sees only selected List members plus
incidental household context, so reconnecting the writer to those snapshots
would remain incomplete.

## Confirmed Current-State Evidence

- `server/services/planningCenter/backgroundCheckSync.js` writes by
  `individuals.planning_center_id`, but has no production caller.
- `server/services/planningCenter/sourceAdapter.js` reads selected Planning
  Center Lists, not the complete People account.
- `server/services/planningCenterSync.js` demonstrates that the PCO People
  collection can be read completely and paginated.
- Check-in-history import can create archived individuals with a
  `planning_center_id` without creating an `external_person_links` row.
- Kingston CRC currently has 923 individuals with a PCO ID, 560 canonical PCO
  person-link rows, and 363 PCO-ID-only archived individuals. Its two enabled
  Lists contain at most 382 source members, while 502 active individuals have
  PCO IDs.

## Association Rule

`individuals.planning_center_id` is the lookup key for this feature.

The updater must not require:

- membership in an enabled PCO List;
- an `external_person_links` row;
- active status in LMPG;
- a particular `link_source`; or
- Planning Center being the active people-sync authority.

The existing unique partial index on `(church_id, planning_center_id)` keeps
that association unambiguous within a church. Church ID remains part of every
local read and write.

## Chosen Architecture

Add an account-wide, read-only background-check snapshot to
`backgroundCheckSync.js`. It will use the existing PCO read client and token
owner to request:

```text
GET /people/v2/people?per_page=100
```

No `include` parameter is needed. Each page is projected immediately to:

```js
{ id: string, passedBackgroundCheck: boolean | null }
```

The service will then apply the complete snapshot to all local individuals
with a non-empty `planning_center_id`, including archived people. It will run
after a successful real PCO reconciliation in both reviewed/manual and
unattended paths. Review construction, correction preview, and other read-only
previews must not write background-check state.

The provider-neutral adapter contract remains unchanged. This is a PCO-only
supplementary projection and will be invoked by a small, dependency-injected
post-apply helper in the orchestrator rather than being disguised as source
membership data.

## Snapshot and Write Semantics

For each local individual with a PCO ID after the people-sync apply commits:

- remote `passed_background_check === true` writes `1`;
- remote `passed_background_check === false` writes `0`;
- a returned Person with a missing/non-boolean value writes `NULL`;
- a local PCO ID absent from a successfully completed account snapshot writes
  `NULL`.

Clearing unknown or absent records to `NULL` is deliberate. A previously green
shield must not remain green after a complete refresh can no longer establish
that the person is currently cleared.

The write happens in one church-scoped database transaction and does not touch
`individuals.updated_at`, because background-check projection is supplementary
provider state rather than a local identity edit.

The service returns aggregate counts only:

```js
{
  fetchedAt: string,
  updated: number,
  cleared: number,
  notCleared: number,
  unknown: number,
}
```

No names, raw PCO resources, credentials, or background-check details enter
logs or the people-sync run audit JSON.

## Triggering, Gating, and Deduplication

The account-wide read is performed only when
`church_settings.planning_center_track_background_checks = 1`. The old design
could write unconditionally because the value rode on a full-account roster
fetch; the List-based architecture now requires an additional account-wide
request, so disabled churches must not incur it.

After `applyPeopleSyncPlan` commits:

1. If the provider is not `planning_center`, skip.
2. If tracking is disabled, skip without requesting a token or calling PCO.
3. Otherwise refresh and apply the account-wide snapshot.

A per-church single-flight plus a 60-second successful-snapshot cache prevents
two scheduled PCO batches applied back-to-back from refetching the same account.
Failures are not cached. Applying a cached successful snapshot still re-runs
the local-ID update, so a person linked by the second apply receives the status.

## Failure Semantics

Background-check refresh is supplementary to roster reconciliation.

- A fetch or write failure after the roster transaction commits must never
  make the people-sync run read `failed`.
- The orchestrator logs one credential-free warning containing church ID and
  run ID.
- The returned/applied counts record `backgroundCheckSyncFailed: 1` and
  `backgroundCheckSynced: 0` on failure.
- Success records `backgroundCheckSynced: <updated count>` and
  `backgroundCheckSyncFailed: 0`.
- Existing local statuses remain unchanged when the account request itself
  fails, because there is no complete snapshot on which to base clearing.

This preserves truthful roster audit state while making supplementary failure
observable.

## Rejected Approaches

### Reuse only the selected List snapshots

Rejected because it excludes valid local PCO IDs outside enabled Lists. Family
context may happen to include some additional people, but it is incidental and
cannot define correctness.

### Read one PCO Person endpoint per local ID

Rejected because churches can have hundreds or thousands of linked records.
The complete paginated People collection requires far fewer requests and uses
the existing retry/rate-limit behavior.

### Treat `external_person_links` as the only association table

Rejected because legacy and check-in-import paths legitimately populate
`planning_center_id` without a canonical link row. The status feature already
uses the compatibility ID in its UI, lock, import, and coverage semantics.

## Testing Requirements

- Unit-test complete pagination, the absence of `include`, boolean/null
  projection, malformed resources, and retry-safe read behavior.
- Database-integration-test active and archived PCO-ID-only people, canonical
  link independence, true-to-false and true-to-unknown transitions, absent-ID
  clearing, and church isolation.
- Orchestrator-test one post-apply refresh for reviewed PCO apply and unattended
  PCO apply, no refresh for Elvanto or previews, aggregation of success counts,
  and non-fatal failure handling.
- Run the focused server tests in Docker.
- On Kingston, run a real reviewed PCO reconciliation and verify aggregate
  database counts only: linked people should no longer all be `NULL`, and no
  other church database may change.

## Scope Boundaries

- No richer PCO `BackgroundCheck` resource, expiry dates, reports, or history.
- No changes to role gating or shield rendering.
- No changes to List ownership, matching, lifecycle, archive review, or source
  provenance.
- No schema migration or new dependency.
- No automatic enabling of gathering-level `requires_background_check` flags.
