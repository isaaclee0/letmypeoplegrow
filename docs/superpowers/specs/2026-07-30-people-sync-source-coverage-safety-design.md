# People Sync Source-Coverage Safety Design

**Date:** 2026-07-30

## Problem

Planning Center Lists and Elvanto Categories/Groups are partial, provider-owned
people sources. During an ordinary batch review, the matcher compares the union
of the currently enabled sources with every active local regular. The plan then
places every unmatched local regular in an actionable
`unmatchedLocalRegulars` bucket.

This makes a person who is valid in the provider but belongs to another source
look eligible for archival. For example, a person in the Planning Center PM
List is currently offered as “Archive” while reviewing only the AM List. An
absence from one partial source is not evidence that the person is absent from
the provider.

## Decision

Ordinary people-sync reviews will never offer an unmatched, unlinked local
regular as an archive action.

The plan may still calculate how many active local regulars did not match any
person in the complete union of sources participating in the review. That value
is informational source-coverage data only. It cannot be selected, submitted,
or interpreted by the apply layer as permission to archive a person.

The review UI will show a neutral source-coverage notice when the count is
nonzero:

> N active LMPG regulars are not matched to any currently configured [provider]
> source. They will remain unchanged. Add another sync batch if they should be
> included.

The notice will not list people, use destructive styling, or appear inside
“Needs your decision.” A zero count produces no notice.

## Archival Rules

People sync may propose archival only when it has provider-specific evidence
about an established durable link:

1. the linked provider record has an explicit terminal lifecycle state, such
   as archived or deceased; or
2. the linked provider ID is absent from the complete union of configured
   sources for two consecutive successful full reconciliations.

Existing missing-count safeguards remain unchanged. Partial, failed, missing,
or incomplete source reads never create absence evidence. Unlinked local
regulars are outside this automatic archival path and remain manually
manageable under the existing authority rules.

## Server Contract

The review response will gain an optional provider-neutral coverage object:

```json
{
  "coverage": {
    "unmatchedActiveLocalRegulars": 208
  }
}
```

The count is derived from the matcher’s unmatched local IDs after filtering to
active local regulars. It is response-only display metadata and is excluded
from review selections and action-bucket summaries.

`unmatchedLocalRegulars` remains in the plan shape temporarily for backward
compatibility with stored audit counts and older clients, but new plans leave
it empty. The apply layer will continue rejecting selection IDs that are not
anchored to a current actionable plan item.

## Client Behaviour

The shared PCO/Elvanto review component will:

- remove unmatched local regulars from “Needs your decision”;
- render the informational coverage notice above the action sections;
- state explicitly that uncovered people remain unchanged; and
- preserve existing archive confirmation for linked, evidence-backed archive
  actions.

Historical review payloads that lack `coverage` remain renderable. Historical
`unmatchedLocalRegulars` entries will not be presented as selectable archive
actions, preventing a stale client payload from restoring the unsafe workflow.

## Testing

Server regression tests will prove that:

- an unmatched active local regular increases the coverage count but produces
  no `unmatchedLocalRegulars` or `archive` action;
- visitors, inactive people, and matched locals do not increase the count;
- durable linked-record missing confirmation still produces its existing
  archive action after two successful complete reconciliations; and
- review and authority-switch responses expose the same safe coverage shape.

Client tests will prove that:

- a nonzero coverage count renders neutral “remain unchanged” guidance;
- no archive control is rendered for unmatched-local legacy entries;
- zero or absent coverage renders no notice; and
- evidence-backed linked archive actions remain selectable and retain their
  destructive confirmation gate.

## Out of Scope

- Changing provider name matching or adding fuzzy matching.
- Writing to Planning Center Lists or Elvanto sources.
- Automatically deciding that source setup is complete.
- Building a separate post-setup cleanup workflow for genuinely uncovered
  local records.
