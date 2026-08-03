# Final fix report — people-sync lifecycle review

## Status

PASS. The final lifecycle-review findings are addressed for scheduled sync,
gathering membership, local-only disclosure, and removal of client-side
absence-counter assumptions.

## Changes

- Scheduled sync now treats explicit provider Archived/Deceased actions as
  review-required proposals and cannot apply an archive without an explicit
  reviewer selection.
- A terminal lifecycle proposal no longer also removes a sync-owned gathering
  assignment. Manual review/apply remains the only path that can accept the
  archive.
- Review coverage now reports active LMPG regulars without a durable link to
  the authoritative provider. The count is provider-scoped, includes legacy
  Planning Center IDs only for Planning Center, and is independent of matcher
  or source membership.
- Lifecycle review now supports an informational local-only state with no
  archive controls and links to `/app/people?externalSource=unlinked`. The
  People page reads that query and opens its provider-scoped **Not linked**
  filter.
- Client archive rendering is restricted defensively to provider
  Archived/Deceased reasons. Absence-era reason copy and required
  `missingFullSyncCount` types were removed.

## TDD evidence

RED:

- New server regressions showed scheduled terminal records were reported as
  applied and a terminal person received a gathering-removal action.
- New client regressions initially reported 3 failures / 42 passes: the
  local-only Lifecycle section was absent, the People URL did not select
  **Not linked**, and the old matcher/source-coverage banner still rendered.
- The mixed-version guard initially showed a legacy
  `confirmed_missing_full_sync` action as an archive proposal.

GREEN:

- Focused server planning/apply/orchestrator suites: 194 passed.
- Focused client lifecycle/source/People-page suites: 80 passed.

## Final verification

- People-sync services plus integration routes: 529 passed.
- Full client suite: 34 files, 301 passed.
- Client production build: passed (`vite build`, 1,373 modules transformed).
- `git diff --check`: passed.
- Independent read-only final diff review: no findings.

The build retained the existing large-chunk advisory and Node emitted its
existing `module.register()` deprecation warning; neither was a failure.
