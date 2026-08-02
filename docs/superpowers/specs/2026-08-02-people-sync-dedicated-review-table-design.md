# People Sync Dedicated Review Table Design

**Date:** 2026-08-02
**Status:** Approved

## Purpose

Give Planning Center and Elvanto batch reviews enough space for large rosters, reduce vertical scrolling, and make every proposed new identity decision directly editable before sync.

The design is provider-neutral. Planning Center and Elvanto use the same page, table, decision controls, and safety rules, with provider-specific labels and API callbacks.

## Goals

- Open batch review in the full LMPG content area while retaining the main application sidebar.
- Replace large identity comparison cards with a dense, searchable, filterable, paginated table.
- Let an administrator change any proposed addition into a match and change any proposed match to another LMPG person.
- Let an administrator safely correct or remove an incorrect established provider link.
- Preview the newly linked identity's managed effects before an established-link correction is applied.
- Distinguish rejecting one exact pairing from deferring the provider person for later review.
- Put the single apply action after all review options and warnings.
- Preserve review-token validation, church isolation, collision protection, source promotion, and transactional apply.
- Provide a usable narrow-screen layout without horizontal scrolling.

## Non-goals

- Displaying established links in the default new-decision table.
- Managing established provider links whose identities are outside the batch source being reviewed.
- Permanently ignoring a provider person without a management screen for ignored identities.
- Editing provider-owned people, households, Lists, Categories, or Groups.
- Automatically swapping two claimed LMPG people without explicit corrections for both provider identities.
- Reversing historical attendance, notes, or fields the integration does not manage when a link is corrected.
- Replacing batch configuration, source selection, or scheduling.
- Introducing a multi-step review wizard.

## Navigation and page layout

**Review & sync** opens a dedicated route inside the existing LMPG application shell. The main application sidebar remains visible, but the integration panel and batch card are replaced by the review page. The route identifies the provider and batch so a reload restores the same review context.

The page provides:

- a back control to the relevant Planning Center or Elvanto integration;
- provider, batch, and active or draft source names;
- the source snapshot time;
- compact summary-count chips;
- a small **Refresh** action in the header;
- the identity decision table;
- compact sections for non-identity changes;
- destructive confirmations; and
- one **Apply sync** button at the bottom.

There is no apply button in the header and no repeated apply control. The final button is normal-sized and may include a concise count such as `Apply 47 selected changes`.

Leaving the route or refreshing the plan after changing a decision prompts before discarding the local choices. Browser-level navigation protection is used where supported, and in-app back/navigation controls use the same dirty-state check. No prompt is needed before the administrator changes a decision or paginates within the review.

After a successful apply, the app returns to the relevant integration batch list, reloads the batch and sync status, and shows a success message.

## Identity tabs and scope

The identity area has two tabs.

### Decisions

The default **Decisions** tab contains only provider people for whom the current plan requires a new identity decision:

- deterministic suggested matches;
- ambiguous or held identities requiring an explicit choice; and
- proposed new LMPG people.

It does not contain people whose durable provider-to-LMPG link already exists. Non-identity plan actions for already-linked people remain visible in the compact sections below the table.

### Already linked

The **Already linked** tab contains established provider-to-LMPG links whose provider identities are present in the reviewed batch source snapshot. It is loaded and paginated separately so thousands of routine links do not clutter the default decision workflow. It exists specifically to find and correct an erroneous established link.

Links whose provider identities are outside the current batch source cannot be safely displayed with current source context and remain outside this batch-review design.

## Desktop identity table

Both tabs use the same desktop columns:

1. **Integration source name**
2. **Integration source family/household**
3. **LMPG name**
4. **LMPG family**
5. an accessible row action rendered visually as **×**

The provider label is Planning Center or Elvanto as appropriate; the column wording remains provider-neutral enough to support both. Source and LMPG family cells show the family or household name plus an abbreviated, muted preview of other members when available. Explicit fallbacks such as `No household`, `No family`, or `Household unavailable` replace ambiguous blank cells.

Names and family previews wrap safely. Internal IDs and matcher reason codes are not displayed. A friendly reason or status may appear as secondary text in the LMPG cell, but the design does not add a large status column.

## Responsive identity rows

At narrow widths, the semantic table changes to compact comparison rows rather than a horizontally scrolling table. Each row displays:

- the provider person and household context first;
- the LMPG decision and family context directly below it; and
- the same accessible row action.

This preserves the source-to-LMPG comparison order, keeps the editable decision visible, and avoids hiding columns off-screen. It must not regress into the large comparison-card layout being replaced.

## Search, filters, and pagination

Search matches provider names, LMPG names, provider household names, and LMPG family names across the complete set for the active tab.

The **Decisions** filters are:

- **All**
- **Needs attention**
- **Matched**
- **Adding**
- **Skipped**

Filtering and search happen before pagination. The default page size is 50 rows, with a rows-per-page selector and accessible previous/next controls. Changing search or filters returns to the first page. A decision made on one page remains in local state when the administrator changes page, filter, or search.

The **Already linked** tab supports search and pagination but does not need the decision-state filters. Filter counts and summary chips reflect the complete relevant set, not only the current page.

## Default decisions

- A deterministic suggested match defaults to the proposed LMPG individual.
- An unmatched provider person defaults to **Add new person** when creation is allowed.
- An ambiguous or previously held identity has no accepted default and remains in **Needs attention** until the administrator chooses **Match**, **Add**, or **Skip and ask again**.
- A decision that claims an LMPG person already claimed by another row is invalid and blocks apply.

The existing signed review context remains authoritative for whether matching or creation is available.

## Changing a match or addition

The LMPG name cell is the edit control. Clicking or tapping an LMPG name or **Add new person** opens the same searchable LMPG person-picker dialog.

The picker:

- searches names, families, and family members;
- shows the same person and family context used by the table;
- disables people unavailable because of a durable link or another decision in this review, with an explanation;
- lets the administrator select an eligible LMPG individual;
- lets the administrator retain or restore **Add new person** when creation is allowed; and
- requires confirmation before restoring a previously excluded exact pairing.

Selecting an LMPG individual updates the row to a manual match. Selecting **Add new person** changes a suggested or manual match to creation. These choices remain client-side until apply.

## Rejecting and skipping

The visual **×** has an accessible label that names the provider person and opens a confirmation dialog. It does not immediately mutate the decision.

For a row with a proposed LMPG pairing, the dialog offers:

### Reject this match

Reject only the exact provider-person/LMPG-person pairing, persist the existing exact-pair exclusion, and persist a review hold for the provider identity. The person remains eligible to match to a different LMPG individual in a later manual review. Unattended sync cannot link or create the held identity.

### Skip and ask again

Make no identity change, do not create an exact-pair exclusion, and persist a review hold. The person appears again for an explicit decision in a later manual review. Unattended sync cannot link or create the held identity in the meantime.

For a proposed addition with no LMPG pairing, the dialog offers only **Skip and ask again** because there is no exact pair to reject.

After either choice, the row remains editable. Choosing a valid match or addition before apply replaces the pending rejection or skip according to the existing decision rules. Successful link or creation clears the provider identity's review hold transactionally; deliberately restoring an excluded pair also removes that exact exclusion.

The product does not offer “permanently ignore this provider person” in this design. That stronger feature requires a discoverable ignored-identities management surface and is separately scoped.

## Correcting an established link

In the **Already linked** tab, clicking or tapping the linked LMPG person opens an established-link dialog with two actions.

### Change linked person

The administrator searches for and selects a different eligible LMPG person. The draft final mapping then:

- removes the provider identity's old established link;
- records the old exact provider/LMPG pairing as rejected;
- assigns the provider identity to the selected LMPG person;
- frees the previous LMPG person for a different provider identity in the same review; and
- clears any review hold for the reassigned provider identity.

### Unlink and review again

The draft final mapping removes the established link, records the old exact pairing as rejected, and places the provider identity on review hold. The identity is not immediately matched or created by unattended sync. It returns as a decision in a later manual review unless the administrator assigns it within the current review.

The review validates uniqueness against the complete final mapping rather than applying edits in click order. This lets one explicit correction free an LMPG person that another explicit decision uses in the same transaction. Selecting an LMPG person still claimed by an unchanged established link or another final decision is blocked. The UI does not infer or perform a two-person swap; the administrator must explicitly correct both rows.

Changing an established link can change which provider data manages each LMPG person. After such an edit, the client automatically requests a refreshed signed preview using the draft final identity mapping. The preview shows all downstream managed-field, people-type, family, lifecycle, and gathering effects produced by the correction. Apply remains disabled until the preview for the current draft mapping succeeds.

The refreshed preview does not attempt to undo history. The correction projects the newly linked identity's current managed values onto the new LMPG target in the same reviewed transaction, and that identity supplies future provider-managed values. Attendance history, notes, and fields outside the integration's managed set remain unchanged. Missing or unknown provider values retain the existing rule that they do not erase known LMPG values.

Apply performs old-link removal, the new link or hold, the old-pair exclusion, provider-managed changes, family and gathering effects, and Planning Center's denormalized `planning_center_id` clearing or reassignment in one church-scoped transaction. A failure rolls back the complete correction.

## Non-identity plan sections

The large summary cards and verbose plan cards are replaced with compact count chips and dense expandable sections below the identity table:

1. managed person updates;
2. family changes;
3. gathering additions and removals;
4. archives and reactivations; and
5. skipped or unchanged items.

Empty sections are omitted. Routine informational sections start collapsed. Sections requiring review or containing destructive actions open automatically. Existing per-change confirmations remain where the current safety model requires them.

The overall destructive-change acknowledgement appears immediately above the final apply area. Destructive actions are never hidden merely because the identity table is filtered or paginated.

## Apply readiness and feedback

Apply is disabled when:

- a required identity decision is incomplete;
- two decisions claim the same LMPG person;
- an established-link correction collides with the final identity mapping;
- the signed downstream preview does not represent the current draft mapping;
- a destructive confirmation is incomplete;
- the review context is malformed;
- the review is stale or already applied;
- a request is in progress; or
- an existing provider-specific safety rule blocks apply.

The disabled state includes administrator-readable guidance. Incomplete or colliding identity decisions provide a shortcut that selects **Needs attention** and returns to the relevant page or first affected row.

A stale source snapshot, changed local roster, changed established-link mapping, changed match-review state, changed plan, or changed correction preview applies nothing. The page explains that refresh is required. Refresh obtains a new signed review and resets local choices only after the administrator accepts the dirty-state warning.

Apply continues to send one explicit outcome for every new-decision identity in the signed review context plus the explicit established-link corrections represented by the signed preview. The server rebuilds and validates the review before applying. Identity links, created people, corrected links, holds, exclusions, source promotion, accepted non-identity actions, and presence tracking retain their transactional guarantees.

## Architecture

The client adds a provider-neutral dedicated review page composed from focused units:

- review route/page orchestration;
- compact header and summary chips;
- identity decision table with responsive row rendering;
- established-link table and correction dialog;
- client-side search, filters, and pagination;
- LMPG person-picker dialog;
- reject-or-skip dialog;
- dense non-identity change sections; and
- final apply controls.

Planning Center and Elvanto integration panels navigate to the shared page rather than rendering `SyncReview` inside a batch card. Provider adapters supply labels, batch/source metadata, plan loading, refreshing, applying, and the post-apply return destination.

The current V2 identity decision contract already represents the new-decision behaviour:

- `accept` for an unchanged suggested match;
- `link` for selecting another LMPG individual;
- `create` for adding a new LMPG person;
- `defer` for **Skip and ask again**; and
- `defer` with `excludeIndividualId` for **Reject this match**.

The established-link correction flow extends the review contract with a signed draft final mapping and its downstream preview. The server must recompute this preview from fresh provider and church-scoped local state rather than trust client-projected changes. Apply must verify that the signed preview digest matches the submitted final mapping and current review context.

The current person-link uniqueness constraints, match-review holds, and exact-pair exclusions remain the persistence model, so no database migration is expected. Link-repository behaviour does require an explicit transactional correction operation; ordinary upsert intentionally rejects reassignment collisions and must remain strict for other callers. Planning Center correction also keeps the legacy `individuals.planning_center_id` value consistent with the provider-neutral link table.

## Accessibility

- The table uses appropriate table semantics on desktop and labelled grouped comparison semantics on narrow screens.
- LMPG name controls are buttons or links with explicit accessible names, not click handlers on non-interactive text.
- The visual × includes an accessible action label naming the provider person.
- Dialogs trap focus, close predictably, return focus to the invoking row, and support Escape unless a request is in progress.
- Search, filters, pagination, row decisions, destructive confirmations, and apply are keyboard operable.
- Status, validation, and apply errors use live-region or alert semantics as appropriate.
- Colour is not the only indicator of decision state.
- Focus moves to an affected row when validation guidance targets it.

## Error handling

- **Plan load failure:** keep the dedicated page and show retry and back actions.
- **Refresh failure:** preserve the current review and local choices because no replacement review was accepted.
- **Correction-preview failure:** preserve the draft correction, block apply, and offer retry or revert for the affected edit.
- **Stale review:** apply nothing and require an explicit refresh.
- **Local person became unavailable:** identify the affected provider and LMPG names without exposing raw IDs.
- **Collision:** block apply and identify every conflicting row.
- **Apply failure with a still-valid review:** preserve local choices for retry.
- **Successful apply followed by summary-refresh failure:** report the apply as successful and warn that displayed batch status could not be refreshed.
- **Missing family context:** render the explicit no-family or unavailable fallback.

## Testing

Shared client tests cover:

- dedicated routing, reload context, back navigation, and post-apply return for both providers;
- dirty-state prompts for refresh and navigation;
- the default **Decisions** tab excluding established durable links;
- separately loaded, searchable, and paginated established links from the current batch source;
- default suggested-match and proposed-add decisions;
- Add to Match, Match to another Match, and Match to Add transitions;
- exact-pair rejection versus skip-without-exclusion;
- editing a rejected or skipped row before apply;
- previously excluded pairing confirmation;
- duplicate local-person claims and incomplete decisions;
- established-link reassignment, unlink-to-hold, old-pair exclusion, and explicit two-row corrections;
- refusal to infer a swap or claim an unchanged established target;
- signed downstream-preview refresh, failure, staleness, and apply blocking;
- atomic correction of provider-neutral links, holds/exclusions, managed effects, and PCO legacy IDs;
- preservation of attendance, notes, unmanaged fields, and known values when provider data is missing;
- search across provider and LMPG family context;
- filter counts, filter transitions, 50-row pagination, and retained off-page choices;
- responsive comparison-row rendering without horizontal scrolling;
- compact non-identity sections and destructive confirmations;
- the absence of an apply button in the header and the presence of one apply button after all options;
- stale, malformed, already-applied, refresh-failure, and retry states; and
- keyboard and dialog accessibility.

Provider integration tests verify that Planning Center and Elvanto both navigate into the shared review route with the correct batch and return destination.

Server unit and database-integration tests retain and extend coverage for manual links, creation, exact-pair exclusions, review holds, exclusion restoration, collisions, stale signed contexts, transactional rollback, source promotion, and church/provider scoping. No backend behaviour is accepted solely because the client disables or hides an invalid action.
