# Batch-Scoped Identity Review Design

## Goal

Make people-sync identity review follow the batch-oriented user interface. A normal batch review should ask administrators to decide only identities in the selected provider-owned source, allow resolved choices to be applied while other identities remain pending, and show accurate unresolved-decision notes beneath every relevant batch.

This applies equally to Planning Center and Elvanto. Provider-wide source-of-truth safety remains intact.

## Current Problem

A normal batch review currently reads every enabled source and exposes identity decisions for their entire union. This is safe for authoritative lifecycle calculations, but it makes a review for a one-person List display decisions from unrelated batches.

The current identity UI is also all-or-nothing. Deterministic suggestions and additions are initialized as selected, but one identity without a decision disables Apply. Choices remain browser-local until the entire review applies, so leaving the page loses them. A row labelled `Matched` can therefore look durable when it is only a proposed choice in the current browser session.

Kingston CRC's migrated database was inspected while designing this change. Its 591 `planning_center_id` values all have matching durable `external_person_links`, no Planning Center migration conflicts are recorded, and four reviewed applications wrote matched, created, and manual links successfully. The source-of-truth migration is therefore not dropping those links. The misleading all-or-nothing review behavior remains the likely explanation for choices that appeared not to stick.

## Scope

This design changes:

- identity decision scope for normal batch reviews;
- partial application of resolved identity choices;
- durable attribution of unresolved identities to batches;
- batch-card warnings for unresolved decisions;
- provider terminology in the identity review table; and
- regression coverage for legacy/backfilled link persistence.

It does not change:

- provider-owned source membership rules;
- the authoritative provider-wide population union;
- lifecycle eligibility rules;
- archive confirmation policy;
- established-link correction preview signing;
- source-draft promotion fencing;
- church isolation; or
- the rule that only one provider is authoritative.

## Reconciliation Model

### Provider-wide safety state

Every reviewed or unattended reconciliation continues to fetch complete snapshots for every participating enabled batch. The orchestrator keeps the per-batch eligible external-person ID sets and their provider-wide union.

The union continues to protect:

- lifecycle presence and archive decisions;
- managed-field and people-type behavior;
- household/family context;
- overlap resolution;
- gathering additions and provenance-safe removals; and
- source and connection freshness guarantees.

No single-batch shortcut may infer absence, archives, or gathering removal from the selected source alone.

### Decision scope

For a normal batch review with a positive `batchId`, the signed identity review context contains decision entries only for external IDs eligible in that batch's effective source:

- use the target batch's draft source while reviewing a source draft;
- otherwise use the target batch's active source.

Already-linked identities and established-link correction controls use the same target membership scope.

People from other enabled sources remain available internally for matching corroboration and provider-wide planning, but they do not appear as identity decisions in the selected batch review and cannot receive identity corrections through that review.

An unestablished identity outside the selected batch is not implicitly accepted merely because the matcher found a deterministic suggestion. It remains pending beneath its relevant batches, and all mutations that depend on that unaccepted identity are suppressed. Provider-wide managed and lifecycle actions may still apply to people whose durable provider links were established previously.

An authority-switch review has no selected batch and remains provider-wide. It may expose decisions for every participating target-provider source while retaining per-batch attribution.

## Partial Identity Apply

An unresolved identity no longer disables Apply by itself.

When the administrator applies a signed review:

- accepted deterministic suggestions create durable provider links;
- explicit manual links create durable provider links;
- accepted additions create and link people from signed create data;
- explicit `Skip for now` choices remain deferred;
- identity entries with no submitted decision are canonically treated as deferred;
- deferred or rejected identities persist through the existing hold and exclusion repositories; and
- accepted links or creations clear obsolete holds and applicable exclusions.

The server, not the client, canonicalizes omitted in-scope decisions to deferred outcomes. This preserves compatibility with stale clients and prevents a client from silently omitting an identity to bypass signed review rules.

Partial identity apply does not weaken other blockers. Apply remains disabled or rejected for:

- claimed-local-person collisions;
- stale or expired review tokens;
- source, connection, authority, or batch-configuration changes;
- unsigned or failed established-link correction previews;
- incomplete required archive review;
- unconfirmed destructive changes; and
- malformed or cross-church input.

Source promotion, resolved identity mutations, deferred-state persistence, batch pending projection, gathering changes, and authority activation where applicable commit through the existing guarded transaction boundary. A failure rolls back all of them.

## Batch Pending Identity Projection

### Purpose

The existing provider-scoped holds and exclusions remain the authority for identity decisions. A new provider-neutral projection answers a separate UI question: which batch cards contain each currently unresolved external identity?

### Schema

Add a projection-state table with one row per observed batch. It records:

- `church_id`;
- `provider`;
- `batch_id` as its primary key;
- whether the observed source was active or draft;
- the observed source identity digest;
- the observed source revision/base revision;
- `observed_at`; and
- `created_at` and `updated_at` timestamps.

Add a child table with one row per unresolved external person per relevant batch. Required fields are:

- `church_id`;
- `provider`;
- `batch_id`;
- `external_person_id`;
- `reason`;
- `created_at` and `updated_at` timestamps.

The child-table unique key is church, provider, batch, and external person. Both batch foreign keys use `ON DELETE CASCADE`, and deleting projection state cascades its item rows. Queries always include `church_id` and provider.

The projection stores provider IDs and status only, not names, contacts, raw provider records, or source membership rules.

### Projection updates

After a complete, validated provider read, calculate the unresolved external identities and attribute each one to every participating batch whose eligible set contains it.

For projection purposes, an eligible external identity is unresolved until it has a durable provider link or is resolved by the current reviewed apply. A deterministic suggestion or signed create proposal in a different batch is still unresolved because it was outside the selected decision scope.

Projection replacement is source-aware:

- replace only data covered by successful complete snapshots;
- never replace a valid projection after provider, pagination, completeness, connection-generation, or source-identity failure;
- bind each batch projection state to the observed source identity/revision;
- exclude rows whose observation no longer matches the batch's visible active/draft source;
- remove a resolved identity from every batch represented by the fresh union; and
- remove or ignore draft-derived rows when that draft is discarded or superseded.

A successful manual review may refresh this observational projection before Apply so that backing out still leaves accurate batch notes. User decisions themselves remain unchanged until Apply. A partial Apply replaces the affected projection transactionally using the canonical accepted/deferred outcomes.

Unattended runs update the same projection after a complete source read. This allows newly ambiguous identities to appear on batch cards without an administrator first opening a review.

Existing holds have no historical batch ownership. They become attributable the next time complete sources are successfully read. No startup migration performs provider network calls.

## Batch API and UI

Batch list responses add `unresolvedIdentityCount: number | null`, derived from current, source-matching projection state and item rows. The count is `0` when a valid projection contains no unresolved identities and `null` when that batch's current effective source has not been observed. The client shows no warning for `null` and must not present it as a confirmed zero.

Every relevant batch containing an unresolved overlapping person reports that person. No arbitrary owning batch is selected.

Planning Center and Elvanto batch cards render singular/plural copy:

- `1 identity decision still needs review.`
- `N identity decisions still need review.`

The existing Review action opens the batch review. When its unresolved count is positive, the review initializes the Decisions tab with `Needs attention` selected. Administrators can change filters normally after load.

## Review UI

The blocking warning `Ava needs a decision before you can apply this sync` becomes non-blocking pending copy such as `Ava will remain pending after this sync`, retaining a shortcut to focus that identity.

The Apply button remains available when only unresolved identities are outstanding. Its selected-change count describes mutations that will commit; pending identities are disclosed separately and are not presented as applied changes.

The existing search remains tab-aware: when the active tab has no match and the other identity tab has one, search switches tabs and retains the query.

### Provider terminology

The identity table derives a safe display label from the signed review provider:

- Planning Center desktop headings: `Planning Center name` and `Planning Center family/household`;
- Elvanto desktop headings: `Elvanto name` and `Elvanto family/household`;
- mobile provider heading: `Planning Center` or `Elvanto`; and
- LMPG headings remain unchanged.

Generic `External source` or `Integration source` headings are removed from this review table.

## Failure and Staleness Semantics

- Incomplete provider snapshots never alter the pending projection.
- A stale review cannot apply resolved decisions, deferred state, source promotion, or projection changes.
- A failed partial apply leaves existing links, holds, exclusions, and pending projection unchanged.
- A source draft failure never changes active-source health or active-source pending attribution.
- Discarding or replacing a draft immediately prevents draft-bound projection rows from contributing to card counts.
- Deleting a batch cascades only that batch's projection rows and does not delete provider holds shared with other batches.
- Resolving an overlapping identity through any relevant batch clears its hold and all fresh relevant batch projections in the same reviewed transaction.
- All repository reads and writes remain church-scoped.

## Testing Strategy

### Plan and orchestrator tests

- A normal target-batch review fetches all enabled sources but signs identity decisions only for the target eligible set.
- A target draft replaces only that batch's active source for decision scope and union planning.
- An authority-switch review remains provider-wide.
- Other-batch members continue protecting lifecycle and gathering removals.
- A correction for an identity outside the target source is rejected.

### Apply and persistence tests

- An omitted signed identity is canonicalized to deferred and does not block resolved choices.
- A partial apply writes resolved links/people and unresolved holds in one transaction.
- A failed source promotion or stale fence rolls back resolved links, holds, and projection rows.
- A resolved match is absent from the next complete review.
- A legacy-backfilled Planning Center link remains established after source-of-truth activation and is not resurfaced as a suggestion.
- Deferred and rejected decisions survive process restart and fresh review.

### Pending projection tests

- One unresolved overlapping external ID creates rows beneath both relevant batches.
- Resolving it removes both rows.
- Removing it from one source removes only that batch attribution after a fresh complete read.
- Source replacement and draft discard suppress stale rows.
- Failed or incomplete reads preserve the last valid projection.
- Batch deletion cascades projection rows without deleting shared provider holds.
- Cross-church batches, identities, and counts cannot affect one another.

### Client tests

- Batch cards show correct singular/plural counts for Planning Center and Elvanto.
- Pending batches open with Needs attention selected.
- Unresolved identities no longer disable Apply by themselves.
- Pending disclosure distinguishes deferred identities from selected mutations.
- Planning Center and Elvanto headings render correctly in desktop and mobile layouts.
- Cross-tab search continues surfacing established matches.

## Rollout

The schema change is additive. Existing provider links, compatibility IDs, holds, exclusions, source drafts, and run history remain unchanged.

After deployment:

1. unique legacy Planning Center compatibility IDs continue to resolve through their durable backfilled links;
2. existing unresolved holds gain batch attribution after the next successful complete read;
3. new reviewed or unattended reconciliations maintain the batch projection; and
4. no background provider fetch is performed solely for migration.

Operational validation should include Kingston CRC because it contains legacy-backfilled links, reviewed links created during the authority transition, multiple overlapping Planning Center Lists, and an existing deferred hold.
