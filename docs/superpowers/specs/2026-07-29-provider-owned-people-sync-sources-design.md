# Provider-Owned People Sync Sources Design

**Date:** 2026-07-29
**Status:** Implemented
**Applies to:** Planning Center and Elvanto people-sync batches

**Operational runbook:** [Provider-owned sync source cutover](../../runbooks/provider-owned-sync-source-cutover.md)

## Summary

Let My People Grow (LMPG) will stop defining and evaluating its own people-sync
filters. Each sync batch will instead reference exactly one segment maintained
inside the church's chosen church management system (ChMS):

- one Planning Center List; or
- one Elvanto People Category or Group.

The ChMS owns the question "who belongs in this batch?" LMPG reads the selected
segment without modifying it, then retains responsibility for stable provider-ID
links, initial matching, household context, reviewed reconciliation, gathering
assignment, cross-batch population ownership, scheduling, and transactional
apply.

This is a coordinated clean cutover. The unshipped provider-neutral Boolean
filter builder, its schema-version-2 engine, and the legacy version-1 filter
evaluator will be removed rather than supported alongside provider-owned
segments. The one church currently using one version-1 Planning Center batch
will be guided through creating and selecting an equivalent Planning Center
List.

## Decision

The selected approach is **one provider-owned segment per batch with a
coordinated cutover**.

Rejected alternatives:

1. A temporary legacy bridge would leave two eligibility systems and create a
   second removal project for one production batch.
2. A hybrid source-plus-local-filter model would recreate the Boolean-builder
   complexity and split responsibility for eligibility across two products.
3. Multiple source segments per batch would immediately reintroduce union and
   intersection semantics. A church that needs a compound segment must express
   it in its ChMS.

## Goals

- Make batch eligibility understandable: membership in one named provider
  segment means eligibility for that batch.
- Put rule authoring in the ChMS, where users already manage people data.
- Keep Planning Center access read-only; LMPG never runs, refreshes, creates,
  edits, or deletes a List.
- Preserve reviewed source changes so a selection cannot affect scheduled sync
  before an administrator reviews the resulting reconciliation.
- Continue using stable provider person IDs as identity; names remain matching
  evidence, never identity.
- Fail closed when a selected source cannot be read completely.
- Remove the local filter engine, facts cache, preview, draft-filter, and
  schema-upgrade machinery.

## Non-goals

- Creating or editing Planning Center Lists, Elvanto Categories, or Elvanto
  Groups from LMPG.
- Combining multiple Lists, Categories, or Groups inside one batch.
- Adding local include, exclude, AND, OR, date, numeric, custom-field, or
  membership rules after a source is selected.
- Treating source names as durable identifiers.
- Replacing the existing matcher, reconciliation review, gathering assignment,
  source-of-truth controls, or transactional apply.
- Automatically converting a legacy filter into a provider segment. Doing so
  would require writing provider configuration or guessing user intent.

## Terminology

- **Provider source:** A Planning Center List, Elvanto People Category, or
  Elvanto Group selected by a batch.
- **Active source:** The reviewed source currently used by normal and scheduled
  sync.
- **Draft source:** A saved source selection that has not yet completed reviewed
  reconciliation.
- **Source snapshot:** A complete read of the selected source, its current
  metadata, and all current member IDs and required person/household data.
- **Provider refresh time:** Planning Center's `refreshed_at` value for a List.
- **LMPG read time:** The time LMPG successfully completed a source read.

## Provider Capabilities

### Planning Center

Planning Center People exposes Lists and their people/results through its REST
API:

- `GET /people/v2/lists`
- `GET /people/v2/lists/{list_id}`
- `GET /people/v2/lists/{list_id}/people`
- `GET /people/v2/lists/{list_id}/list_results`

List metadata includes `refreshed_at`, which LMPG displays as informational
provenance. The adapter may use either the people association or paginated List
Results with included people, provided it proves the returned membership is
complete and preserves stable Planning Center person IDs.

LMPG must never call the List `run` action or make any List `POST`, `PATCH`, or
`DELETE` request. The church owns List refresh and automation behavior in
Planning Center.

Official API references:

- <https://api.planningcenteronline.com/docs/apps/people/versions/2025-11-10/vertices/list>
- <https://api.planningcenteronline.com/docs/apps/people/versions/2025-11-10/vertices/list_result>

### Elvanto

Elvanto exposes People Categories, Groups, category-scoped people retrieval,
and group searches:

- `people/categories/getAll`
- `groups/getAll`
- `people/getAll` with `category_id`
- `people/search` with `search[groups]`

Elvanto does not expose a provider-maintained segment refresh timestamp
equivalent to Planning Center Lists. LMPG therefore displays its own last
successful read time for Elvanto sources.

Official API references:

- <https://www.elvanto.com/api/people/categories/getAll/>
- <https://www.elvanto.com/api/groups/getAll/>
- <https://www.elvanto.com/api/people/getAll/>
- <https://www.elvanto.com/api/people/search/>

## User Experience

The batch editor replaces **Who qualifies?** and the Boolean filter builder with
a compact **People source** section.

### Planning Center

```text
People source

Planning Center List
[ Sunday Attendance                         v ]

243 people
Last refreshed 4 days ago
If recent members are missing, refresh this List in Planning Center.
```

The selector lists Lists visible to the connected Planning Center user. Each
option is keyed by List ID and labelled with the current List name. The selected
source summary shows its current member count and provider refresh time.

### Elvanto

```text
People source

Source type
[ Category ] [ Group ]

Group
[ Regular Attenders                        v ]

186 people
Last checked by LMPG 12 minutes ago
```

Changing source type clears the source selection. The user must then choose
exactly one Category or Group.

### Freshness presentation

Planning Center List freshness is informational, not a warning or validation
state. Manual and unattended sync continue regardless of age.

At display time, the refresh text uses:

- green when age is less than or equal to 7 days;
- orange when age is greater than 7 days and less than or equal to 30 days;
- red when age is greater than 30 days; and
- neutral grey when `refreshed_at` is unavailable or invalid.

The UI always includes text with the relative age and exposes the exact
timestamp. Colour is supplementary and is never the only signal. The UI does
not use "stale" wording, a warning banner, or a confirmation checkbox.

Planning Center batches also show the neutral helper text **If recent members
are missing, refresh this List in Planning Center.** This explains where
freshness is controlled without implying that an older List is invalid or
asking LMPG to run it.

For Elvanto, the equivalent line is **Last checked by LMPG**, based on the last
complete source read. It does not imply that Elvanto maintains a source refresh
time.

### Renames and unavailable sources

Stable external IDs are authoritative. A source rename does not break the
batch; after a successful read, LMPG updates the stored display-name snapshot.

If a source is no longer visible, the editor retains its last known name and
shows **Source missing**. The batch enters a persisted missing-source state,
scheduled reconciliation is skipped, and active administrators receive one
deduplicated notification for that transition. LMPG never silently clears the
selection or converts an unavailable source into an empty source.

## Data Model

Add the following nullable active-source columns to
`people_sync_batches`:

```text
source_kind
source_external_id
source_name
source_revision INTEGER NOT NULL DEFAULT 1
```

Add the following draft-source columns:

```text
draft_source_kind
draft_source_external_id
draft_source_name
draft_source_base_revision
draft_source_updated_at
```

Add operational source-health columns:

```text
source_status TEXT NOT NULL DEFAULT 'unknown'
source_status_checked_at
source_status_error_code
```

Allowed statuses are `unknown`, `available`, `missing`, and `error`. These
columns describe the active source only. Status and last-check updates do not
increment `source_revision` because they record provider-read health, not user
intent.

`source_revision` starts at 1 and increments whenever a reviewed draft source
is promoted. During coordinated migration, a batch with no active source is
reported as requiring source selection.

Allowed source kinds are:

```text
planning_center_list
elvanto_category
elvanto_group
```

The provider/source-kind combinations are exact:

- `planning_center` accepts only `planning_center_list`;
- `elvanto` accepts only `elvanto_category` or `elvanto_group`.

Source IDs are non-empty provider IDs stored as text. Names are last-known
display snapshots only. More than one batch may reference the same source;
existing overlap and gathering-resolution behavior remains responsible for
that case.

Existing active and draft filter columns remain in SQLite under the project's
additive-only schema convention. New runtime code does not read or write them
after cutover.

## Provider-Neutral Source Contract

Each provider adapter exposes two source operations in addition to the existing
person normalization and connection operations:

```ts
interface ProviderSource {
  kind: 'planning_center_list' | 'elvanto_category' | 'elvanto_group';
  externalId: string;
  name: string;
  memberCount: number | null;
  providerRefreshedAt: string | null;
}

interface ProviderSourceSnapshot {
  provider: 'planning_center' | 'elvanto';
  source: ProviderSource;
  complete: true;
  fetchedAt: string;
  people: NormalizedPerson[];
  families: NormalizedFamily[];
}

listSources({ churchId, credentials }): Promise<ProviderSource[]>

fetchSourceSnapshot({
  churchId,
  credentials,
  sourceKind,
  sourceExternalId,
}): Promise<ProviderSourceSnapshot>
```

The implementation may use the repository's established JavaScript object
style rather than TypeScript. The semantic fields and guarantees above are
normative.

`complete: true` is returned only after every provider page and every required
normalization dependency has succeeded. A partial snapshot is never returned.
An empty but complete source is valid and contains `people: []`.

### Pagination and rate limits

Source snapshot reads must be safe for large churches. Planning Center List
membership uses the endpoint maximum `per_page=100` and follows the provider's
pagination links until no next page remains. Elvanto uses its supported page
size and existing paginated collection client. Page traversal is sequential;
the adapter must not launch an unbounded request fan-out.

Planning Center rate limits are dynamic. The HTTP client reads
`X-PCO-API-Request-Rate-Limit`, `X-PCO-API-Request-Rate-Period`, and
`X-PCO-API-Request-Rate-Count`, and follows `Retry-After` on HTTP 429. It must
not hard-code the currently documented default quota. Retries are bounded and
safe because Planning Center source operations are GET-only. If required
household context cannot be included in the paginated people response,
follow-up reads use bounded concurrency and the same rate-limit handler rather
than an unbounded per-person loop.

Elvanto pagination is likewise sequential. Its client honours HTTP 429 and
`Retry-After` when supplied and uses bounded retry/backoff for retryable
transport or provider failures. Authentication, permission, missing-source,
and malformed-response errors are not retried as transient rate limits.

Retry exhaustion aborts the entire source read. Accumulated pages are discarded
and no complete snapshot is returned.

Official Planning Center rate-limit reference:

- <https://api.planningcenteronline.com/docs/overview/rate-limiting>

Household members fetched only to corroborate matching are context, not source
members. They must not become eligible or be imported unless their own stable
person ID is present in the source membership set.

Provider terminal-lifecycle handling remains a separate safety boundary. A
deleted, deceased, or otherwise terminal provider person is handled by the
existing provider lifecycle rules even if the upstream segment still exposes
that record. This is not a user-configurable local filter.

## HTTP API

Replace filter-builder endpoints with provider-source endpoints under the
existing admin-only, church-isolated people-sync provider router.

### Enumerate visible sources

```text
GET /api/integrations/people-sync/providers/:provider/sources
```

Response:

```json
{
  "success": true,
  "sources": [
    {
      "kind": "planning_center_list",
      "externalId": "42",
      "name": "Sunday Attendance",
      "memberCount": 243,
      "providerRefreshedAt": "2026-07-27T01:20:00Z"
    }
  ]
}
```

Elvanto may return Category and Group entries together; the client groups them
by `kind`.

### Save a draft source

```text
PUT /api/integrations/people-sync/providers/:provider/sync-batches/:id/source-draft
```

The request includes exactly `sourceKind` and `sourceExternalId`. The server
resolves the source against the connected provider, captures its current name,
and persists the draft against the active source revision. Client-supplied
names, counts, and timestamps are not trusted.

### Discard a draft source

```text
DELETE /api/integrations/people-sync/providers/:provider/sync-batches/:id/source-draft
```

An initial source draft cannot be discarded back into a runnable state. A batch
with no active source remains blocked until a source completes reviewed
promotion.

The existing reconciliation preview/apply endpoints carry the draft source
identity, source revision, complete source-snapshot identity, and review token.

## Source Selection Lifecycle

### New batch

1. The administrator selects exactly one visible provider source.
2. LMPG creates the batch with no active source and the selection as its draft
   source.
3. `initialSourceReviewPending` is true.
4. Unattended sync rejects the batch before run creation or provider fetch.
5. **Review & sync** fetches the complete draft source snapshot and computes the
   normal reconciliation plan.
6. Successful apply promotes the source, increments `source_revision`, clears
   the draft, and applies the reviewed people/link/family/gathering changes in
   the same church-database transaction.

### Existing batch source change

1. Selecting another source saves a draft without changing the active source.
2. The UI displays both active and pending source names.
3. While the draft exists, unattended sync is blocked. LMPG does not silently
   continue using the old source while user intent is unresolved.
4. Reviewed preview evaluates the draft source for that batch and active sources
   for other enabled batches.
5. Apply is guarded by church, provider, batch, active source revision, draft
   identity, complete snapshot identity, and review token.
6. A failed or stale apply leaves both the active source and LMPG data unchanged;
   the draft remains available.

### Established batch

Normal and scheduled sync use only the active source. Planning Center List age
does not block the run. The run/review record captures the List's
`providerRefreshedAt` and LMPG's `fetchedAt` for later inspection.

## Reconciliation Data Flow

For each batch participating in a reviewed or unattended run:

1. Load the church-scoped active source, or the target batch's draft source when
   explicitly reviewing that draft.
2. Resolve church-scoped credentials.
3. Fetch a complete source snapshot by stable source ID.
4. Build the eligible external-person-ID set directly from source membership,
   after existing provider terminal-lifecycle handling.
5. Normalize required person and household data.
6. Feed the normalized eligible people into the existing matcher and plan
   engine.
7. Compute the authoritative church population as the union of eligible IDs
   from all enabled batches for the authoritative provider.
8. Preserve existing overlap, gathering assignment, default people type,
   restore, update, archive, and family behavior.
9. Present the existing reviewed plan or follow established unattended policy.
10. Apply through the existing guarded church-database transaction.

Eligibility no longer calls `validateFilter`, `isEligible`, or a schema-version
evaluator. A person qualifies for a batch when their stable provider person ID
is in that batch's complete selected-source membership set and they pass the
non-configurable provider lifecycle boundary.

## Failure Semantics

### Source unavailable

If the selected source is deleted, archived or invalid where the provider
exposes such a state, inaccessible to the connected provider user, or returned
with the wrong resource type, the adapter throws a typed
`SYNC_SOURCE_UNAVAILABLE` error.

The run fails before planning or mutation. The source is not treated as empty,
no draft is promoted, and no person is archived because of the failure. LMPG
sets `source_status = 'missing'`, records `SYNC_SOURCE_UNAVAILABLE`, and skips
that scheduled reconciliation.

The first transition into `missing` for a particular active source creates one
system notification for every active administrator, identifying the batch and
last-known source name and directing them to select a replacement in Settings
→ Integrations. Repeated scheduled checks while it remains missing do not spam
duplicate notifications. Each later schedule still re-resolves the source so
restored permissions or a restored source can recover automatically. A
successful complete read changes the status to `available`; if the same source
goes missing again after recovery, that new transition may notify again.

These persisted transitions apply when the unavailable source is the active
source. If a draft source becomes unavailable during save or reviewed preview,
the draft remains pending and the UI shows the draft error, but the active
source's operational status is unchanged.

### Incomplete provider response

Any failed page, malformed pagination envelope, missing required relationship,
transport error, or authentication failure aborts the source fetch. Accumulated
partial items are discarded. No `ProviderSourceSnapshot` is produced. A
non-missing operational failure records `source_status = 'error'` and its typed
error code; it does not send the missing-source notification.

### Legitimately empty source

A provider source that is successfully resolved and completely fetched with
zero members is valid. It proceeds through normal review or unattended policy.
This is distinct from an unavailable or incomplete source.

### Rename

A successful read by stable ID updates the stored source-name snapshot. Rename
alone does not create a draft, increment the source revision, or change
eligibility. It sets the operational source status to `available`.

### Missing or old Planning Center refresh time

An absent or invalid `refreshed_at` produces neutral freshness text. An old
timestamp changes only presentation colour. Neither condition blocks manual or
scheduled sync.

### Concurrent change

If the active source revision or draft identity changes after preview, apply
returns the existing stale-review class of error. It does not promote or apply
the stale plan.

## Security and Isolation

- Every source endpoint requires an authenticated administrator and established
  church context.
- Batch queries always include `church_id` and provider.
- Credentials remain server-side and church-scoped.
- Source IDs supplied by the client are re-resolved through the church's own
  provider connection before persistence or use.
- Provider responses never allow one church's source metadata or people to
  enter another church's cache, response, batch, or review.
- Planning Center source code permits GET only. Tests fail if source enumeration
  or snapshot retrieval attempts a mutating HTTP method.
- Names are never used as durable identity or authorization boundaries.

## Removal Scope

Remove the unshipped local filtering system and all callers/tests whose only
purpose was that system:

- the shared Boolean `FilterBuilder` and batch filter controls;
- live filter preview/count/overlap components;
- filter metadata and explicit filter-snapshot HTTP routes;
- schema-version-2 validation and evaluation;
- filter-facts snapshot/cache and preview services;
- draft-filter repository and scheduling gates;
- version-1-to-version-2 conversion, proof, and upgrade UI/routes;
- provider-specific local eligibility evaluators after coordinated cutover; and
- dead documentation and plan sections describing the abandoned Boolean
  builder as future behavior.

Retain and adapt:

- provider connection and credential handling;
- normalized people and family projections;
- stable external-ID link repositories;
- matching and ambiguity review;
- reconciliation plan and digest;
- run repository and review tokens;
- source-of-truth union and overlap resolution;
- gathering assignment and default people type;
- transactional apply;
- scheduler and review notifications; and
- church isolation.

The old filter database columns remain unused for additive-schema compatibility
and rollback diagnosis. They must not influence eligibility after cutover.

## Coordinated Cutover

Only one known production church has one version-1 Planning Center sync batch.
The cutover is operationally coordinated rather than implemented as a legacy
runtime bridge.

1. Before deployment, help the church create a Planning Center List equivalent
   to its current batch criteria.
2. Deploy the source columns and source-based runtime.
3. Mark every pre-existing batch without an active source as
   `source selection required`; disable its unattended schedule.
4. Preserve its legacy filter columns for reference only.
5. The administrator selects the prepared List, creating an initial draft
   source.
6. Run a full reviewed reconciliation.
7. Successful apply promotes the source.
8. The administrator re-enables the schedule after reviewing the batch's normal
   scheduling controls.

There is no automatic mapping from the version-1 filter and no fallback to the
legacy evaluator. Until promotion, the migrated batch cannot run and cannot
affect the authoritative population.

## Testing Strategy

### Provider adapters

- Planning Center enumerates visible Lists with stable IDs, names, counts, and
  refresh timestamps.
- Planning Center paginates complete List membership and required household
  context.
- Planning Center source operations use GET only and never invoke List `run`.
- Planning Center follows every membership page at `per_page=100`, honours its
  dynamic rate headers and `Retry-After`, and stops after bounded retries.
- Required household reads use bounded concurrency and cannot create an
  unbounded N+1 request burst.
- Elvanto enumerates Categories and Groups with stable IDs.
- Elvanto fetches complete category and group membership.
- Elvanto source pagination is sequential and retry exhaustion discards every
  accumulated page.
- Household context outside the source never becomes eligible.
- Renames update display metadata without changing identity.
- Deleted, inaccessible, malformed, and partially fetched sources fail closed.
- A complete zero-member source succeeds.

### Repository and lifecycle

- Source-kind/provider combinations are strict.
- Draft source save is church- and provider-scoped.
- New batches cannot run before initial reviewed promotion.
- A pending source change blocks unattended sync.
- Draft discard cannot make an initial batch runnable.
- Promotion is atomic with apply and increments source revision.
- Concurrent source changes reject stale apply.
- Legacy filter columns do not affect source eligibility.

### Reconciliation and scheduling

- One source member qualifies for its batch without local filter evaluation.
- Cross-batch authoritative population is the union of current source members.
- Same-source and overlapping-source batches preserve existing resolution
  behavior.
- Removing a person from one source does not archive them while another enabled
  batch still contains them.
- Source unavailability never produces an archival plan.
- Missing sources persist a visible batch status, skip scheduled
  reconciliation, and notify active administrators only on the transition into
  missing.
- A later successful source read clears missing/error status and permits a
  future missing transition to notify again.
- Legitimately empty complete sources follow normal review/unattended policy.
- Scheduled sync proceeds for green, orange, red, and unknown Planning Center
  refresh ages.
- Run details record provider refresh and LMPG read timestamps.

### Client

- Planning Center shows exactly one List selector.
- Elvanto requires Category or Group plus exactly one source selection.
- Changing Elvanto source type clears the prior selection.
- Active and pending sources are shown distinctly.
- Freshness colours change at the exact 7-day and 30-day boundaries.
- Exact timestamps and non-colour text remain accessible.
- Missing refresh time renders neutral text.
- Planning Center displays the neutral helper text directing users to refresh
  missing recent members inside Planning Center.
- Source missing and transient source error states are distinguishable.
- Unavailable saved sources retain their last-known name and can be replaced by
  a newly selected source.
- Removed filter-builder and upgrade routes/components have no remaining callers.

### Cutover

- A pre-existing filter batch receives no active source and cannot run.
- Its unattended schedule is disabled.
- Selecting and reviewing a source promotes it normally.
- Re-enabling the schedule requires an explicit administrator action.
- No code path falls back to legacy eligibility.

## Acceptance Criteria

- Every runnable Planning Center batch has exactly one reviewed Planning Center
  List source.
- Every runnable Elvanto batch has exactly one reviewed Category or Group
  source.
- LMPG performs no Planning Center List writes or runs.
- Planning Center List age is visible but never blocks sync.
- Incomplete or unavailable sources fail closed without producing removals.
- A missing source is visible on the batch, skips scheduled reconciliation, and
  produces a deduplicated administrator notification.
- Large source snapshots paginate completely and respect provider rate-limit
  signals with bounded retries.
- Source changes cannot become active before reviewed atomic promotion.
- Stable provider person IDs, not names, determine persistent links.
- The local Boolean filter builder, evaluator, preview, facts cache, and upgrade
  workflow are absent from the runtime and UI.
- The coordinated version-1 batch cannot run until its provider source is
  selected and reviewed.
