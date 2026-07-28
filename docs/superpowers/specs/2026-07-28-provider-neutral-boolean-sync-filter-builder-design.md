# Provider-Neutral Boolean Sync Filter Builder Design

**Date:** 2026-07-28
**Status:** Design approved in conversation; awaiting written-spec review
**Applies to:** Planning Center and Elvanto people-sync batches

## Summary

Planning Center and Elvanto will share one constrained Boolean filter engine and one filter-builder interaction. Users can create bracketed filter groups, join groups with AND, create alternative OR branches, and apply any number of batch-wide NOT exclusions. The builder shows a running match count and overlap with other enabled batches from a clearly dated cached provider snapshot; changing a filter never triggers a provider fetch implicitly.

This is a saved-segment engine, not a provider-specific collection of checkboxes and not a general-purpose expression-tree editor. It gives churches enough depth to target people without first creating artificial tags, groups, or fields in Planning Center or Elvanto, while remaining explainable, countable, migratable, and safe for strict source-of-truth operation.

## Goals

- Give Planning Center and Elvanto batches identical AND, OR, and NOT semantics.
- Let users target combinations of existing provider characteristics without modifying the provider first.
- Keep every expression visually understandable as bracketed groups and visible OR branches.
- Show an exact-as-of-snapshot match count without running a lengthy sync on every edit.
- Show overlap with other enabled batches before a filter is saved or applied.
- Ensure count preview, reviewed reconciliation, and unattended sync use the same evaluator.
- Keep version-1 batches operating unchanged until their user explicitly upgrades them.
- Preserve strict behaviour: changed criteria cannot affect LMPG people until a full reviewed reconciliation applies successfully.

## Non-goals

- Arbitrarily nested parentheses or a general Boolean abstract syntax tree.
- Text contains/starts-with matching, regular expressions, date ranges, or numeric comparisons in version 2.
- Provider-side saved-list, tag, group, or custom-field creation.
- Fetching provider data automatically in response to each filter edit.
- Replacing batch schedules, gathering assignments, source-of-truth controls, or sync review.
- Aligning every non-filter field in the PCO and Elvanto batch forms in this work. The shared filter area becomes visually consistent now; the remaining form-style parity is a later pass.

## Terminology

- **Dimension:** One filterable provider characteristic, such as People Status, Membership, Category, Groups, or a particular custom field.
- **Value:** A selectable value inside a dimension.
- **Bracket:** One dimension plus its selected positive values and its `any` or `all` mode.
- **Branch:** One or more brackets joined by AND.
- **Expression:** One or more branches joined by OR.
- **Global exclusion:** A dimension value selected as NOT. It vetoes the person across every branch.
- **Filter facts:** The minimal, church-isolated projection needed to evaluate a provider person: external ID and dimension value IDs only.
- **Active filter:** The filter currently used by reviewed and unattended sync.
- **Draft filter:** A saved filter edit that has not yet passed full review and therefore cannot affect LMPG people.

## User Experience

Both providers use one shared `FilterBuilder` component. Provider metadata supplies the available dimensions, values, cardinality, labels, and counts.

### Match summary

The builder header shows:

- `N people match`.
- `Data updated <relative time>` and the exact snapshot timestamp.
- A stale indicator after ten minutes.
- `Count unavailable` when no usable or sufficiently covered snapshot exists.
- An explicit `Refresh people data` action. This is the only builder action that may perform a lengthy provider fetch.
- Expandable overlap details and the unique population across all enabled batches.

The matching total is the external provider population that would qualify for this batch after the same provider-wide population gates used by real sync. For example, Elvanto contacts are excluded when the church-wide `include contacts` setting is off, and terminal provider states do not inflate the importable count. Actual LMPG additions, links, updates, restorations, and archives remain the responsibility of sync review.

### Positive branches

- A non-empty positive filter begins with Branch 1.
- `+ AND filter type` adds another dimension bracket to the current branch.
- A dimension may appear at most once in one branch.
- `+ OR alternative branch` creates another qualification route.
- Every bracket in a branch must match; any positive branch may qualify the person.
- Version 2 does not require drag-and-drop or arbitrary group nesting.

### Brackets and values

- Multi-valued dimensions provide `Match any` and `Match all`.
- A new multi-valued bracket defaults to `Match all (AND)`. With one included value, `any` and `all` are equivalent; the distinction becomes visible when a second value is included.
- Single-valued dimensions are fixed to `Match any`; `Match all` is not displayed because two positive values could never both match.
- Long value lists are searchable.
- Each value is Off, Included, or NOT.
- Selecting NOT removes the same dimension/value from every positive branch and places it in the batch-wide exclusion set.
- A value cannot be both included and excluded.
- Any number of values may be selected as NOT.
- Missing provider values appear as a `Not set` option when at least one cached person lacks the dimension value.

### Always exclude

Global exclusions appear in a persistent red-tinted `Always exclude` summary, grouped by dimension. If any exclusion matches, the person fails the entire batch even when a positive branch matches. Users may remove exclusions from the summary or from the source dimension picker.

### Empty and broad filters

- No branches and no exclusions matches nobody.
- No branches with at least one exclusion is an approved NOT-only filter: everyone in the provider population gate qualifies except excluded people.
- NOT-only filters show a broad-match warning.
- A filter matching the entire provider population shows a broad-match warning.
- Removed or renamed provider values remain visible as unresolved selections; the application never silently deletes them. Preview explains their current zero-match effect.

### Example

```text
Branch 1
  Status: Active OR Contact
  AND
  Category: Member

OR Branch 2
  Group: Youth OR Young Adults

Always exclude
  Category: Visitor
  Custom field “Do not sync”: Yes
```

The positive expression is `(Status bracket AND Category bracket) OR Group bracket`. The two exclusions then veto matching people across both branches.

## Provider-Neutral Metadata and Facts

### Dimension metadata

Each provider exposes this canonical shape:

```ts
interface FilterDimension {
  id: string;
  label: string;
  cardinality: 'single' | 'multi';
  category: string;
  values: Array<{
    id: string;
    label: string;
    count: number;
  }>;
}

interface FilterMetadata {
  provider: 'planning_center' | 'elvanto';
  dimensions: FilterDimension[];
  snapshot: null | {
    id: string;
    capturedAt: string;
    fresh: boolean;
    expiresAt: string;
    coveredDimensionIds: string[];
  };
}
```

Dimension and value IDs are provider-scoped stable identifiers. Where Elvanto exposes only a stable normalized name, that exact value is the ID and label. A reserved internal value ID, `$not_set`, represents an absent dimension value; provider values equal to that literal are escaped before entering the canonical model.

### Person filter facts

```ts
interface PersonFilterFacts {
  externalPersonId: string;
  dimensions: Record<string, string[]>;
}
```

An absent or empty dimension array matches `$not_set`. Facts contain no person name, email address, phone number, address, family details, or raw provider record. Custom-field values may still be sensitive filter facts, so this projection remains server-memory-only and church-isolated.

### Provider mappings

Planning Center initially exposes:

- Membership as a single-valued dimension.
- Each supported custom field as its own dimension.
- Custom-field cardinality derived from its Planning Center definition.
- Observed exact field values plus `Not set` where applicable.

Elvanto initially exposes:

- People Status as single-valued.
- Category as single-valued.
- Groups, Demographics, Departments, Service Types, and Locations as multi-valued.
- Each supported custom field as its own dimension, with cardinality derived from its definition.
- Observed or definition-backed exact values plus `Not set` where applicable.

Provider terminal states are not emitted as selectable positive filter values because provider-neutral lifecycle handling already excludes or archives them. The population gate is applied before count and sync eligibility, so metadata totals cannot misrepresent terminal people as importable.

## Filter Schema Version 2

`people_sync_batches.filter_schema_version = 2` uses:

```ts
interface BooleanFilterConfigV2 {
  branches: Array<{
    groups: Array<{
      dimensionId: string;
      mode: 'any' | 'all';
      values: string[];
    }>;
  }>;
  exclusions: Array<{
    dimensionId: string;
    values: string[];
  }>;
}
```

Validation rules:

- At most 20 branches, 50 total groups, and 500 total selected values.
- Branches and groups stored in the config are non-empty.
- A dimension appears at most once per branch and once in exclusions.
- Values within a group or exclusion are de-duplicated.
- `all` is rejected for single-valued dimensions.
- An `all` group cannot combine `$not_set` with another value because the combination is contradictory.
- Every dimension and value must belong to provider metadata when first selected. Previously saved values missing from current metadata are retained as unresolved rather than deleted.
- A dimension/value pair cannot appear in both positive groups and exclusions.
- Unknown keys and malformed values are rejected.

## Evaluation Semantics

The shared pure evaluator is the sole authority for count preview and sync eligibility.

For one positive group:

- `any` succeeds when at least one selected value matches the person's dimension facts.
- `all` succeeds when every selected value matches the person's dimension facts.
- `$not_set` matches when the person has no value for that dimension.

For one branch, every group must succeed. For the positive expression, any branch may succeed.

```text
positiveMatch =
  branches are non-empty
    ? any branch matches
    : exclusions are non-empty
      ? true
      : false

excluded = any selected exclusion value matches

eligible = populationGate(person) AND positiveMatch AND NOT excluded
```

Global exclusions are always batch-wide. They are not scoped to the branch or bracket from which the user selected them.

## Filter-Facts Cache and Counts

The server holds at most one latest complete filter-facts snapshot per church/provider in a bounded in-memory cache.

- Only a successful, complete full provider snapshot may populate or replace it.
- An incremental Elvanto snapshot must never replace it.
- It is fresh for ten minutes and may still be used, clearly labelled stale, for up to 24 hours.
- It is cleared on provider disconnect and disappears harmlessly on server restart.
- It is never returned to the browser.
- The cache records which dimensions are covered. Missing coverage produces `Count unavailable`; it must never be treated as an empty value or a zero match.
- PCO populates it from its existing complete people cache when that cache is available; otherwise count remains unavailable until an explicit refresh or complete preview populates it.
- Elvanto populates it during explicit people-data refresh, full reviewed preview, or full reconciliation.
- An Elvanto refresh requests the union of custom-field dimensions required by active filters and the current draft. It does not retrieve every custom field automatically when unnecessary.

The client debounces draft preview requests. A preview performs no provider network access and returns:

```ts
interface FilterPreviewResult {
  matchCount: number | null;
  snapshot: FilterMetadata['snapshot'];
  overlaps: Array<{ batchId: number; batchName: string; count: number }>;
  uniqueEnabledPopulationCount: number | null;
  missingDimensionIds: string[];
  warnings: string[];
}
```

When editing an existing batch, overlap and union calculations replace that batch's active filter with the draft for the purpose of the preview. When creating a batch, they report the proposed union if the new batch were enabled. Other enabled batches are evaluated through their own schema-version evaluator.

Overlap is informational, not an error. The source-of-truth population remains the union of all enabled batches, and gathering eligibility remains batch-specific. The overlap panel also flags when overlapping batches assign different gatherings or carry different new-person defaults, while preserving the existing provider-neutral resolution rules.

## Active and Draft Filter Lifecycle

Saving edited criteria must not make them active before review. The batch table therefore retains the current filter columns as the active filter and gains draft state:

- `draft_filter_schema_version`
- `draft_filter_config`
- `draft_filter_base_revision`
- `draft_filter_updated_at`
- `filter_revision`, incremented whenever an active filter is promoted

The presence of a draft means `Needs full review`.

- Count preview evaluates the draft.
- Normal batch display shows both that a draft exists and that the active sync still has different criteria.
- A new version-2 batch has a nobody-matching active filter until its first reviewed promotion.
- A reviewed full preview evaluates the proposed draft for that batch and every other batch's active filter.
- Applying that review promotes the draft and applies all resulting people/link/family/gathering changes in the same church database transaction.
- The apply is guarded by active revision, draft digest, provider, church, full-snapshot identity, and review token. Any change rejects the apply as stale.
- Failed apply leaves both LMPG people and the active filter unchanged; the draft remains available for correction or retry.
- While an enabled authoritative provider has a non-migration filter draft, unattended provider sync is blocked with a review-required status. This avoids either the old or new criteria changing people while intent is unresolved.
- Successful promotion resumes scheduled operation. Elvanto cannot use an incremental snapshot to perform the first reconciliation for a newly promoted filter.

## Version-1 Upgrade

Version-1 PCO and Elvanto batches continue to evaluate and schedule exactly as they do now until explicitly upgraded. Merely deploying version 2 does not create a draft and does not pause version-1 schedules.

### Deterministic conversion

PCO conversion preserves current semantics:

- Enabled membership values become one branch containing a single-valued Membership `any` bracket.
- Enabled custom-field rules become a separate OR branch.
- Custom-field rules in that branch remain AND-connected; values inside each rule remain `any`.
- If only one source is enabled, only its branch is created.
- Disabled or empty sources do not become match-all branches.

Elvanto conversion preserves current semantics:

- Every populated dimension becomes a bracket in one branch.
- Brackets remain AND-connected.
- Existing `any`/`all` selection modes map directly.
- Status and category use `any`.
- Custom-field rules remain AND-connected brackets.

No conversion creates an exclusion.

### Reviewed upgrade flow

- Upgrade preview converts in memory and evaluates v1 and v2 against the same complete cached snapshot and population gate.
- Compatibility requires equality of exact matched external-person ID sets, not merely equal counts.
- The UI displays the converted expression, old/new count, overlap impact, and snapshot age.
- A signed upgrade token binds church, provider, batch ID, active revision/config digest, snapshot ID, converted v2 digest, and matched-set comparison result.
- Upgrade apply rejects a stale token or changed batch/snapshot.
- Exact-equivalent batches may be upgraded individually or through `Upgrade all compatible batches`.
- Any mismatch requires individual review and cannot bulk-upgrade.
- Failed upgrade leaves the active version-1 filter untouched.
- Upgrade preview itself is not stored as a normal filter draft and therefore does not pause the existing version-1 schedule.

## API Boundaries

Provider-neutral authenticated admin routes provide:

- Filter metadata and cache status for one provider.
- Draft preview with count, overlap, union, warnings, and missing coverage.
- Explicit people-data refresh through the provider adapter.
- Version-1 upgrade preview.
- Reviewed upgrade apply.
- Draft save, discard, full reconciliation preview, and reviewed promotion.

Every route is church-scoped and provider-scoped. Draft bodies are size-limited and strictly validated. Preview and count endpoints never return person-level facts or matched external IDs. External ID sets remain server-side inputs to equality and overlap calculations.

## Error and Safety Behaviour

- Count failure never writes a batch or mutates people.
- Missing cache or dimension coverage returns an unavailable result, never a fabricated zero.
- Provider refresh failure preserves the last usable cached snapshot until its 24-hour expiry and labels it stale.
- A stale client response cannot overwrite a newer count; the client cancels or sequence-checks debounced requests.
- Unknown or contradictory rules fail closed with a specific validation error.
- Unresolved saved values remain visible with warnings and their current zero-match effect.
- Empty filters match nobody.
- NOT-only and whole-provider filters require an explicit broad-match acknowledgement before draft save.
- Filter changes cannot bypass full review, including through a scheduled Elvanto incremental run.
- V1 schedules continue until an explicit upgrade; failed upgrades are non-destructive.
- All caches and queries remain church-isolated.

## Testing Strategy

### Shared engine

- Literal truth tables for branch OR, group AND, `any`, `all`, `$not_set`, multiple global exclusions, NOT-only, and empty filters.
- Validation of cardinality, limits, duplicates, include/exclude conflicts, contradictory `all + $not_set`, and unknown dimensions.
- Deterministic summaries independent of input order.

### Provider adapters

- PCO membership/custom-field fact extraction and cardinality.
- Elvanto status/category/group/demographic/department/service/location/custom-field fact extraction.
- No names or contact details in cache projections.
- Missing-dimension coverage is distinguished from a genuinely unset person value.
- Only complete full snapshots replace the cache.

### Counts and overlap

- Preview performs zero provider calls.
- Snapshot freshness and 24-hour expiry.
- Exact batch count, pairwise overlap, and unique enabled union.
- Editing replaces the current batch in union calculations; creation adds a proposal.
- V1 and v2 batches participate together.
- Population gates make count results agree with sync eligibility.
- Cross-church access is rejected.

### Draft and reconciliation lifecycle

- Saving a draft does not change active eligibility.
- Unattended authoritative sync is blocked while a normal draft is pending.
- Full reviewed apply promotes the draft and reconciliation atomically.
- Stale revision, digest, snapshot, or review token rolls back all work.
- Successful promotion requires a complete full snapshot and resumes scheduled operation.

### V1 upgrade

- PCO and Elvanto conversions preserve literal matched ID sets across representative configurations.
- Equal counts with different IDs fail compatibility.
- Bulk upgrade accepts only exact-compatible batches.
- Stale and failed upgrades preserve v1 and its schedule.

### React builder

- Shared rendering for both providers.
- Branch creation/removal and AND-only grouping within branches.
- Single-valued dimensions do not offer `all`.
- Selecting NOT removes positive occurrences globally.
- Multiple exclusions and NOT-only filters.
- Search, keyboard access, focus management, and accessible names.
- Debounced count race handling, stale/unavailable states, overlap display, and explicit refresh.
- Broad-match acknowledgement and unresolved-value warnings.
- V1 upgrade comparison and bulk eligibility.

## Acceptance Criteria

- A user can express `(A AND B) OR (C AND D)` with batch-wide `NOT E` without changing PCO or Elvanto configuration.
- PCO and Elvanto evaluate an equivalent canonical filter identically after provider fact extraction.
- The builder never permits mixed positive AND/OR modes inside one bracket.
- Single-valued dimensions never permit `all`.
- Multiple NOT selections veto every branch.
- Match counts and overlaps are exact for the displayed cached snapshot and cause no implicit provider fetch.
- Preview and real sync use the same evaluator and population gates.
- Active source-of-truth filters cannot change without a complete reviewed reconciliation.
- Existing v1 batches continue unchanged until explicitly, safely upgraded.
- The filter-builder area is shared and visually consistent across PCO and Elvanto.
