# Task 8 report

Implemented reviewed schema-v2 reconciliation and atomic draft promotion.

- Reconciliation now evaluates the selected batch's draft only, retains active filters for all other batches, gates population before eligibility, and uses schema-aware adapter dispatch.
- Complete full snapshots capture shared filter facts using metadata derived from that snapshot; incremental snapshots do not replace the cache. Review plan digests bind active revision, draft digest, and snapshot ID.
- Reviewed applies pass guarded promotion into the same people-mutation transaction. Stale promotion rolls back people writes and retains the draft.
- Unattended sync blocks authoritative schema-2 drafts before starting a run or provider fetch; schema-1 migration drafts continue under the existing schedule.
- The necessary compatibility repair in `batchRepository.js` lets draft promotion use the transaction wrapper's supported `query` API while retaining raw-connection test compatibility.

Verification:

`cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/apply.dbintegration.test.js services/peopleSync/scheduler.test.js services/elvanto/filter.test.js`

Result: 122 passing, 0 failing.

## Review fix round 1

- Schema-2 reconciliation now passes church sync settings to the provider population gate; schema-1 eligibility continues without this new gate.
- Unattended reconciliation now blocks on any enabled schema-2 ordinary draft for the authoritative provider, not only the requested batch. Schema-1 migration drafts remain schedulable.
- Elvanto's stale metadata fallback wrapper is unwrapped before complete snapshot fact/dimension capture; incremental snapshots are explicitly covered as non-replacing.
- Added review-context regressions for active revision, snapshot/plan staleness, and selection tampering, each preserving the draft and preventing people writes.

## Cross-path fix round 2

- Explicit filter snapshot refresh now loads the church's real Elvanto contact setting, so captured preview facts use the same population as live reconciliation.
- The shared metadata normalizer unwraps Elvanto's persisted stale-metadata envelope for both reconciliation and explicit refresh before dimension/fact capture.
- Added route-level regressions for contact exclusion and stale fallback metadata (including custom fields).
