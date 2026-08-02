# Final fix wave report

Date: 2026-08-02

## Outcome

The dedicated people-sync review table is ready to merge. The final wave closes the remaining correctness gaps around signed correction plans, one-time token lineage, semantic error classification, and established-link correction UX. Planning Center and Elvanto use the same hardened path.

## Implemented fixes

### Signed selection dispatch and atomic apply

- Reviewed plans dispatch validation from the signed plan's `reviewContext.version`, rather than trusting a caller-selected contract.
- A signed V2 plan requires `decisionContractVersion: 2`; missing or wrong markers fail before writes.
- Legacy plans reject all correction-only fields instead of silently ignoring them.
- Submitted correction maps must exactly match the canonical correction projection signed into the V2 plan. Explicit falsey values such as `null`, `false`, `0`, and `""` are invalid rather than being normalized to an empty correction set.
- The review-token claim, correction exclusion/hold writes, and all downstream reconciliation writes occur in one database transaction. Any later failure rolls the entire unit back.

### One-time review lineage

- Corrected review tokens carry a signed `basePlanDigest` and stable `rootReviewTokenDigest`.
- Base, corrected, and sibling tokens atomically claim the same root application row, so only one member of the lineage can apply.
- An already-applied base token cannot mint another corrected token.
- A correction token cannot be used to launder an applied root through an empty or second-generation correction preview.
- Legacy and ordinary pre-correction review tokens remain verifiable and claim their own token digest.

### Typed invalid-versus-stale errors

- Malformed or semantically invalid correction projections return `SYNC_SELECTIONS_INVALID` with HTTP 400 when the signed base lineage still describes the current snapshot.
- A genuinely changed base plan remains `SYNC_PLAN_STALE` with HTTP 409.
- Route coverage verifies the status/code mapping for both Planning Center and Elvanto.

### Established-link correction workflow

- A successful relink or unlink can be reopened and revised.
- A correction can be restored to its original link without emitting a no-op relink.
- Unlinked rows render as truly unlinked rather than falling back to the original person.
- Two-person swaps are explicit: the first colliding leg is retained locally with Apply disabled, and a signed preview is requested only after the second leg resolves the collision.
- Revisions can swap against either an original established target or the target from the last signed projection.
- Older preview generations are aborted logically and cannot overwrite a newer effective review.

## Direct regression coverage

- Nonpositive relink targets are rejected.
- Duplicate canonical correction arrays are rejected.
- Explicit unlink presence is preserved and validated.
- Falsey submitted correction maps are rejected.
- Correction writes roll back with a downstream failure.
- Base-first and corrected-first application races share one consumable root lineage.
- Applied-base correction minting and empty-child lineage laundering are rejected.
- PCO and Elvanto expose invalid selections as 400 and stale plans as 409.
- UI revision, restore, reopen-after-unlink, initial two-person swap, post-relink revised swap, stale-preview suppression, and signed-token apply are covered.
- The assembled `SyncReview` regression proves that a half-swap blocks Apply, the completed swap obtains a signed preview, and Apply submits that preview token with both corrections.

## TDD evidence

The initial focused RED suites exposed the expected missing behavior in both server and client correction paths. Additional targeted RED tests then reproduced:

- the base/child race as a missing rejection after a child token had been pre-minted;
- falsey correction-map laundering as a missing validation exception;
- the post-success revised-swap target being disabled;
- an unattended-sync regression caused by treating every V2-context plan as an interactive signed apply.

Each failure was fixed at its owning boundary, then retained as a regression test. Unattended plans continue using their existing unsigned legacy selection path, while reviewed V2 applies use strict signed validation.

## Verification

- `NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/server/node_modules node --test --test-reporter=dot services/peopleSync/*.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js` — passed.
- `npm test -- --run` in `client` — passed, 33 files and 284 tests.
- `npm run build` in `client` — passed, 1,373 modules transformed.
- `git diff --check` — passed.
- Independent final code review — ready to merge; no critical or important findings.

The client commands still print Node's existing `module.register()` deprecation warning. The production build also retains the existing large-chunk advisory for the main bundle. Neither warning was introduced by this fix wave.

## Non-blocking follow-up

The UI aborts stale preview generations and guards all state updates, but the `AbortSignal` is not yet threaded through every owner adapter to Axios. A canceled request may therefore continue consuming server/network work until timeout even though it cannot alter the UI. The independent review classified this as a resource optimization, not a correctness or merge blocker.
