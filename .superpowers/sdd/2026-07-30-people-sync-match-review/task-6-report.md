# Task 6 Report: Review State Through Sync Orchestration and Notifications

## Delivered

- Confirmed the existing orchestration pipeline loads `listMatchReviewState(churchId, provider)`, normalizes exclusions and holds for the matcher, and signs the structured review state into rebuilt contexts. That implementation was already present in commit `42d584d` from the preceding review-context work.
- Added unattended-sync coverage for a held unmatched identity: it is retained as `review_deferred`, produces no create action, records `review_required`, and invokes exactly one provider-scoped notification with the held count.
- Updated notification wording from “ambiguous match” to “person match”, which accurately covers both ambiguity and a deliberately deferred deterministic match without including person details.
- Added PCO, Elvanto, and authority-route coverage that confirms preview responses preserve `decisionContractVersion: 2`, v2 selections are forwarded unchanged, and legacy selections still pass through unchanged.

## Files changed

- `server/services/peopleSync/reviewNotification.js`
- `server/services/peopleSync/reviewNotification.dbintegration.test.js`
- `server/services/peopleSync/orchestrator.test.js`
- `server/routes/integrations/planningCenterPeopleSync.test.js`
- `server/routes/integrations/elvanto.test.js`
- `server/routes/integrations/peopleSync.test.js`

## Verification

```text
cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/reviewNotification.dbintegration.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js routes/integrations/peopleSync.test.js
110 passed, 0 failed
```

The command needed to run outside the sandbox because Winston's test-process exception handler calls `uv_uptime`, which is blocked by the sandbox.

## Concerns

- No production route changes were required: each route already spreads review results and forwards a plain-object `selections` payload untouched. The new tests protect that compatibility boundary.
- The provider-neutral orchestration additions requested by this task were already committed alongside signed review-context support; this task adds the missing notification wording and end-to-end regression coverage.
