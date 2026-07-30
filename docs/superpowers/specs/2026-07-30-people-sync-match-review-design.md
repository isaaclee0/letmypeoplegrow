# People Sync Match Review and Styling Design

**Date:** 2026-07-30
**Status:** Awaiting written-spec review

## Purpose

Make Planning Center and Elvanto sync reviews safe when people share names, let administrators correct or reject proposed identity links, and bring the shared review UI into line with the rest of Let My People Grow.

The design is provider-neutral. Planning Center and Elvanto use the same review model and interaction patterns, with provider-specific labels where appropriate.

## Goals

- Show enough family context to distinguish people with identical names.
- Let an administrator accept, redirect, reject, defer, or replace every proposed new identity link.
- Support exact-pair exclusions without preventing either person from matching correctly elsewhere.
- Prevent unattended sync from overriding a decision that an administrator deliberately deferred or rejected.
- Replace technical plan output with a clear, responsive, accessible review experience consistent with Settings.
- Preserve church isolation, stale-plan protection, transactional apply, and provider-neutral behavior.

## Non-goals

- Editing provider-owned people or households from LMPG.
- Manually changing an already established durable external link from this review. Existing-link management can be designed separately.
- Exposing provider contact details, custom fields, or raw API attributes in the review.
- Replacing the source-selection or batch-settings workflows.
- Turning routine sync review into a multi-step wizard.

## Review structure

The expanded review remains inside its batch card but becomes a visually distinct nested panel.

The header contains:

- the provider and batch context;
- the source snapshot's last-refreshed time;
- friendly summary counts such as `4 suggested matches`, `2 new people`, and `1 archive`;
- a primary **Apply sync** button and secondary **Refresh** action; and
- a concise all-clear state when the plan contains no changes.

The bottom of a long review repeats the apply and refresh actions.

Plan actions are grouped into collapsible, human-readable sections:

1. Matches to review
2. New people
3. People and family updates
4. Gathering changes
5. Archives and other removals
6. Skipped or unchanged items

Sections requiring a decision open by default. Large informational sections may start collapsed. Internal bucket names such as `linkPeople` and internal reason codes such as `unique_name` are mapped to friendly labels and explanations.

## Visual language

The review follows the established Settings and integration styling:

- white or dark surface cards with rounded corners, borders, restrained shadows, and consistent padding;
- normal headings and explanatory copy rather than raw data lists;
- green primary buttons and bordered secondary buttons;
- amber treatment for caution and red only for destructive choices;
- standard focus rings, disabled states, dark-mode colours, and spacing;
- stacked comparison content and full-width controls on small screens; and
- no ordinary display of database IDs or provider IDs.

Loading, empty, error, and success states use the same alert and card patterns as the rest of Settings. Destructive changes remain visually separate and require the existing explicit confirmation.

## Person and family display

Every identity comparison shows two clearly labelled sides:

- **Planning Center person** or **Elvanto person**; and
- **Let My People Grow person**.

Each side displays:

- full name;
- family or household name;
- a compact preview of other family members; and
- an explicit `No family` or `Household information unavailable` label when appropriate.

The member preview is necessary even when a family name exists because separate families may share the same name. A short family is shown inline. Longer families show an abbreviated preview and a control such as `3 more family members`. Family members are ordered deterministically, exclude the compared person, and are rendered as display-only context.

The review response contains only the lean person/family directory required for this display. External family-member previews may use provider household context fetched during the source read, including the names of household members outside the selected batch when the provider supplies that context. It does not contain contact details, custom fields, notes, or raw provider attributes.

## Match comparison cards

Every proposed *new* external-to-local identity link appears as a comparison card, including deterministic automatic suggestions and ambiguous matches.

The card explains why the match was suggested in friendly terms, for example:

- `Same full name`
- `Same full name and child status`
- `Same full name with a linked family member`
- `More than one person has this name`

Deterministic suggestions default to **Accept suggested match**, preserving the efficiency of today's automatic review. Ambiguous matches have no accepted default and require an explicit decision or an explicit deferral.

Each card offers these outcomes:

### Accept suggested match

Create the proposed external-person-to-local-individual link.

### Choose someone else

Open an inline searchable LMPG person picker. Search results show the same name, family, and family-member context as the comparison card.

People already claimed by another accepted decision or durable external link are disabled with a short explanation. The server remains the authority for availability; client disabling is guidance only.

### Add as a new person

Reject the proposed local match, create a new LMPG individual from the reviewed external person, and establish the external link to the new individual in the same transaction.

### Skip for now

Make no identity change in this apply. Record a review hold for the external identity so unattended sync cannot automatically link or add it before an administrator resolves it in a later review.

The suggestion may appear again in later manual reviews. Merely viewing or refreshing a review does not clear the hold.

### Don't suggest this pairing again

This option is available after rejecting the suggested local person. It records an exclusion for only the exact provider-person/local-person pair. It does not exclude either person from other possible matches.

Rejecting a pair also leaves the external identity on review hold. This prevents a later unattended run from unexpectedly choosing another automatic link or creating a new person. A later manual review must choose another person, choose **Add as a new person**, or deliberately restore the excluded pairing.

## Manual selection and prior exclusions

Manual search includes eligible active and archived local individuals when the existing matcher rules allow them to be linked. Results unavailable because of a durable or in-review claim remain visible but disabled where that helps explain why they cannot be selected.

An administrator may deliberately select a pairing that was previously excluded. The UI warns that the pairing was previously rejected and asks for confirmation. Successful apply removes that exact exclusion and establishes the link atomically.

Accepting a suggested match, choosing another person, or adding a new person clears the external identity's review hold. Skipping or excluding does not.

## Apply behavior

The client sends an explicit decision for every proposed identity card whose default or reviewer choice is being applied. The provider-neutral decision model represents:

- accepted suggested local individual;
- manually selected local individual;
- create new;
- defer; and
- exact pairing exclusions to add or remove.

The server rebuilds the provider snapshot and plan before apply, as it does today, and validates every decision against the fresh church-scoped state.

Validation requires that:

- the external person belongs to the reviewed source snapshot;
- every local individual belongs to the authenticated church;
- a selected local individual is eligible for a new link;
- no external or local identity is claimed twice across established links, default acceptances, manual selections, and additions;
- `create new` is not combined with an existing-person link;
- a pair exclusion refers to the exact suggestion exposed in the review;
- an exclusion override refers to an existing exclusion for that church and provider; and
- all destructive selections still satisfy the existing archive and family-rename validation.

The review token continues to bind apply to the recomputed plan. If the plan has changed, apply fails without mutations and requires a fresh review.

Identity links, created people, review holds, exclusion additions/removals, source promotion, and the rest of the accepted sync plan commit in one transaction. A failed apply leaves none of those changes behind.

## Persistent state

Provider-neutral state is stored with church and provider scope.

### Exact pair exclusions

An exclusion records:

- `church_id`;
- provider;
- external person ID;
- local individual ID;
- the administrator who created it where available; and
- created and updated timestamps.

The tuple `(church_id, provider, external_person_id, individual_id)` is unique. The matcher removes excluded pairs before automatic name, child-state, and family corroboration decisions.

### External identity review holds

A review hold records:

- `church_id`;
- provider;
- external person ID;
- the reason (`deferred` or `pair_rejected`);
- the administrator who created it where available; and
- created and updated timestamps.

The tuple `(church_id, provider, external_person_id)` is unique. A held external identity may be planned for manual review but cannot produce an unattended link or addition. Resolution clears the hold transactionally.

Both structures follow the repository's additive schema-migration convention and retain explicit church filtering in every query.

## Matcher behavior

Before ordinary matching, the matcher:

1. removes exact excluded candidate pairs;
2. performs durable-link, unique-name, child-state, family-corroboration, visitor, archived-person, and ambiguity logic as normal; and
3. marks any proposed identity for a held external person as review-required, even if it would otherwise be deterministic.

Exclusions cannot invalidate a durable link because this feature does not create exclusions for already established links. If inconsistent legacy data contains both, the durable link wins and the inconsistency is logged for repair rather than silently unlinking anyone.

Unattended runs continue applying safe deterministic identity actions for identities without holds. Held identities remain unchanged and contribute to review-required counts and administrator notification.

## Review summary and apply readiness

The summary distinguishes:

- suggested matches accepted by default;
- matches needing an explicit decision;
- manual overrides;
- people to add;
- deferred identities; and
- destructive changes.

An unresolved ambiguous match is not silently accepted. The administrator must choose a match, choose to add, or choose **Skip for now**. Explicit deferrals do not block unrelated safe changes.

The apply button is disabled only for invalid or incomplete required decisions, unmet destructive confirmation, a request in progress, or a known collision. Explanatory text identifies what remains unresolved.

## Error handling

- **Stale review:** apply nothing, explain that source or local data changed, and require refresh.
- **Local person became unavailable:** reject the affected decision with names and family context, not raw IDs.
- **No manual-search result:** retain **Add as a new person** and **Skip for now**.
- **Missing household data:** show an explicit unavailable/no-family label.
- **Apply failure before commit:** preserve visible client choices when the same review remains valid so the administrator can retry.
- **Refresh after staleness:** reset choices whose validity cannot be guaranteed and explain that they need review again.
- **Collision:** prevent apply and identify both conflicting decisions in administrator-readable terms.

## Accessibility and responsive behavior

- Every radio, checkbox, disclosure, search field, and button has an accessible name.
- Comparison sides have semantic headings and do not rely on colour alone.
- Keyboard users can open search, move through results, select a person, and change a decision.
- Focus moves to the manual picker when it opens and returns predictably when it closes.
- Status and apply errors use appropriate live-region or alert semantics.
- At narrow widths, provider and LMPG sides stack vertically; decision controls remain below them and do not require horizontal scrolling.
- Long names and family previews wrap without obscuring controls.

## Testing strategy

### Matcher and plan unit tests

- duplicate names in different families;
- duplicate family names distinguished by member context;
- exact exclusions remove only the targeted pair;
- held deterministic matches become review-required;
- held identities cannot become unattended additions;
- manual resolution clears a hold; and
- durable links are not displaced by exclusions.

### Selection-validation unit tests

- accept, redirect, create, defer, exclude, and exclusion override;
- cross-church or unknown local IDs are rejected;
- external identities outside the reviewed source are rejected;
- external and local claim collisions are rejected;
- create-and-link contradictions are rejected; and
- exclusions can target only pairings exposed by the review.

### Database integration tests

- church and provider isolation for exclusions and holds;
- unique constraints and idempotent updates;
- link/create/hold/exclusion changes commit together;
- failure rolls back all identity decisions;
- unattended runs leave held identities unchanged; and
- scheduled review-required counts and notifications include held identities.

### Client tests

- friendly summaries replace technical bucket names;
- both providers render the shared comparison cards;
- name, family, and member previews appear on both sides when available;
- no-family and unavailable states are explicit;
- deterministic matches default to accept;
- ambiguous matches require an explicit decision or deferral;
- manual search shows context and disables unavailable people;
- persistent rejection and exclusion override confirmations work;
- stale and collision errors are understandable;
- destructive confirmation remains enforced; and
- keyboard, dark-mode class coverage, mobile stacking, and long-content layout are verified.

## Rollout and compatibility

The review response advertises a decision-contract version. The new client uses the new identity-decision payload only when the server advertises that version and treats missing family context as unavailable.

The server continues accepting the immediately previous selection shape for stale PWA clients. A legacy payload has exactly today's semantics: established deterministic `linkPeople` actions apply normally, ambiguous selections remain restricted to the candidates in that plan, and the request cannot create holds, exclusions, arbitrary manual links, or create-new identity decisions. The legacy path remains separate from the new validator so an omitted new field cannot be mistaken for a new-client **Accept** or **Skip** decision.

Schema changes are additive. Existing churches begin with no exclusions and no holds, so matching behavior remains unchanged until an administrator uses the new controls.

The obsolete Planning Center provider-person search picker and legacy selection adapter should not be reused as the core design: they search the opposite side of the comparison and are not connected to the current provider-neutral review. They may be removed once the new shared local-person picker and apply contract replace all remaining references.

## Success criteria

- An administrator can distinguish same-name people using family context on both sides.
- Every proposed new identity link can be accepted, redirected, created separately, deferred, or pair-excluded.
- A deliberate defer or rejection cannot be silently undone by unattended sync.
- Planning Center and Elvanto present the same review behavior.
- No invalid, cross-church, stale, or colliding identity decision can be applied.
- The review visually matches the rest of Settings across desktop, mobile, light mode, and dark mode.
