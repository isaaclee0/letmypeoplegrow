# People Sync Lifecycle Review Design

**Status:** Approved

## Goal

Separate external-source membership from local-person lifecycle decisions. A
person missing from configured Planning Center or Elvanto sources must never
be archived merely because source coverage is incomplete. Explicit provider
lifecycle states remain actionable, while unlinked local people are surfaced
for an administrator to decide about.

## Rules

1. Remove the `missing from two complete provider syncs` lifecycle rule.
   Complete provider reads must no longer increment, reset, or use
   `missing_full_sync_count` to propose an archive.
2. A linked person may be proposed for archive only when their provider
   identity explicitly reports `Archived` or `Deceased`. Existing safety
   rules still apply: the proposal is reviewed before apply, and the ordinary
   transaction, token, authority, source-generation, and rollback fences
   remain unchanged.
3. A person excluded by a configured provider state/rule (for example an
   Elvanto contact when contacts are not included) is not treated as proof
   they left the church. It must not produce an absence-based archive.
4. LMPG people with no identity link for the active authority provider are
   local-only until an administrator chooses otherwise. They are never
   auto-archived by people sync.

## Lifecycle Review Section

The dedicated batch review workspace gains a lifecycle review section after
identity decisions and before the single final **Apply sync** action.

### Proposed archives

- Contains only active linked LMPG people whose matching external person is
  explicitly `Archived` or `Deceased`.
- Each proposal remains individually selectable for archive, following the
  existing destructive confirmation rules.
- The section includes **Accept all proposed archives**, which selects every
  archive proposal currently in the reviewed plan. It never selects any
  local-only/unlinked person.
- If there are no provider-status archive proposals, the section is hidden.

### Local-only people

- Contains active LMPG people that lack a link for the active authority
  provider.
- This is an informational decision surface, not a side effect of a provider
  read. Its first release links to the People-view filter rather than adding
  new bulk actions to sync review.
- Copy explains that these people are not included in the external provider
  sync and are retained in LMPG until an administrator decides otherwise.

## People View Filter

When an external people-sync authority is enabled, People adds an
**External source** filter scoped to that active provider:

- **All** (default)
- **Linked** — people with a durable link for the active provider
- **Not linked** — people without one

The filter applies consistently to family-grouped and individual regular
people displays. It does not expose or combine links from an inactive
provider. When people syncing has no active authority, the filter is absent.

## Data and Compatibility

- Do not add a database migration or runtime dependency.
- Existing `missing_full_sync_count` values may remain stored for backward
  compatibility but are no longer mutated or used in planning.
- Existing Planning Center compatibility IDs and generic external links remain
  the source of linked/unlinked status.
- A provider state transition back to active continues to use existing
  reactivation behavior for a linked inactive LMPG person.

## Error Handling and Testing

- Full, partial, and scheduled syncs must not write presence counters or
  create `confirmed_missing_full_sync` / `awaiting_missing_confirmation`
  actions.
- Tests cover Archived and Deceased archive proposals, active/contact/source
  absence producing no archive, select-all archive behavior, and link filter
  visibility/scoping for both grouped and individual People views.
- Existing church scoping, plan token, authority, source-draft, connection
  generation, and transaction tests remain green.
