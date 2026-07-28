# Task 8 report

Implemented reviewed schema-v2 reconciliation and atomic draft promotion.

- Reconciliation now evaluates the selected batch's draft only, retains active filters for all other batches, gates population before eligibility, and uses schema-aware adapter dispatch.
- Complete full snapshots capture shared filter facts using metadata derived from that snapshot; incremental snapshots do not replace the cache. Review plan digests bind active revision, draft digest, and snapshot ID.
- Reviewed applies pass guarded promotion into the same people-mutation transaction. Stale promotion rolls back people writes and retains the draft.
- Unattended sync blocks authoritative schema-2 drafts before starting a run or provider fetch; schema-1 migration drafts continue under the existing schedule.
- The necessary compatibility repair in `batchRepository.js` lets draft promotion use the transaction wrapper's supported `query` API while retaining raw-connection test compatibility.

Verification:

`cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/apply.dbintegration.test.js services/peopleSync/scheduler.test.js services/elvanto/filter.test.js`

Result: 113 passing, 0 failing.
